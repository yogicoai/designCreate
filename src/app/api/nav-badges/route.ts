import { NextResponse } from 'next/server';
import { getDb, COLLECTIONS } from '@/lib/db';
import { NEW_BADGE_MS, NEW_VIDEO_BADGE_MS } from '@/lib/recent';

export const dynamic = 'force-dynamic';

/**
 * GET /api/nav-badges — 사이드바 메뉴 옆 "N" 표시.
 *
 * 사이드바는 루트 레이아웃의 클라이언트 컴포넌트라 서버 데이터를 직접 못 받는다.
 * 여기서 "최근에(기본 하루 안에) 새로 들어온 게 있는 메뉴" 만 골라 돌려준다.
 *   /model-refs — 모델 레퍼런스가 새로 등록됨 (숨긴 것 제외)
 *   /talents    — 전속 모델이 새로 등록됨 (사용 중인 것만)
 *   /video/gallery — 영상이 새로 올라옴. 이것만 사흘이다 (사용자 요청 2026-10-13).
 *                    그 영상이 든 하위 폴더(/video/gallery/[주소])에도 같이 붙는다 — 폴더에 든 영상은
 *                    '전체'에 안 보여서 폴더까지 짚어 줘야 찾는다.
 */
export async function GET() {
  try {
    const db = await getDb();
    const since = new Date(Date.now() - NEW_BADGE_MS);
    const videoSince = new Date(Date.now() - NEW_VIDEO_BADGE_MS);
    const [newModelRefs, newTalents, newVideos, folderMeta] = await Promise.all([
      db.collection('model_refs').countDocuments({ hidden: { $ne: true }, createdAt: { $gte: since } }),
      db.collection('talents').countDocuments({ active: true, createdAt: { $gte: since } }),
      // fileAt = 카드는 그대로 두고 영상 파일만 새 것으로 바꾼 시각
      db.collection(COLLECTIONS.videos)
        .find({ hidden: { $ne: true }, $or: [{ createdAt: { $gte: videoSince } }, { fileAt: { $gte: videoSince } }] })
        .project<{ folder?: string }>({ folder: 1 }).limit(200).toArray(),
      db.collection<{ _id: string; folders?: { name: string; slug?: string }[] }>(COLLECTIONS.settings)
        .findOne({ _id: 'video_folders' }),
    ]);
    const badges: Record<string, string> = {};
    if (newModelRefs > 0) badges['/model-refs'] = 'N';
    if (newTalents > 0) badges['/talents'] = 'N';
    if (newVideos.length > 0) {
      badges['/video/gallery'] = 'N';
      const slugOf = new Map((folderMeta?.folders ?? []).map((f) => [f.name, f.slug]));
      for (const v of newVideos) {
        const slug = v.folder ? slugOf.get(v.folder) : '';
        if (slug) badges[`/video/gallery/${slug}`] = 'N';
      }
    }
    return NextResponse.json({ ok: true, badges }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    // 배지는 부가 정보다 — 실패해도 메뉴는 그대로 보이게 빈 값으로
    return NextResponse.json({ ok: false, badges: {}, error: (e as Error).message });
  }
}
