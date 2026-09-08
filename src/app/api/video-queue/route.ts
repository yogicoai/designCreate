import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';

/*
 * 영상 대기열 — 로컬 전용 (이미지 대기열과 같은 결).
 *
 * 앱은 컷 분할 스토리 시트까지만 만들어 여기 쌓는다. 실제 렌더는 오너가 대화(힉스필드 MCP)
 * 에서 돌리고, 완성된 영상은 다시 앱에 등록한다 — 앱 키에는 영상 크레딧이 없다.
 *
 * GET    대기 중인 요청서
 * POST   요청서 추가 { title, purpose, total, aspect, firstFrame, product, model, shots[] }
 * DELETE ?id=  대기열에서 지우기 (제작을 끝냈을 때)
 */

const localOnly = () => process.env.NODE_ENV !== 'production';

export async function GET() {
  if (!localOnly()) return NextResponse.json({ ok: false, error: '로컬 전용' }, { status: 403 });
  try {
    const db = await getDb();
    const rows = await db.collection('video_queue')
      .find({ done: { $ne: true } }).sort({ createdAt: -1 }).limit(50).toArray();
    return NextResponse.json({
      ok: true,
      items: rows.map((r) => ({
        id: String(r._id),
        title: r.title ?? '무제',
        purpose: r.purpose ?? '',
        total: r.total ?? 0,
        aspect: r.aspect ?? '',
        firstFrame: r.firstFrame ?? '',
        product: r.product ?? '',
        model: r.model ?? '',
        shots: Array.isArray(r.shots) ? r.shots : [],
        createdAt: r.createdAt,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!localOnly()) return NextResponse.json({ ok: false, error: '로컬 전용' }, { status: 403 });
  try {
    const b = await req.json();
    if (!Array.isArray(b?.shots) || !b.shots.length) {
      return NextResponse.json({ ok: false, error: '컷이 비어 있습니다.' }, { status: 400 });
    }
    const db = await getDb();
    const r = await db.collection('video_queue').insertOne({
      createdAt: new Date(),
      done: false,
      title: String(b.title || '').trim() || '무제 영상',
      purpose: b.purpose ?? '',
      total: Number(b.total) || 0,
      aspect: b.aspect ?? '9:16',
      firstFrame: b.firstFrame ?? '',
      product: b.product ?? '',
      model: b.model ?? '',
      copy: { title: b.copyTitle ?? '', subtitle: b.copySubtitle ?? '' },
      shots: b.shots,           // { no, seconds, scene, camera, caption, prompt }
      note: b.note ?? '',
    });
    return NextResponse.json({ ok: true, id: String(r.insertedId) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  if (!localOnly()) return NextResponse.json({ ok: false, error: '로컬 전용' }, { status: 403 });
  try {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return NextResponse.json({ ok: false, error: 'id 가 필요합니다.' }, { status: 400 });
    const db = await getDb();
    await db.collection('video_queue').updateOne({ _id: new ObjectId(id) }, { $set: { done: true, doneAt: new Date() } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
