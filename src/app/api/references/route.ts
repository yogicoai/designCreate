import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

/**
 * 레퍼런스 보관함.
 *
 * 업로드(/api/upload)된 레퍼런스는 자동으로 여기 등록된다 — FTP 에는 어차피 영구 저장되므로
 * DB 에 목록만 있으면 다음 작업에서 재업로드 없이 골라 쓸 수 있다.
 *
 * GET    최근 레퍼런스 목록
 * DELETE { url } — 보관함에서 숨김 (소프트 삭제. FTP 파일은 다른 생성물이 참조할 수 있어 지우지 않는다)
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const db = await getDb();
    const docs = await db
      .collection('references')
      .find({ active: { $ne: false } })
      .sort({ createdAt: -1 })
      .limit(80)
      .toArray();
    return NextResponse.json({
      ok: true,
      references: docs.map((d) => ({
        url: d.url,
        title: d.title ?? '',
        width: d.width ?? 0,
        height: d.height ?? 0,
        createdAt: d.createdAt ?? null,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as { url?: string; title?: string };
    if (!body.url) return NextResponse.json({ ok: false, error: 'url 이 필요합니다.' }, { status: 400 });
    const db = await getDb();
    await db.collection('references').updateOne(
      { url: body.url },
      { $set: { title: String(body.title ?? '').slice(0, 120) } },
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = (await req.json()) as { url?: string };
    if (!body.url) return NextResponse.json({ ok: false, error: 'url 이 필요합니다.' }, { status: 400 });
    const db = await getDb();
    await db.collection('references').updateOne({ url: body.url }, { $set: { active: false } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
