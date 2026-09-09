import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';

/**
 * 스토리보드 — 컷마다 스틸을 만들어 이어붙인 영상 기획안.
 *
 * 스틸을 여러 장 생성해 가며 짜는 작업이라, 화면을 닫아도 남아야 한다.
 * (영상 대기열은 '완성된 요청서'고, 이건 '짜는 중인 작업물'이다.)
 *
 * 상태는 작성중 → 검증중 → 영상완료 로 흐른다 (게시판에서 눈으로 따라간다).
 *
 * GET          내 스토리보드 목록
 * GET ?id=     한 건 불러오기
 * POST         새로 저장 / { id } 가 오면 덮어쓰기
 * DELETE ?id=  삭제
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COL = 'storyboards';

/** 게시판에서 따라가는 진행 상태 */
export const STATUSES: string[] = ['작성중', '검증중', '영상완료'];

export async function GET(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get('id');
    const db = await getDb();
    if (id) {
      const doc = await db.collection(COL).findOne({ _id: new ObjectId(id) });
      if (!doc) return NextResponse.json({ ok: false, error: '없는 스토리보드입니다.' }, { status: 404 });
      return NextResponse.json({ ok: true, board: { ...doc, id: String(doc._id), _id: undefined } });
    }
    const rows = await db.collection(COL)
      .find({ hidden: { $ne: true } }).sort({ updatedAt: -1 }).limit(50).toArray();
    return NextResponse.json({
      ok: true,
      boards: rows.map((r) => ({
        id: String(r._id),
        title: r.title ?? '무제',
        status: r.status ?? '작성중',
        aspect: r.aspect ?? '9:16',
        total: r.total ?? 0,
        shotCount: Array.isArray(r.shots) ? r.shots.length : 0,
        // 스틸이 몇 칸 채워졌는지 — 게시판에서 진척이 보이게
        filled: Array.isArray(r.shots)
          ? r.shots.filter((x: { image?: string }) => x.image).length
          : 0,
        // 컷별 완성 클립이 몇 개 붙었는지 — 제작 진척
        clips: Array.isArray(r.shots)
          ? r.shots.filter((x: { clip?: string }) => x.clip).length
          : 0,
        hasFinal: !!r.finalClip,
        // 목록에서 알아보기 쉽게 첫 컷 스틸을 썸네일로
        thumb: (Array.isArray(r.shots) ? r.shots.find((s: { image?: string }) => s.image)?.image : '') ?? '',
        updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const db = await getDb();
    const now = new Date();
    const doc = {
      title: String(b.title ?? '').trim().slice(0, 120) || '무제 스토리보드',
      purpose: b.purpose ?? 'product',
      total: Number(b.total) || 0,
      aspect: b.aspect ?? '9:16',
      line: b.line ?? '',
      colorKey: b.colorKey ?? '',
      model: b.model ?? '',
      note: String(b.note ?? '').slice(0, 1000),
      // 컷을 나눈 근거 — 다시 열었을 때 무엇을 요청했는지 보여야 한다
      scenario: String(b.scenario ?? '').slice(0, 4000),
      status: STATUSES.includes(String(b.status)) ? String(b.status) : '작성중',
      finalClip: String(b.finalClip ?? '').slice(0, 500),
      finalNote: String(b.finalNote ?? '').slice(0, 200),
      shots: Array.isArray(b.shots) ? b.shots : [],
      updatedAt: now,
    };
    const id = String(b.id ?? '');
    if (id) {
      await db.collection(COL).updateOne({ _id: new ObjectId(id) }, { $set: doc });
      return NextResponse.json({ ok: true, id });
    }
    const r = await db.collection(COL).insertOne({ ...doc, createdAt: now, hidden: false });
    return NextResponse.json({ ok: true, id: String(r.insertedId) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return NextResponse.json({ ok: false, error: 'id 가 필요합니다.' }, { status: 400 });
    const db = await getDb();
    await db.collection(COL).updateOne({ _id: new ObjectId(id) }, { $set: { hidden: true } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
