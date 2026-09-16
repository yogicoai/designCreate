import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { COLLECTIONS, getDb } from '@/lib/db';
import { toSheet, type SheetPanel } from '@/lib/ai-products';

/**
 * AI 생성 제품 시트.
 *
 * 등록(POST)은 여기 없다 — 시트는 대화에서 힉스필드로 뽑고, 자르고, 사양과 대조한 뒤
 * 스크립트가 바로 넣는다. 화면은 보고 판단하는 곳이라 상태·메모만 바꾼다.
 *
 * GET              목록
 * PATCH { id, status?, note?, panel? }   승인 / 검증중으로 되돌리기 / 메모 / 칸 켜고 끄기
 * DELETE ?id=      목록에서 빼기 (기록은 남긴다)
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const db = await getDb();
    const rows = await db.collection(COLLECTIONS.aiProducts)
      .find({ hidden: { $ne: true } }).sort({ line: 1, createdAt: -1 }).limit(300).toArray();
    return NextResponse.json({ ok: true, sheets: rows.map((r) => toSheet(r as Record<string, unknown>)) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const id = String(b.id ?? '');
    if (!ObjectId.isValid(id)) return NextResponse.json({ ok: false, error: 'id 가 필요합니다.' }, { status: 400 });

    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (b.status === 'approved' || b.status === 'review') {
      set.status = b.status;
      set.approvedAt = b.status === 'approved' ? new Date() : null;
    }
    if (typeof b.note === 'string') set.note = b.note.trim().slice(0, 500);

    const db = await getDb();

    /*
     * 칸 켜고 끄기 — { panel: { key, off } }.
     * 칸 배열을 통째로 받지 않고 키 하나만 받는다: 화면이 보낸 낡은 배열이
     * 다른 사람이 방금 바꾼 칸을 덮어쓰는 걸 막는다.
     */
    const pr = b.panel as { key?: unknown; off?: unknown } | undefined;
    if (pr && typeof pr.key === 'string' && pr.key) {
      const cur = await db.collection(COLLECTIONS.aiProducts).findOne({ _id: new ObjectId(id) });
      if (!cur) return NextResponse.json({ ok: false, error: '없는 시트입니다.' }, { status: 404 });
      const panels = (Array.isArray(cur.panels) ? (cur.panels as SheetPanel[]) : []).map((p) => (
        p.key === pr.key ? { ...p, off: pr.off === true } : p
      ));
      if (!panels.some((p) => p.key === pr.key)) {
        return NextResponse.json({ ok: false, error: '없는 칸입니다.' }, { status: 400 });
      }
      // 칸을 다 끄면 생성에서 이 시트를 못 쓴다 — 실수로 전부 끄는 걸 막는다
      if (!panels.some((p) => !p.off)) {
        return NextResponse.json({ ok: false, error: '칸을 전부 끌 수는 없습니다 — 최소 한 칸은 남겨두세요.' }, { status: 400 });
      }
      set.panels = panels;
    }

    const r = await db.collection(COLLECTIONS.aiProducts)
      .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: set }, { returnDocument: 'after' });
    if (!r) return NextResponse.json({ ok: false, error: '없는 시트입니다.' }, { status: 404 });
    return NextResponse.json({ ok: true, sheet: toSheet(r as Record<string, unknown>) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get('id') ?? '';
    if (!ObjectId.isValid(id)) return NextResponse.json({ ok: false, error: 'id 가 필요합니다.' }, { status: 400 });
    const db = await getDb();
    // 크레딧을 들여 만든 것이라 지우지 않고 숨긴다 — 삭제하면 원가 기록도 같이 사라진다
    await db.collection(COLLECTIONS.aiProducts)
      .updateOne({ _id: new ObjectId(id) }, { $set: { hidden: true, updatedAt: new Date() } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
