import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { toDropboxAsset } from '@/lib/queries';

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
 * DELETE { url }         숨김 — 파일도 DB 도 지우지 않는다
 *
 * 삭제가 없는 이유: 원본이 드롭박스에 그대로 있고 sourcePath 로 언제든 되돌아갈 수 있어서,
 * 지우는 것보다 숨기는 쪽이 항상 안전하다. FTP 파일도 건드리지 않는다.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COL = 'dropbox_assets';

/** 화면의 필터 칩 → Mongo 조건. 세 축(폴더·검수상태·라벨유무)은 서로 겹칠 수 있다 */
function buildQuery(sp: URLSearchParams): Record<string, unknown> {
  const q: Record<string, unknown> = { active: { $ne: false } };
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
    q.$or = [{ title: { $regex: safe, $options: 'i' } }, { sourcePath: { $regex: safe, $options: 'i' } }];
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
        .project({ url: 1, title: 1, width: 1, height: 1, sub: 1, folderHint: 1, filenameHint: 1, labelStatus: 1, sourcePath: 1, sourceName: 1, createdAt: 1 })
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
      const { getDropboxSummary } = await import('@/lib/queries');
      body.summary = await getDropboxSummary();
    }

    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=120' },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as { url?: string; urls?: string[]; sub?: string | null; title?: string };
    // 검수는 여러 장을 한 번에 같은 라벨로 찍는 일이 대부분이라 urls 배열도 받는다
    const urls = Array.isArray(body.urls) ? body.urls.filter(Boolean).map(String) : [];
    const one = String(body.url ?? '').trim();
    const targets = urls.length ? urls : one ? [one] : [];
    if (!targets.length) return NextResponse.json({ ok: false, error: 'url 이 필요합니다.' }, { status: 400 });

    const set: Record<string, unknown> = {};
    if (body.sub !== undefined) set.sub = body.sub ? String(body.sub).slice(0, 40) : null;
    if (body.title !== undefined) set.title = String(body.title ?? '').slice(0, 160);
    if (!Object.keys(set).length) return NextResponse.json({ ok: false, error: '변경할 값이 없습니다.' }, { status: 400 });
    set.updatedAt = new Date();

    const db = await getDb();
    const r = await db.collection(COL).updateMany({ url: { $in: targets } }, { $set: set });
    return NextResponse.json({ ok: true, matched: r.matchedCount, modified: r.modifiedCount });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = (await req.json()) as { url?: string; urls?: string[]; restore?: boolean };
    const urls = Array.isArray(body.urls) ? body.urls.filter(Boolean).map(String) : [];
    const one = String(body.url ?? '').trim();
    const targets = urls.length ? urls : one ? [one] : [];
    if (!targets.length) return NextResponse.json({ ok: false, error: 'url 이 필요합니다.' }, { status: 400 });
    const db = await getDb();
    // 숨김만 한다. 원본이 드롭박스에 그대로 있으므로 지울 이유가 없다
    await db.collection(COL).updateMany(
      { url: { $in: targets } },
      { $set: { active: body.restore === true, updatedAt: new Date() } },
    );
    return NextResponse.json({ ok: true, mode: body.restore ? 'restored' : 'hidden', count: targets.length });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
