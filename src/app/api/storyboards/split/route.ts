import { NextResponse } from 'next/server';
import { splitScenario } from '@/lib/scenario-split';

/**
 * 시나리오 → 컷 분할.
 *
 * 사람이 쓴 시나리오를 읽고 컷을 끊는 건 판단이라 모델이 한다 (프롬프트 작성과 같은 경로).
 * 시나리오 하나당 한 번 호출이라 부담은 작다.
 *
 * POST { scenario, total, aspect, productLabel?, modelLabel? }
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const b = (await req.json()) as {
      scenario?: string; total?: number; aspect?: string;
      productLabel?: string; modelLabel?: string;
    };
    const scenario = String(b.scenario ?? '').trim();
    if (scenario.length < 10) {
      return NextResponse.json(
        { ok: false, error: '시나리오를 조금 더 적어주세요 (열 글자 이상).' },
        { status: 400 },
      );
    }
    const total = Math.max(4, Math.min(60, Math.round(Number(b.total) || 15)));

    const r = await splitScenario({
      scenario,
      total,
      aspect: String(b.aspect ?? '9:16'),
      productLabel: String(b.productLabel ?? ''),
      modelLabel: String(b.modelLabel ?? ''),
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
