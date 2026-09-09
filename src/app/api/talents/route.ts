import { NextResponse } from 'next/server';
import { getDb, COLLECTIONS } from '@/lib/db';
import { composeSize } from '@/lib/model-profile';

/**
 * 전속 모델 기본 정보 수정.
 *
 * 지금은 신체 사이즈만 다룬다 — 이 값이 프롬프트의 SCALE 문장으로 그대로 들어가서
 * 제품 대비 인물 크기를 결정한다. 잘못 적히면 빈백이 방석처럼 작아 보이거나
 * 사람이 난쟁이처럼 나온다. 그래서 화면에서 직접 고칠 수 있어야 한다.
 *
 * PATCH { code, name?, age?, size?, sizeEn?, fitPct?, rep? }
 *
 * fitPct = 이 모델을 AI 로 만들 때의 기본 적합도(%). 사진 속 인물을 이 모델로 바꿀 때
 * 얼마나 강하게 우리 모델 쪽으로 끌어올지의 기본값이다.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as { code?: string; size?: string; sizeEn?: string; fitPct?: number; rep?: string; age?: string; name?: string; heightCm?: number; bodyType?: string };
    const code = String(body.code ?? '').trim();
    if (!code) return NextResponse.json({ ok: false, error: '모델 코드가 필요합니다.' }, { status: 400 });

    const set: Record<string, string | number> = {};
    if (body.size !== undefined) set.size = String(body.size).trim().slice(0, 120);
    if (body.sizeEn !== undefined) set.sizeEn = String(body.sizeEn).trim().slice(0, 300);
    if (body.name !== undefined) set.name = String(body.name).trim().slice(0, 60);
    /*
     * 나이대. 체형만큼이나 결과를 크게 가르는 값이라 따로 둔다 —
     * 같은 키·체형이어도 20대와 40대는 얼굴·자세·옷이 전부 달라진다.
     */
    if (body.age !== undefined) set.age = String(body.age).trim().slice(0, 40);
    if (body.heightCm !== undefined) set.heightCm = Math.max(60, Math.min(220, Math.round(Number(body.heightCm) || 0)));
    if (body.bodyType !== undefined) set.bodyType = String(body.bodyType).trim().slice(0, 30);

    /*
     * 나이대·키·체형이 하나라도 오면 프롬프트 문장(size/sizeEn)을 서버가 다시 조립한다.
     * 손으로 적게 두면 "Max 170 기준" 같은 기준선을 빼먹어서 인물 크기가 흔들린다.
     */
    if (body.age !== undefined || body.heightCm !== undefined || body.bodyType !== undefined) {
      const db0 = await getDb();
      const cur = await db0.collection(COLLECTIONS.talents).findOne({ code });
      const merged = {
        age: String(set.age ?? cur?.age ?? '20e'),
        heightCm: Number(set.heightCm ?? cur?.heightCm ?? 170),
        bodyType: String(set.bodyType ?? cur?.bodyType ?? 'slim'),
      };
      const composed = composeSize(merged);
      set.size = composed.size;
      set.sizeEn = composed.sizeEn;
    }
    // 대표 이미지 — 이 모델을 알아보는 얼굴. 생성 때 아이덴티티 참조로도 들어간다
    if (body.rep !== undefined) set.rep = String(body.rep).trim().slice(0, 500);
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
