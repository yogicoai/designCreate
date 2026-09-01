import { NextResponse } from 'next/server';
import { getDb, COLLECTIONS } from '@/lib/db';
import { searchImages, searchPosts, naverConfigured, NaverError, BEANBAG_BRANDS } from '@/lib/naver';
import { SEASONS, harvestPhrases, buildSuggestions } from '@/lib/copy-ideas';

/**
 * 시즌 트렌드 참고 보드.
 *
 * 설계 원칙 — **원본 이미지를 우리 서버에 보관하지 않는다.**
 *   목적은 "이런 디자인이 유행했구나" 를 보는 것이지 이미지를 쓰는 게 아니다.
 *   원본을 cafe24 에 올리면 우리 도메인에서 남의 이미지를 서빙하게 되고,
 *   생성 레퍼런스로 잘못 들어갈 위험도 생긴다.
 *   그래서 저해상도 썸네일만 DB 에 담고, 원본은 출처 링크로만 남긴다.
 *   (썸네일 한 장 20KB 안팎 — 1,000장을 모아도 20MB)
 *
 * GET    ?month=YYYY-MM        저장된 보드 (미지정이면 전체 월 목록 + 최근분)
 * POST   { q, display }        네이버 이미지 검색 (저장하지 않음, 결과만 돌려준다)
 * PUT    { items[], month, keyword }  고른 것만 썸네일을 받아 보드에 담는다
 * DELETE { id }                보드에서 제거
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 썸네일 1장 상한 — 이보다 크면 참고용 썸네일이 아니라 원본에 가깝다 */
const MAX_THUMB_BYTES = 400_000;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const month = url.searchParams.get('month') || '';
    const db = await getDb();
    const col = db.collection(COLLECTIONS.trendImages);

    // 월 목록 — 화면 상단 탭에 쓴다
    const months = (await col.distinct('month')).filter(Boolean).sort().reverse() as string[];
    const q = month ? { month } : {};
    const docs = await col.find(q).sort({ collectedAt: -1 }).limit(600).toArray();

    // 경쟁사 프로모션 기록 — 이미지와 성격이 달라 컬렉션을 나눴다
    const promoCol = db.collection(COLLECTIONS.trendPromos);
    const promos = await promoCol.find(q).sort({ date: -1, collectedAt: -1 }).limit(400).toArray();

    return NextResponse.json({
      ok: true,
      configured: naverConfigured(),
      // 추적 업체 — 화면이 검색 없이 바로 이미지를 띄우는 데 쓴다
      brands: BEANBAG_BRANDS,
      months,
      items: docs.map((d) => ({
        id: String(d._id),
        thumb: d.thumb,
        sourceUrl: d.sourceUrl,
        title: d.title ?? '',
        keyword: d.keyword ?? '',
        month: d.month ?? '',
        width: d.width ?? 0,
        height: d.height ?? 0,
        collectedAt: d.collectedAt ? new Date(d.collectedAt).toISOString() : null,
      })),
      promos: promos.map((d) => ({
        id: String(d._id),
        title: d.title, link: d.link, desc: d.desc ?? '',
        date: d.date ?? '', source: d.source ?? '', kind: d.kind ?? 'blog',
        keyword: d.keyword ?? '', month: d.month ?? '',
        // 업체별 정리에 쓰이는 값들 — 빠뜨리면 화면에서 (미상)/undefined% 로 보인다
        brand: d.brand ?? '', discount: d.discount ?? 0, price: d.price ?? 0,
        copy: d.copy ?? [], isOurs: !!d.isOurs,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      q?: string; display?: number; start?: number; sort?: 'sim' | 'date';
      kind?: 'image' | 'promo' | 'brandimg' | 'copy';
      brands?: string[];
      month?: number;
    };
    /*
     * 이달의 문구 추천.
     *   시즌 캘린더가 뼈대를 잡고, 실제 수집이 지금 시장의 온도를 채운다.
     *   추천 문구는 그대로 쓰는 카피이기도 하지만, **이미지 검색의 씨앗**으로 쓸 때 더 쓸모 있다.
     *   "추석 이벤트" 로 검색하면 그 시즌의 비주얼 톤이 한눈에 들어온다.
     */
    if (body.kind === 'copy') {
      const month = Math.min(12, Math.max(1, Number(body.month) || new Date().getMonth() + 1));
      const season = SEASONS[month];
      const titles: string[] = [];
      // 시즌 키워드로 실제 글 제목을 모아 유행 표현을 뽑는다
      for (const kw of season.keywords) {
        try {
          const posts = await searchPosts(kw, { display: 40 });
          titles.push(...posts.map((x) => `${x.title} ${x.desc}`));
        } catch { /* 한 키워드가 실패해도 나머지로 진행한다 */ }
      }
      const harvested = harvestPhrases(titles);

      // 경쟁사 실측 할인율의 중앙값 — 추천 문구의 숫자 자리에 넣는다
      const db2 = await getDb();
      const ds = (await db2.collection(COLLECTIONS.trendPromos).find({ discount: { $gt: 0 } })
        .project({ discount: 1 }).toArray()).map((d) => d.discount as number).sort((a, b) => a - b);
      const median = ds.length ? ds[Math.floor(ds.length / 2)] : 0;

      return NextResponse.json({
        ok: true,
        month,
        season: { label: season.label, angle: season.angle, keywords: season.keywords },
        suggestions: buildSuggestions(month, median),
        harvested,
        median,
        sampled: titles.length,
      });
    }

    /*
     * 업체별 대표 이미지.
     * 블로그·카페 검색은 이미지를 주지 않는다. "이 업체가 어떤 비주얼을 쓰나" 는
     * 업체명으로 이미지 검색을 한 번 더 돌려야 나온다. 저장하지 않고 보여주기만 한다.
     *
     * 검색어(q) 검증보다 **앞**에 둔다 — 이 분기는 brands 만 쓰고 q 를 쓰지 않는다.
     * 뒤에 뒀다가 400 "검색어가 필요합니다" 로 막혀 이미지가 아예 안 떴다.
     */
    if (body.kind === 'brandimg') {
      const brands = (body.brands ?? []).slice(0, 8);
      const out: Record<string, { link: string; thumbnail: string; title: string; sizeWidth: number; sizeHeight: number }[]> = {};
      await Promise.all(
        brands.map(async (b) => {
          try {
            // 이 화면의 주인공은 이미지다 — 넉넉히 가져온다
            const imgs = await searchImages(`${b} 빈백`, { display: 18, sort: 'sim' });
            out[b] = imgs.map((x) => ({
              link: x.link, thumbnail: x.thumbnail, title: x.title,
              sizeWidth: x.sizeWidth, sizeHeight: x.sizeHeight,
            }));
          } catch {
            out[b] = [];
          }
        }),
      );
      return NextResponse.json({ ok: true, brandImages: out });
    }

    const q = String(body.q || '').trim();
    if (!q) return NextResponse.json({ ok: false, error: '검색어가 필요합니다.' }, { status: 400 });

    // 프로모션 검색 — 블로그·카페 글. 이벤트 페이지는 끝나면 사라지지만 후기는 남는다.
    if (body.kind === 'promo') {
      const posts = await searchPosts(q, { display: body.display ?? 30 });
      const db0 = await getDb();
      const seen = new Set(
        (await db0.collection(COLLECTIONS.trendPromos).find({ link: { $in: posts.map((x) => x.link) } })
          .project({ link: 1 }).toArray()).map((d) => d.link as string),
      );
      return NextResponse.json({ ok: true, posts: posts.map((x) => ({ ...x, saved: seen.has(x.link) })) });
    }

    const items = await searchImages(q, {
      display: body.display ?? 40,
      start: body.start ?? 1,
      sort: body.sort ?? 'sim',
    });
    // 이미 보드에 있는 것은 화면에서 '담김' 으로 표시한다
    const db = await getDb();
    const have = new Set(
      (await db.collection(COLLECTIONS.trendImages).find({ sourceUrl: { $in: items.map((x) => x.link) } })
        .project({ sourceUrl: 1 }).toArray()).map((d) => d.sourceUrl as string),
    );
    return NextResponse.json({ ok: true, items: items.map((x) => ({ ...x, saved: have.has(x.link) })) });
  } catch (e) {
    const err = e as NaverError;
    return NextResponse.json({ ok: false, error: err.message }, { status: err.status ?? 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as {
      month?: string;
      keyword?: string;
      items?: { link: string; thumbnail: string; title?: string; sizeWidth?: number; sizeHeight?: number }[];
      posts?: Record<string, unknown>[] & { link?: string; date?: string }[];
    };
    const items = body.items ?? [];
    const posts = body.posts ?? [];
    if (!items.length && !posts.length) {
      return NextResponse.json({ ok: false, error: '담을 항목이 없습니다.' }, { status: 400 });
    }
    const month = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month! : new Date().toISOString().slice(0, 7);

    const db = await getDb();

    // 프로모션 기록 — 텍스트만 저장한다. 이미지가 아니라 "언제 누가 얼마에 뭘 했나" 가 자산이다.
    if (posts.length) {
      const pc = db.collection(COLLECTIONS.trendPromos);
      let n = 0;
      for (const x of posts) {
        // 게시일이 있으면 그 달로 묶는다 — 수집한 달이 아니라 실제 진행 시점이 중요하다
        const m = /^\d{4}-\d{2}/.test(x.date || '') ? x.date!.slice(0, 7) : month;
        await pc.updateOne(
          { link: x.link },
          { $set: { ...x, month: m, keyword: String(body.keyword || '').slice(0, 100), collectedAt: new Date() } },
          { upsert: true },
        );
        n++;
      }
      return NextResponse.json({ ok: true, saved: n, failed: 0, month });
    }
    const col = db.collection(COLLECTIONS.trendImages);
    let saved = 0;
    const failed: string[] = [];

    for (const it of items) {
      try {
        // 썸네일만 받는다 — 원본(it.link)은 절대 받지 않는다
        const res = await fetch(it.thumbnail, { cache: 'no-store' });
        if (!res.ok) { failed.push(it.link); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_THUMB_BYTES) { failed.push(it.link); continue; }
        const mime = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';

        await col.updateOne(
          { sourceUrl: it.link },
          {
            $set: {
              sourceUrl: it.link,           // 출처 — 어디서 왔는지 항상 추적 가능해야 한다
              thumb: `data:${mime};base64,${buf.toString('base64')}`,
              title: String(it.title || '').slice(0, 200),
              keyword: String(body.keyword || '').slice(0, 100),
              month,
              width: it.sizeWidth ?? 0,
              height: it.sizeHeight ?? 0,
              collectedAt: new Date(),
            },
          },
          { upsert: true },
        );
        saved++;
      } catch {
        failed.push(it.link);
      }
    }
    return NextResponse.json({ ok: true, saved, failed: failed.length, month });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { id, kind } = (await req.json()) as { id?: string; kind?: 'image' | 'promo' };
    if (!id) return NextResponse.json({ ok: false, error: 'id 가 필요합니다.' }, { status: 400 });
    const { ObjectId } = await import('mongodb');
    const db = await getDb();
    const target = kind === 'promo' ? COLLECTIONS.trendPromos : COLLECTIONS.trendImages;
    await db.collection(target).deleteOne({ _id: new ObjectId(id) as never });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
