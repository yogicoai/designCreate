import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';

/*
 * 힉스필드 대기열 — 로컬 전용.
 *
 * CreateStudio 에서 "힉스필드용으로 남기기" 를 누르면 handoffs 컬렉션에
 * used:false 로 쌓인다. 이 라우트는 그 대기열을 화면에서 보고(GET) 지우기(DELETE)
 * 위한 것이다. 실제 생성은 여전히 대화(MCP)에서 돌린다 — 앱 키에는 크레딧이 없다.
 *
 * 배포(MD 용)에는 노출하지 않는다: handoff 자체가 dev 에서만 쌓이고,
 * 대기열은 오너 한 사람의 작업 도구다.
 */

function localOnly(): boolean {
  return process.env.NODE_ENV !== 'production';
}

export async function GET() {
  if (!localOnly()) {
    return NextResponse.json({ ok: false, error: '로컬 전용' }, { status: 403 });
  }
  try {
    const db = await getDb();
    const rows = await db
      .collection('handoffs')
      .find({ used: { $ne: true } })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    const items = rows.map((h) => {
      const sel = (h.selection ?? {}) as Record<string, unknown>;
      const refs = Array.isArray(h.refs) ? h.refs : [];
      const talents = Array.isArray(sel.talents) ? (sel.talents as unknown[]) : [];
      const products = Array.isArray(sel.products) ? (sel.products as unknown[]) : [];
      const count = Math.max(1, Math.min(4, Math.round(Number(h.count) || 1)));
      const resolution = h.resolution === '4k' ? '4k' : '2k';
      return {
        id: String(h._id),
        title: (h.title as string) || (h.sizeLabel as string) || '무제',
        createdAt: h.createdAt,
        aspect: h.aspect ?? null,
        sizeLabel: h.sizeLabel ?? null,
        target: h.target ?? null,
        count,
        resolution,
        // 크레딧 추정: 장수 × (2k=1, 4k=4)
        credits: count * (resolution === '4k' ? 4 : 1),
        refCount: refs.length,
        talentCount: talents.length,
        productCount: products.length,
        direction: (sel.direction as string) || '',
      };
    });

    const totalCredits = items.reduce((s, x) => s + x.credits, 0);
    return NextResponse.json({ ok: true, items, totalCredits });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  if (!localOnly()) {
    return NextResponse.json({ ok: false, error: '로컬 전용' }, { status: 403 });
  }
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id') || '';
    if (!ObjectId.isValid(id)) {
      return NextResponse.json({ ok: false, error: 'id 가 올바르지 않습니다.' }, { status: 400 });
    }
    const db = await getDb();
    const r = await db.collection('handoffs').deleteOne({ _id: new ObjectId(id) });
    return NextResponse.json({ ok: true, deleted: r.deletedCount });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
