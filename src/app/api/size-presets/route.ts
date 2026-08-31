import { NextResponse } from 'next/server';
import { getDb, COLLECTIONS } from '@/lib/db';
import { planAspect } from '@/lib/aspect';

/**
 * 사용자 정의 규격 프리셋.
 *
 * POST   { width, height, label? } — '내 규격' 그룹으로 저장. 같은 치수의 프리셋이
 *        이미 있으면(기본 프리셋 포함) 새로 만들지 않고 그걸 돌려준다.
 * DELETE { value } — '내 규격' 그룹만 삭제할 수 있다. 기본 프리셋은 보호.
 */

export const runtime = 'nodejs';

const MY_GROUP = '내 규격';

function ratioOf(w: number, h: number): string | null {
  if (!w || !h) return null;
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(w, h);
  return `${w / d}:${h / d}`;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { width?: number; height?: number; label?: string };
    const w = Math.round(Number(body.width) || 0);
    const h = Math.round(Number(body.height) || 0);
    if (w < 64 || h < 64 || w > 8192 || h > 8192) {
      return NextResponse.json({ ok: false, error: '규격은 64~8192px 범위여야 합니다.' }, { status: 400 });
    }

    const db = await getDb();
    const col = db.collection(COLLECTIONS.sizePresets);
    const value = `${w}x${h}`;

    // 같은 치수가 이미 있으면 (기본 프리셋이든 내 규격이든) 그대로 재사용 —
    // 중복 항목이 드롭다운에 두 줄로 뜨는 것이 가장 헷갈린다.
    const existing = await col.findOne({ _id: value as never });
    if (existing) {
      return NextResponse.json({ ok: true, existed: true, preset: { ...existing, id: value } });
    }

    const name = (body.label || '').trim().slice(0, 40);
    const plan = planAspect(w, h);
    const doc = {
      _id: value,
      value,
      label: `📐 ${name ? `${name} ` : ''}(${w}×${h})`,
      group: MY_GROUP,
      width: w,
      height: h,
      variableHeight: false,
      exactRatio: ratioOf(w, h),
      genAspect: plan.genAspect,
      retention: plan.retention,
      cropAxis: plan.cropAxis,
      referenceCategory: null,
      designCodeKey: null,
      designNote: '',
      // 기본 프리셋(0~16) 뒤에 정렬되도록
      order: 100 + Date.now() % 100000,
      active: true,
      custom: true,
    };
    await col.insertOne(doc as never);
    return NextResponse.json({ ok: true, existed: false, preset: { ...doc, id: value } });
  } catch (e) {
    console.error('[size-presets POST]', e);
    return NextResponse.json({ ok: false, error: (e as Error).message || '저장 실패' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = (await req.json()) as { value?: string };
    const value = String(body.value || '');
    if (!value) return NextResponse.json({ ok: false, error: 'value 가 필요합니다.' }, { status: 400 });

    const db = await getDb();
    // 그룹 조건을 걸어 기본 프리셋은 지워지지 않게 한다
    const r = await db.collection(COLLECTIONS.sizePresets).deleteOne({ _id: value as never, group: MY_GROUP });
    if (!r.deletedCount) {
      return NextResponse.json({ ok: false, error: '내 규격만 삭제할 수 있습니다.' }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message || '삭제 실패' }, { status: 500 });
  }
}
