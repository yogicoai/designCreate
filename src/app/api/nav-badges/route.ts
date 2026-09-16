import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { NEW_BADGE_MS } from '@/lib/recent';

export const dynamic = 'force-dynamic';

/**
 * GET /api/nav-badges — 사이드바 메뉴 옆 "N" 표시.
 *
 * 사이드바는 루트 레이아웃의 클라이언트 컴포넌트라 서버 데이터를 직접 못 받는다.
 * 여기서 "최근 하루 안에 새로 들어온 게 있는 메뉴" 만 골라 돌려준다.
 *   /model-refs — 모델 레퍼런스가 새로 등록됨 (숨긴 것 제외)
 *   /talents    — 전속 모델이 새로 등록됨 (사용 중인 것만)
 */
export async function GET() {
  try {
    const db = await getDb();
    const since = new Date(Date.now() - NEW_BADGE_MS);
    const [newModelRefs, newTalents] = await Promise.all([
      db.collection('model_refs').countDocuments({ hidden: { $ne: true }, createdAt: { $gte: since } }),
      db.collection('talents').countDocuments({ active: true, createdAt: { $gte: since } }),
    ]);
    const badges: Record<string, string> = {};
    if (newModelRefs > 0) badges['/model-refs'] = 'N';
    if (newTalents > 0) badges['/talents'] = 'N';
    return NextResponse.json({ ok: true, badges }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    // 배지는 부가 정보다 — 실패해도 메뉴는 그대로 보이게 빈 값으로
    return NextResponse.json({ ok: false, badges: {}, error: (e as Error).message });
  }
}
