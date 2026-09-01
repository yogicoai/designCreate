import { NextResponse } from 'next/server';
import { getDb, COLLECTIONS } from '@/lib/db';
import { searchImages, naverConfigured, NaverError } from '@/lib/naver';

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

    return NextResponse.json({
      ok: true,
      configured: naverConfigured(),
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
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { q?: string; display?: number; start?: number; sort?: 'sim' | 'date' };
    const q = String(body.q || '').trim();
    if (!q) return NextResponse.json({ ok: false, error: '검색어가 필요합니다.' }, { status: 400 });

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
    };
    const items = body.items ?? [];
    if (!items.length) return NextResponse.json({ ok: false, error: '담을 항목이 없습니다.' }, { status: 400 });
    const month = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month! : new Date().toISOString().slice(0, 7);

    const db = await getDb();
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
    const { id } = (await req.json()) as { id?: string };
    if (!id) return NextResponse.json({ ok: false, error: 'id 가 필요합니다.' }, { status: 400 });
    const { ObjectId } = await import('mongodb');
    const db = await getDb();
    await db.collection(COLLECTIONS.trendImages).deleteOne({ _id: new ObjectId(id) as never });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
