import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { composeSize } from '@/lib/model-profile';

/**
 * 모델 레퍼런스 등록.
 *
 * 전속 모델(talents)과는 별개다. 여기는 "이런 느낌의 사람으로 만들고 싶다" 를
 * 사진 + 조건으로 등록해 두는 곳이다 — 사진을 올리고, 나이대·키·체형·AI 적합도를
 * 같이 적어 두면 생성 때 그 조건이 그대로 쓰인다.
 *
 * 사이즈 문장(size/sizeEn)은 서버가 조립한다 — 손으로 적으면 "Max 170 기준" 같은
 * 기준선을 빼먹어 인물 크기가 흔들린다.
 *
 * 등록이 끝나면 오너가 힉스필드로 그 느낌의 <b>정면샷</b> 한 장을 뽑아 카드 옆에 붙인다.
 * 앱 키에는 힉스필드 크레딧이 없어서 생성은 대화 쪽에서 돌고, 여기는 '요청됨 → 완료'
 * 상태와 결과 주소만 들고 있는다.
 *
 * GET          등록된 목록
 * POST         등록 / { id } 가 오면 수정
 * DELETE ?id=  목록에서 제거
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COL = 'model_refs';
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

export async function GET() {
  try {
    const db = await getDb();
    const rows = await db.collection(COL)
      .find({ hidden: { $ne: true } }).sort({ createdAt: -1 }).limit(200).toArray();
    return NextResponse.json({
      ok: true,
      models: rows.map((r) => ({
        id: String(r._id),
        name: r.name ?? '',
        rep: r.rep ?? '',
        age: r.age ?? '20e',
        heightCm: r.heightCm ?? 170,
        bodyType: r.bodyType ?? 'slim',
        fitPct: r.fitPct ?? 80,
        note: r.note ?? '',
        // AI 생성컷 — 이 느낌으로 다시 뽑은 정면샷 (힉스필드, 적합도 반영)
        aiCut: r.aiCut ?? '',
        aiStatus: r.aiStatus ?? '',
        // 얼굴 시트를 칸별로 잘라둔 것 — 카드에는 정면(aiFront)만 쓴다
        aiFront: r.aiFront ?? '',
        aiPanels: Array.isArray(r.aiPanels) ? r.aiPanels : [],
        size: r.size ?? '',
        sizeEn: r.sizeEn ?? '',
        refs: Array.isArray(r.refs) ? r.refs : [],
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const name = clean(b.name, 60);
    if (!name) return NextResponse.json({ ok: false, error: '이름을 적어주세요.' }, { status: 400 });

    const profile = {
      age: clean(b.age, 20) || '20e',
      heightCm: Math.max(60, Math.min(220, Math.round(Number(b.heightCm) || 170))),
      bodyType: clean(b.bodyType, 20) || 'slim',
    };
    const composed = composeSize(profile);
    const doc = {
      name,
      rep: clean(b.rep, 500),
      ...profile,
      fitPct: Math.max(50, Math.min(95, Math.round(Number(b.fitPct) || 80))),
      note: clean(b.note, 500),
      aiCut: clean(b.aiCut, 500),
      aiFront: clean(b.aiFront, 500),
      aiPanels: Array.isArray(b.aiPanels) ? (b.aiPanels as string[]).slice(0, 8).map((u) => String(u)) : [],
      // '' 미요청 | 'requested' 생성 대기 | 'done' 완료
      aiStatus: ['requested', 'done'].includes(clean(b.aiStatus, 20)) ? clean(b.aiStatus, 20) : '',
      ...composed,
      refs: Array.isArray(b.refs)
        ? (b.refs as { url?: string; title?: string }[])
            .filter((r) => r?.url)
            .slice(0, 60)
            .map((r) => ({ url: String(r.url), title: clean(r.title, 120) }))
        : [],
      updatedAt: new Date(),
    };

    const db = await getDb();
    const id = clean(b.id, 40);
    if (id) {
      await db.collection(COL).updateOne({ _id: new ObjectId(id) }, { $set: doc });
      return NextResponse.json({ ok: true, id });
    }
    const r = await db.collection(COL).insertOne({ ...doc, createdAt: new Date(), hidden: false });
    return NextResponse.json({ ok: true, id: String(r.insertedId) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get('id') || '';
    if (!id) return NextResponse.json({ ok: false, error: 'id 가 필요합니다.' }, { status: 400 });
    const db = await getDb();
    await db.collection(COL).updateOne({ _id: new ObjectId(id) }, { $set: { hidden: true } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
