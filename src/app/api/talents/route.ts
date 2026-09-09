import { NextResponse } from 'next/server';
import { getDb, COLLECTIONS } from '@/lib/db';

/**
 * 전속 모델 기본 정보 수정.
 *
 * 지금은 신체 사이즈만 다룬다 — 이 값이 프롬프트의 SCALE 문장으로 그대로 들어가서
 * 제품 대비 인물 크기를 결정한다. 잘못 적히면 빈백이 방석처럼 작아 보이거나
 * 사람이 난쟁이처럼 나온다. 그래서 화면에서 직접 고칠 수 있어야 한다.
 *
 * PATCH { code, size?, sizeEn?, fitPct? }
 *
 * fitPct = 이 모델을 AI 로 만들 때의 기본 적합도(%). 사진 속 인물을 이 모델로 바꿀 때
 * 얼마나 강하게 우리 모델 쪽으로 끌어올지의 기본값이다.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as { code?: string; size?: string; sizeEn?: string; fitPct?: number };
    const code = String(body.code ?? '').trim();
    if (!code) return NextResponse.json({ ok: false, error: '모델 코드가 필요합니다.' }, { status: 400 });

    const set: Record<string, string | number> = {};
    if (body.size !== undefined) set.size = String(body.size).trim().slice(0, 120);
    if (body.sizeEn !== undefined) set.sizeEn = String(body.sizeEn).trim().slice(0, 300);
    if (body.fitPct !== undefined) {
      const n = Math.round(Number(body.fitPct));
      set.fitPct = Math.max(50, Math.min(95, Number.isFinite(n) ? n : 80));
    }
    if (!Object.keys(set).length) {
      return NextResponse.json({ ok: false, error: '변경할 값이 없습니다.' }, { status: 400 });
    }

    const db = await getDb();
    const r = await db.collection(COLLECTIONS.talents).updateOne({ code }, { $set: set });
    if (!r.matchedCount) return NextResponse.json({ ok: false, error: '없는 모델입니다.' }, { status: 404 });
    return NextResponse.json({ ok: true, ...set });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
