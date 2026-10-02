import { NextResponse } from 'next/server';
import { LOCAL_ONLY } from '@/lib/local-only';
import { checkSeries } from '@/lib/series-check';

/**
 * POST /api/qc/series — 같은 전속 모델의 최근 컷끼리 얼굴이 한 사람으로 보이는지 (로컬 전용, 점검 2026-10-02 8번).
 * body: { talent: 'W_B' } → { ok, result: { cutIds, outliers, note } }. 비전 호출 1회, 같은 컷 묶음이면 저장된 결과를 돌려준다.
 */
export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(req: Request) {
  if (!LOCAL_ONLY) return NextResponse.json({ ok: false, error: '로컬 전용' }, { status: 404 });
  try {
    const body = (await req.json()) as { talent?: unknown };
    const talent = typeof body.talent === 'string' ? body.talent.trim().slice(0, 20) : '';
    if (!talent) return NextResponse.json({ ok: false, error: 'talent 가 필요합니다.' }, { status: 400 });
    return NextResponse.json({ ok: true, result: await checkSeries(talent) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
