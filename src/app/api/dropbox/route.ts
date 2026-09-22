import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { toDropboxAsset, dropboxSectionMatch, type DropboxSection } from '@/lib/queries';
import { UNSORTED, isProductLabel } from '@/lib/dropbox-products';

/** ?section=brand 면 브랜드 정리, 그 외에는 제품사진 */
function sectionOf(sp: URLSearchParams): DropboxSection {
  return sp.get('section') === 'brand' ? 'brand' : 'product';
}

/**
 * 드롭박스 파일 보관함 (`dropbox_assets`).
 *
 * 팀 드롭박스 `1. 디자인/2.7 제품사진` 에서 복사해 온 제품사진. 원본은 읽기만 한다 —
 * 이 라우트에도, 수집 스크립트에도 드롭박스에 쓰는 코드 경로가 없다.
 *
 * 레퍼런스(`references`)와 왜 분리했나 (사용자 결정 2026-09-21):
 *   레퍼런스가 이미 4,600장인데 드롭박스에는 9,565장이 있다. 섞으면 기존 작업이 묻힌다.
 *
 * GET    ?skip=&limit=&folder=&status=&labeled=&q=   목록 (+ summary=1 이면 폴더별 집계)
 * PATCH  { url, sub }    제품 라벨 확정 (검수 결과)
 *        { url, title }  이름 변경
 * DELETE { urls }              숨김 — 파일도 DB 도 지우지 않는다 (restore:true 면 되살림)
 *        { urls, purge:true }  삭제 — cafe24 의 웹 사본 파일을 지우고 목록에서 영구히 뺀다
 *
 * 삭제 (사용자 요청 2026-09-22: "필요 없는 건 삭제도 하게"):
 *   지우는 것은 **이 앱이 만든 웹 사본(2000px JPG)** 뿐이다. 드롭박스 원본은 여기서 닿지도 않고
 *   (원본은 읽기 전용 — 사용자의 절대 조건), 원하면 수집 스크립트로 다시 가져올 수 있다.
 *   DB 문서는 지우지 않고 deleted 표시만 남긴다 — sourcePath 가 남아 있어야 다음 수집 때
 *   「이미 등록」 으로 건너뛰어서 지운 사진이 되살아나지 않는다.
 *   생성 컷이 참조로 쓴 사진은 파일을 지우면 그 컷의 참조가 깨지므로 숨김만 한다.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const COL = 'dropbox_assets';
/** 한 번에 지울 수 있는 장수 — 화면의 한 쪽(최대 54장)이면 충분하고, FTP 가 60초 안에 끝나야 한다 */
const PURGE_MAX = 300;
/** 수집 스크립트가 만드는 웹 사본 경로 모양. 이 모양이 아니면 절대 지우지 않는다 */
const SAFE_REL = /^(product|brand)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.jpg$/;

/**
 * 화면의 필터 칩 → Mongo 조건. 축(폴더·검수상태·라벨유무·제품)은 서로 겹칠 수 있다.
 * withProduct=false 는 제품 칩의 숫자를 셀 때 — 칩 숫자가 자기 자신으로 걸러지면 안 된다.
 */
function buildQuery(sp: URLSearchParams, withProduct = true): Record<string, unknown> {
  const q: Record<string, unknown> = { active: { $ne: false }, ...dropboxSectionMatch(sectionOf(sp)) };
  const product = sp.get('product');
  if (withProduct && product) {
    // 「미분류」 = 라벨이 아직 없는 것. 검색의 $or 와 겹치지 않게 $and 로 싼다
    q.$and = [product === UNSORTED
      ? { $or: [{ products: { $exists: false } }, { products: { $size: 0 } }] }
      : { products: product }];
  }
  const folder = sp.get('folder');
  const status = sp.get('status');
  const labeled = sp.get('labeled');
  const text = (sp.get('q') ?? '').trim();
  if (folder) q.folderHint = folder;
  if (status) q.labelStatus = status;
  if (labeled === 'yes') q.sub = { $nin: [null, ''] };
  if (labeled === 'no') q.sub = { $in: [null, ''] };
  if (text) {
    // 파일명·원본경로로 찾는다. 정규식 특수문자가 들어와도 터지지 않게 이스케이프한다
    const safe = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /*
     * 브랜드 정리는 제목·캠페인으로만 찾는다 — 원본 경로까지 보면 드롭박스에서 다른 캠페인 폴더
     * 안에 들어 있는 것이 딸려 나온다 (실측: 「09월 (chic vibes)」가 「스페셜에디션(스타워즈)」 안에 있어서
     * 「스타워즈」 검색에 9월 6장이 섞였다). 제품사진은 원본 파일명·경로 검색이 쓸모 있어서 그대로 둔다.
     */
    q.$or = sectionOf(sp) === 'brand'
      ? [{ title: { $regex: safe, $options: 'i' } }, { campaign: { $regex: safe, $options: 'i' } }]
      : [{ title: { $regex: safe, $options: 'i' } }, { sourcePath: { $regex: safe, $options: 'i' } }];
  }
  return q;
}

export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const skip = Math.max(0, Number(sp.get('skip') ?? 0) || 0);
    const limit = Math.max(1, Math.min(2000, Number(sp.get('limit') ?? 300) || 300));
    const db = await getDb();
    const col = db.collection(COL);
    const q = buildQuery(sp);

    const [docs, total] = await Promise.all([
      col.find(q)
        .project({ section: 1, group: 1, url: 1, title: 1, width: 1, height: 1, sub: 1, folderHint: 1, filenameHint: 1, labelStatus: 1, sourcePath: 1, sourceName: 1, createdAt: 1, products: 1, productsSource: 1, 'ai.confidence': 1 })
        // 폴더 안에서 원본 순서대로 — 검수할 때 같은 촬영분이 붙어 있어야 판단이 빠르다
        .sort({ folderHint: 1, sourcePath: 1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      col.countDocuments(q),
    ]);

    const body: Record<string, unknown> = {
      ok: true,
      total,
      skip,
      assets: docs.map((d) => toDropboxAsset(d as Record<string, unknown>)),
    };

    // 필터 칩의 개수 — 목록과 같이 받으면 화면이 한 번에 그려진다
    if (sp.get('summary') === '1') {
      const { getDropboxSummary, getDropboxProductCounts } = await import('@/lib/queries');
      body.summary = await getDropboxSummary(sectionOf(sp));
      // 제품 칩 — 지금 고른 폴더·검색 안에서 센다(제품 조건은 빼고)
      body.productCounts = await getDropboxProductCounts(buildQuery(sp, false));
    }

    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=120' },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

/** 구간 라벨 한 번에 바꿀 수 있는 최대 장수 — 한 폴더(최대 2,400장)는 통째로 되게 */
const RANGE_MAX = 3000;

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as {
      url?: string; urls?: string[]; sub?: string | null; title?: string;
      /** 제품 라벨(여러 개) — 정리 모드. 빈 배열이면 미분류로 되돌린다 */
      products?: string[];
      /** 구간 — 정리 모드에서 Shift 로 고른 첫 장~마지막 장. 쪽이 달라도 된다 */
      range?: { from: string; to: string };
      /** 구간을 셀 때 쓰는 화면 조건(폴더·검색·제품) — 화면에 보이는 순서와 같아야 사이를 맞게 찾는다 */
      filter?: Record<string, string>;
    };
    const db = await getDb();
    const col = db.collection(COL);

    // 대상: 구간이면 화면과 같은 조건·순서로 목록을 받아 첫 장~마지막 장 사이를 고른다
    let targets: string[] = [];
    if (body.range?.from && body.range?.to) {
      const sp = new URLSearchParams(Object.entries(body.filter ?? {}).filter(([, v]) => v).map(([k, v]) => [k, String(v)]));
      const ordered = (await col.find(buildQuery(sp)).project({ url: 1 }).sort({ folderHint: 1, sourcePath: 1 }).toArray())
        .map((d) => String(d.url));
      const a = ordered.indexOf(body.range.from);
      const b = ordered.indexOf(body.range.to);
      if (a < 0 || b < 0) return NextResponse.json({ ok: false, error: '구간의 첫 장이나 마지막 장을 지금 목록에서 찾지 못했습니다. 필터를 바꿨다면 다시 골라 주세요.' }, { status: 400 });
      targets = ordered.slice(Math.min(a, b), Math.max(a, b) + 1);
      if (targets.length > RANGE_MAX) return NextResponse.json({ ok: false, error: `구간이 너무 깁니다(${targets.length}장). ${RANGE_MAX}장 이하로 나눠 주세요.` }, { status: 400 });
    } else {
      // 검수는 여러 장을 한 번에 같은 라벨로 찍는 일이 대부분이라 urls 배열도 받는다
      const urls = Array.isArray(body.urls) ? body.urls.filter(Boolean).map(String) : [];
      const one = String(body.url ?? '').trim();
      targets = urls.length ? urls : one ? [one] : [];
    }
    if (!targets.length) return NextResponse.json({ ok: false, error: 'url 이 필요합니다.' }, { status: 400 });

    const set: Record<string, unknown> = {};
    if (body.sub !== undefined) set.sub = body.sub ? String(body.sub).slice(0, 40) : null;
    if (body.title !== undefined) set.title = String(body.title ?? '').slice(0, 160);
    if (body.products !== undefined) {
      const list = Array.isArray(body.products) ? [...new Set(body.products.filter(isProductLabel))] : [];
      // 「제품 없음」 은 다른 제품과 같이 붙을 수 없다
      set.products = list.includes('제품 없음') ? ['제품 없음'] : list;
      set.productsSource = 'human';
      set.productsAt = new Date();
    }
    if (!Object.keys(set).length) return NextResponse.json({ ok: false, error: '변경할 값이 없습니다.' }, { status: 400 });
    set.updatedAt = new Date();

    const r = await col.updateMany({ url: { $in: targets } }, { $set: set });
    return NextResponse.json({ ok: true, matched: r.matchedCount, modified: r.modifiedCount, count: targets.length });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = (await req.json()) as { url?: string; urls?: string[]; restore?: boolean; purge?: boolean };
    const urls = Array.isArray(body.urls) ? body.urls.filter(Boolean).map(String) : [];
    const one = String(body.url ?? '').trim();
    const targets = urls.length ? urls : one ? [one] : [];
    if (!targets.length) return NextResponse.json({ ok: false, error: 'url 이 필요합니다.' }, { status: 400 });
    const db = await getDb();

    if (body.purge === true) {
      if (targets.length > PURGE_MAX) {
        return NextResponse.json({ ok: false, error: `한 번에 ${PURGE_MAX}장까지 지울 수 있습니다.` }, { status: 400 });
      }
      const base = (process.env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');
      const docs = await db.collection(COL)
        .find({ url: { $in: targets }, deleted: { $ne: true } })
        .project({ url: 1 })
        .toArray();
      // 생성 컷이 참조로 쓴 사진 — 파일을 지우면 그 컷의 참조가 깨진다
      const usedUrls = new Set(
        (await db.collection('cuts')
          .find({ $or: [{ 'inputImages.url': { $in: targets } }, { 'inputImages.originalUrl': { $in: targets } }] })
          .project({ inputImages: 1 })
          .toArray())
          .flatMap((c) => ((c.inputImages ?? []) as { url?: string; originalUrl?: string }[]).flatMap((i) => [i.url, i.originalUrl]))
          .filter((u): u is string => !!u),
      );
      const relOf = (url: string) => (url.startsWith(`${base}/`) ? url.slice(base.length + 1) : '');
      const purgeable = docs.filter((d) => !usedUrls.has(d.url) && SAFE_REL.test(relOf(d.url)));
      const keep = docs.filter((d) => !purgeable.includes(d));

      const { deleteRemoteFiles } = await import('@/lib/ftp');
      const { removed, failed } = await deleteRemoteFiles(purgeable.map((d) => relOf(d.url)));
      const removedUrls = removed.map((rel) => `${base}/${rel}`);
      const now = new Date();
      if (removedUrls.length) {
        await db.collection(COL).updateMany(
          { url: { $in: removedUrls } },
          { $set: { active: false, deleted: true, deletedAt: now, updatedAt: now } },
        );
      }
      // 지우지 못한 것(사용 중·경로 이상·FTP 실패)은 숨김만 — 목록에서는 빠지고 파일은 남는다
      const hideOnly = [...keep.map((d) => d.url as string), ...failed.map((rel) => `${base}/${rel}`)];
      if (hideOnly.length) {
        await db.collection(COL).updateMany({ url: { $in: hideOnly } }, { $set: { active: false, updatedAt: now } });
      }
      return NextResponse.json({
        ok: true,
        mode: 'deleted',
        deleted: removedUrls.length,
        keptInUse: keep.filter((d) => usedUrls.has(d.url)).length,
        failed: failed.length,
      });
    }

    // 숨김 — 파일도 DB 도 그대로 두고 목록에서만 뺀다
    await db.collection(COL).updateMany(
      { url: { $in: targets } },
      { $set: { active: body.restore === true, updatedAt: new Date() } },
    );
    return NextResponse.json({ ok: true, mode: body.restore ? 'restored' : 'hidden', count: targets.length });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
