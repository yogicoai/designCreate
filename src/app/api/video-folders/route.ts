import { NextResponse } from 'next/server';
import { getDb, COLLECTIONS } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/video-folders — 사이드바 '영상 제작물' 아래 하위 폴더 목록.
 *
 * 사이드바는 루트 레이아웃의 클라이언트 컴포넌트라 서버 데이터를 직접 못 받는다(nav-badges 와 같은 이유).
 * 폴더 설정(settings.video_folders) 순서대로, 주소(slug)가 있고 영상이 하나라도 든 폴더만 돌려준다.
 */
export async function GET() {
  try {
    const db = await getDb();
    const [meta, counts] = await Promise.all([
      db.collection<{ _id: string; folders?: { name: string; slug?: string }[] }>(COLLECTIONS.settings)
        .findOne({ _id: 'video_folders' }),
      db.collection(COLLECTIONS.videos).aggregate<{ _id: string; n: number }>([
        { $match: { hidden: { $ne: true }, folder: { $nin: [null, ''] } } },
        { $group: { _id: '$folder', n: { $sum: 1 } } },
      ]).toArray(),
    ]);
    const n = new Map(counts.map((c) => [c._id, c.n]));
    const folders = (meta?.folders ?? [])
      .filter((f) => f.slug && n.get(f.name))
      .map((f) => ({ name: f.name, slug: f.slug as string, count: n.get(f.name) as number }));
    return NextResponse.json({ ok: true, folders }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    // 하위 폴더는 부가 메뉴 — 실패해도 '영상 제작물' 자체는 그대로 보이게 빈 값으로
    return NextResponse.json({ ok: false, folders: [], error: (e as Error).message });
  }
}
