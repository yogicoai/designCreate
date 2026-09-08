import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { COLLECTIONS } from '@/lib/db';

/**
 * 전속 모델의 의상 컨셉 — 추가 / 수정 / 삭제.
 *
 * 여기서 넣은 의상은 talents 문서의 outfits[] 에 그대로 쌓이고,
 * 이미지 생성 화면(모델 카드의 '의상' 줄)에 바로 뜬다. 생성 시에는
 * /api/generate 가 code 로 찾아 프롬프트의 `OUTFIT:` 줄을 쓰고,
 * cropUrl 이 있으면 의상 참조 이미지로도 넣는다.
 *
 * ⚠️ cropUrl 은 '얼굴이 없는' 의상 컷만 넣어야 한다 — 얼굴이 든 사진을 참조로 넣으면
 *    모델 얼굴이 그 사진 쪽으로 끌려간다(아이덴티티 오염).
 *
 * POST   { talentCode, desc, descEn?, imageUrl?, useAsRef? }  의상 추가 (code 는 서버가 매김)
 * PATCH  { talentCode, code, desc?, descEn?, imageUrl?, useAsRef? }  수정
 * DELETE { talentCode, code }  삭제
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface OutfitRow {
  code: string;
  desc: string;
  descEn?: string;
  imageUrl?: string;
  cropUrl?: string;
}

const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

/** 기존 코드 규칙을 그대로 따른다 — 성인 'B_W_C_03', 아동 'KID_A_02' */
function nextCode(talent: { category?: string; slot?: string; code?: string }, outfits: OutfitRow[]): string {
  const slot = (talent.slot || 'A').toUpperCase();
  const kid = talent.category === '아동';
  const sex = String(talent.code || '').startsWith('M') ? 'M' : 'W';
  const prefix = kid ? `KID_${slot}_` : `${slot}_${sex}_C_`;
  let n = 0;
  for (const o of outfits) {
    const m = new RegExp(`^${prefix}(\d+)$`).exec(o.code || '');
    if (m) n = Math.max(n, Number(m[1]));
  }
  // 규칙 밖 코드가 섞여 있어도 겹치지만 않으면 된다
  let code = '';
  do { n += 1; code = `${prefix}${String(n).padStart(2, '0')}`; } while (outfits.some((o) => o.code === code));
  return code;
}

async function loadTalent(talentCode: string) {
  const db = await getDb();
  const col = db.collection(COLLECTIONS.talents);
  const t = await col.findOne({ code: talentCode });
  return { col, t };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      talentCode?: string; desc?: string; descEn?: string; imageUrl?: string; useAsRef?: boolean;
    };
    const talentCode = clean(body.talentCode, 20);
    const desc = clean(body.desc, 60);
    if (!talentCode) return NextResponse.json({ ok: false, error: '모델을 고르지 않았습니다.' }, { status: 400 });
    if (!desc) return NextResponse.json({ ok: false, error: '의상 이름을 적어주세요.' }, { status: 400 });

    const { col, t } = await loadTalent(talentCode);
    if (!t) return NextResponse.json({ ok: false, error: '없는 모델입니다.' }, { status: 404 });

    const outfits = (t.outfits ?? []) as OutfitRow[];
    const imageUrl = clean(body.imageUrl, 500);
    const outfit: OutfitRow = {
      code: nextCode(t as { category?: string; slot?: string; code?: string }, outfits),
      desc,
      // 영문이 없으면 국문을 그대로 쓴다 — prompt-writer 가 `descEn || desc` 로 받는다
      descEn: clean(body.descEn, 200),
      ...(imageUrl ? { imageUrl } : {}),
      // 얼굴 없는 컷이라고 확인한 것만 생성 참조로
      ...(imageUrl && body.useAsRef ? { cropUrl: imageUrl } : {}),
    };
    await col.updateOne({ code: talentCode }, { $push: { outfits: outfit } } as never);
    return NextResponse.json({ ok: true, outfit });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as {
      talentCode?: string; code?: string; desc?: string; descEn?: string; imageUrl?: string; useAsRef?: boolean;
    };
    const talentCode = clean(body.talentCode, 20);
    const code = clean(body.code, 40);
    if (!talentCode || !code) return NextResponse.json({ ok: false, error: 'talentCode·code 가 필요합니다.' }, { status: 400 });

    const { col, t } = await loadTalent(talentCode);
    if (!t) return NextResponse.json({ ok: false, error: '없는 모델입니다.' }, { status: 404 });

    const outfits = (t.outfits ?? []) as OutfitRow[];
    const i = outfits.findIndex((o) => o.code === code);
    if (i < 0) return NextResponse.json({ ok: false, error: '없는 의상입니다.' }, { status: 404 });

    const cur = outfits[i];
    const imageUrl = body.imageUrl !== undefined ? clean(body.imageUrl, 500) : cur.imageUrl;
    const useAsRef = body.useAsRef !== undefined ? !!body.useAsRef : !!cur.cropUrl;
    const next: OutfitRow = {
      code: cur.code,
      desc: body.desc !== undefined ? clean(body.desc, 60) || cur.desc : cur.desc,
      descEn: body.descEn !== undefined ? clean(body.descEn, 200) : (cur.descEn ?? ''),
      ...(imageUrl ? { imageUrl } : {}),
      ...(imageUrl && useAsRef ? { cropUrl: imageUrl } : {}),
    };
    outfits[i] = next;
    await col.updateOne({ code: talentCode }, { $set: { outfits } });
    return NextResponse.json({ ok: true, outfit: next });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = (await req.json()) as { talentCode?: string; code?: string };
    const talentCode = clean(body.talentCode, 20);
    const code = clean(body.code, 40);
    if (!talentCode || !code) return NextResponse.json({ ok: false, error: 'talentCode·code 가 필요합니다.' }, { status: 400 });
    const db = await getDb();
    const r = await db.collection(COLLECTIONS.talents)
      .updateOne({ code: talentCode }, { $pull: { outfits: { code } } } as never);
    if (!r.matchedCount) return NextResponse.json({ ok: false, error: '없는 모델입니다.' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
