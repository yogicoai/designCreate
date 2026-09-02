import { NextResponse } from 'next/server';
import { getDb, COLLECTIONS } from '@/lib/db';
import { searchImages, searchPosts, naverConfigured, NaverError, BEANBAG_BRANDS, OUR_BRAND } from '@/lib/naver';
import { fetchMallBanners, fetchWaybackMonths } from '@/lib/mall-scrape';
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

    // 웨이백 과거 메인 링크 — 월 필터와 무관하게 전부 준다 (몇 개 안 된다)
    const archives = await db.collection(COLLECTIONS.trendArchives)
      .find({}).sort({ month: -1 }).limit(80).toArray();

    return NextResponse.json({
      ok: true,
      configured: naverConfigured(),
      // 추적 업체 — 화면이 검색 없이 바로 이미지를 띄우는 데 쓴다
      brands: BEANBAG_BRANDS,
      months,
      archives: archives.map((d) => ({
        brand: d.brand ?? '', month: d.month ?? '', waybackUrl: d.waybackUrl ?? '',
      })),
      items: docs.map((d) => ({
        id: String(d._id),
        thumb: d.thumb,
        sourceUrl: d.sourceUrl,
        title: d.title ?? '',
        keyword: d.keyword ?? '',
        brand: d.brand ?? '',
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
      kind?: 'image' | 'promo' | 'brandimg' | 'copy' | 'snapshot';
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
      /*
       * 표본을 **그 달에 실제로 올라온 글**로 좁힌다.
       *
       * 네이버 검색 API 에는 기간 필터가 없어서 최신순으로 받은 뒤 게시일로 거른다.
       * 이걸 안 하면 11월을 눌러도 '지금' 글이 잡혀서 "11월에 많이 쓴 문구"가 아니라
       * "지금 많이 쓰는 문구"가 나온다 — 화면이 말하는 것과 데이터가 어긋난다.
       *
       * 연도는 묶는다. 작년·재작년 9월도 같은 9월이고, 시즌 문구는 해마다 반복되기 때문이다.
       * 표본이 너무 적으면(10건 미만) 월 필터를 풀고 전체로 센다 — 빈 화면보다는 낫다.
       */
      const mm = String(month).padStart(2, '0');
      const all: { text: string; date: string }[] = [];
      for (const kw of season.keywords) {
        try {
          const posts = await searchPosts(kw, { display: 60 });
          all.push(...posts.map((x) => ({ text: `${x.title} ${x.desc}`, date: x.date })));
        } catch { /* 한 키워드가 실패해도 나머지로 진행한다 */ }
      }
      const inMonth = all.filter((x) => x.date && x.date.slice(5, 7) === mm);
      const usedMonthFilter = inMonth.length >= 10;
      const pool = usedMonthFilter ? inMonth : all;
      const titles = pool.map((x) => x.text);
      const harvested = harvestPhrases(titles);
      const years = [...new Set(pool.map((x) => x.date?.slice(0, 4)).filter(Boolean))].sort();

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
        /** 그 달로 실제 걸렀는지 — 화면이 기준을 정확히 말할 수 있어야 한다 */
        monthFiltered: usedMonthFilter,
        years,
        totalFetched: all.length,
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
    /*
     * 이달의 스냅샷 수집 — 이 화면의 자료가 쌓이는 유일한 자동 경로.
     *
     * 네이버 이미지 검색에는 게시일이 없어서 "작년 배너"를 소급해 긁어올 수는
     * 없다 (지난 이벤트 페이지는 대부분 내려가 있다). 대신 매달 이 버튼이
     * 그 시점의 경쟁사 비주얼을 박제하면, 몇 달 뒤부터 "그때 걔네가 뭘 걸었나"
     * 를 우리 보드에서 비교할 수 있다. 글(블로그·카페)은 게시일이 있어서
     * 작년 것까지 진짜 시점으로 남는다.
     *
     * 검색어는 실측으로 골랐다: '{업체} 빈백/빈백 이벤트/빈백 할인' 은 이벤트
     * 비주얼이 잡히고, '기획전'·'이벤트 배너' 는 남의 업종이 섞여서 뺐다.
     */
    if (body.kind === 'snapshot') {
      const month = new Date().toISOString().slice(0, 7);
      const db = await getDb();
      const ic = db.collection(COLLECTIONS.trendImages);
      const pc = db.collection(COLLECTIONS.trendPromos);
      const queriesFor = (b: string) => [`${b} 빈백`, `${b} 빈백 이벤트`, `${b} 빈백 할인`];

      let imgNew = 0;
      let imgSeen = 0;
      let promoNew = 0;
      let mallNew = 0;

      /*
       * 자사몰 메인 배너 직접 수집 — 이 스냅샷의 진짜 알맹이.
       * 네이버 이미지 검색은 상품 썸네일 위주지만, 자사몰 메인에는 진행 중인
       * 프로모션 배너가 그대로 걸려 있다. keyword 를 '자사몰 메인' 으로 박아
       * 보드에서 출처가 구분되게 한다.
       */
      try {
        for (const b of await fetchMallBanners()) {
          const r = await ic.updateOne(
            { sourceUrl: b.url },
            {
              $set: { thumb: b.url, title: `자사몰 메인 · ${b.brand}`, brand: b.brand, keyword: '자사몰 메인', width: 0, height: 0 },
              $setOnInsert: { sourceUrl: b.url, month, collectedAt: new Date() },
            },
            { upsert: true },
          );
          if (r.upsertedCount) { mallNew++; imgNew++; }
        }
      } catch { /* 몰이 막혀도 검색 수집은 계속 */ }

      // 웨이백 과거 메인 링크 — "그때 걔네 메인" 을 소급해서 볼 유일한 길
      try {
        const ac = db.collection(COLLECTIONS.trendArchives);
        for (const w of await fetchWaybackMonths()) {
          await ac.updateOne(
            { waybackUrl: w.waybackUrl },
            { $set: { brand: w.brand, month: w.month, page: w.page }, $setOnInsert: { waybackUrl: w.waybackUrl, collectedAt: new Date() } },
            { upsert: true },
          );
        }
      } catch { /* 웨이백이 느려도 스냅샷 본체는 산다 */ }
      for (const b of BEANBAG_BRANDS) {
        const links = new Set<string>();
        for (const q of queriesFor(b)) {
          let imgs: Awaited<ReturnType<typeof searchImages>> = [];
          try { imgs = await searchImages(q, { display: 20, sort: 'sim' }); } catch { /* 검색어 하나 실패는 넘어간다 */ }
          for (const x of imgs) {
            if (!x.link || links.has(x.link)) continue;
            links.add(x.link);
            imgSeen++;
            const r = await ic.updateOne(
              { sourceUrl: x.link },
              {
                $set: { thumb: x.thumbnail, title: x.title, width: x.sizeWidth, height: x.sizeHeight, brand: b, keyword: q },
                // month 는 처음 담긴 달을 지킨다 — 다시 수집해도 "처음 본 시점"이 남아야 한다
                $setOnInsert: { sourceUrl: x.link, month, collectedAt: new Date() },
              },
              { upsert: true },
            );
            if (r.upsertedCount) imgNew++;
          }
        }
        try {
          const posts = await searchPosts(`${b} 빈백`, { display: 100 });
          for (const x of posts) {
            const m = /^\d{4}-\d{2}/.test(x.date || '') ? x.date.slice(0, 7) : month;
            const r = await pc.updateOne(
              { link: x.link },
              {
                $set: {
                  title: x.title, desc: x.desc, date: x.date, source: x.source, kind: x.kind,
                  brand: x.brand || b, discount: x.discount, price: x.price, copy: x.copy,
                  isOurs: x.isOurs, keyword: `${b} 빈백`, month: m,
                },
                $setOnInsert: { link: x.link, collectedAt: new Date() },
              },
              { upsert: true },
            );
            if (r.upsertedCount) promoNew++;
          }
        } catch { /* 글 수집 실패도 이미지는 살린다 */ }
      }

      // 옛 데이터 정리 — 추출기가 허술하던 시절의 엉터리 브랜드('위한' 등)를 비운다
      const cleaned = await pc.updateMany(
        { brand: { $nin: ['', OUR_BRAND, ...BEANBAG_BRANDS] } },
        { $set: { brand: '' } },
      );

      return NextResponse.json({
        ok: true, month,
        images: { new: imgNew, seen: imgSeen, mall: mallNew },
        promos: { new: promoNew },
        cleaned: cleaned.modifiedCount,
      });
    }

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
