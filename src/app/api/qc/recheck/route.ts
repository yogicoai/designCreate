import { NextResponse } from 'next/server';
import { LOCAL_ONLY } from '@/lib/local-only';
import { recheckFaces } from '@/lib/series-check';

/**
 * POST /api/qc/recheck — 컷의 얼굴 검사를 다시 돌린다 (로컬 전용, 점검 2026-10-02 8번).
 * body: { ids: string[] } — 한 번에 6장까지. 검사 방식을 고친 뒤 예전 판정을 바로잡을 때 scripts/recheck-faces.mjs 가 부른다.
 */
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!LOCAL_ONLY) return NextResponse.json({ ok: false, error: '로컬 전용' }, { status: 404 });
  try {
    const body = (await req.json()) as { ids?: unknown };
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x): x is string => typeof x === 'string').slice(0, 6);
    if (!ids.length) return NextResponse.json({ ok: false, error: 'ids 가 필요합니다.' }, { status: 400 });
    const results = await Promise.all(ids.map((id) => recheckFaces(id).catch(() => null)));
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
