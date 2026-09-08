import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDb, COLLECTIONS } from '@/lib/db';

/**
 * 영상 갤러리 — 완성 영상 목록.
 *
 * 영상 파일은 cafe24 에 .jpg 로 위장 저장돼 있고, 재생은 /api/video 프록시가 맡는다.
 * 여기에 남기는 건 "어디에 있는 무슨 영상인지"뿐이다.
 *
 * GET     목록
 * POST    등록 { title, key, note?, project?, aspect?, poster? }
 *           key = 사이트 루트 기준 경로 (예: web/design/video/fam3_final.jpg)
 * PATCH   { id, title?, note?, project?, aspect? }
 * DELETE  ?id=   목록에서 제거 (파일은 남는다)
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

/** 전체 URL 로 들어와도 사이트 루트 기준 경로로 통일한다 */
function toKey(raw: string): string {
  const s = clean(raw, 500);
  if (!s) return '';
  try {
    if (/^https?:\/\//.test(s)) return new URL(s).pathname.replace(/^\/+/, '');
  } catch { /* 아래로 */ }
  return s.replace(/^\/+/, '');
}

export async function GET() {
  try {
    const db = await getDb();
    const rows = await db.collection(COLLECTIONS.videos)
      .find({ hidden: { $ne: true } }).sort({ order: 1, createdAt: -1 }).limit(200).toArray();
    return NextResponse.json({
      ok: true,
      videos: rows.map((r) => ({
        id: String(r._id),
        title: r.title ?? '무제',
        note: r.note ?? '',
        project: r.project ?? '',
        aspect: r.aspect ?? '9:16',
        key: r.key ?? '',
        src: `/api/video/${r.key ?? ''}`,
        poster: r.poster ?? '',
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const title = clean(body.title, 120);
    const key = toKey(String(body.key ?? body.url ?? ''));
    if (!title) return NextResponse.json({ ok: false, error: '제목을 적어주세요.' }, { status: 400 });
    if (!key || !key.startsWith('web/')) {
      return NextResponse.json({ ok: false, error: '영상 주소가 우리 서버(/web/...) 것이 아닙니다.' }, { status: 400 });
    }
    const db = await getDb();
    const doc = {
      title,
      key,
      note: clean(body.note, 400),
      project: clean(body.project, 60),
      aspect: clean(body.aspect, 10) || '9:16',
      poster: clean(body.poster, 500),
      order: Number(body.order) || 0,
      createdAt: new Date(),
    };
    const r = await db.collection(COLLECTIONS.videos).insertOne(doc);
    return NextResponse.json({ ok: true, video: { id: String(r.insertedId), ...doc, src: `/api/video/${key}` } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const id = clean(body.id, 40);
    if (!id) return NextResponse.json({ ok: false, error: 'id 가 필요합니다.' }, { status: 400 });
    const set: Record<string, unknown> = {};
    if (body.title !== undefined) set.title = clean(body.title, 120);
    if (body.note !== undefined) set.note = clean(body.note, 400);
    if (body.project !== undefined) set.project = clean(body.project, 60);
    if (body.aspect !== undefined) set.aspect = clean(body.aspect, 10);
    if (!Object.keys(set).length) return NextResponse.json({ ok: false, error: '변경할 값이 없습니다.' }, { status: 400 });
    const db = await getDb();
    await db.collection(COLLECTIONS.videos).updateOne({ _id: new ObjectId(id) }, { $set: set });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get('id') || '';
    if (!id) return NextResponse.json({ ok: false, error: 'id 가 필요합니다.' }, { status: 400 });
    const db = await getDb();
    await db.collection(COLLECTIONS.videos).updateOne({ _id: new ObjectId(id) }, { $set: { hidden: true } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
