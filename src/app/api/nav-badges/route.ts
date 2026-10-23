import { NextResponse } from 'next/server';
import { getDb, COLLECTIONS } from '@/lib/db';
import { NEW_BADGE_MS, NEW_ITEM_BADGE_MS, NEW_VIDEO_BADGE_MS } from '@/lib/recent';

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
 * 아래 셋도 사흘이다 (사용자 요청 2026-10-14):
 *   /cuts        — 이 앱·대화에서 새로 만든 컷이 있음 (숨긴 것 · 이관 컷 · SNS 자동화 컷 제외 — 갤러리 화면과 같은 범위)
 *   /dropbox     — 드롭박스 사진이 새로 들어옴
 *   /ai-products — AI 생성 제품 시트가 새로 등록됨
 * 드롭박스와 AI 생성 제품은 메뉴에 N 을 박아 뒀더니 계속 붙어 있었다 — 이제 새 자료가 있을 때만 뜬다.
 */

/**
 * 새로 생긴 메뉴 — 자료가 따로 없는 화면이라 날짜로 정한다. 적어 둔 시각이 지나면 저절로 사라진다.
 * (메뉴에 badge 를 박아 두면 지우는 걸 잊어 계속 붙는다 — 사용자 지적 2026-10-14)
 */
const NEW_MENUS: Record<string, string> = {
  '/video/process': '2026-10-17T23:59:59+09:00',          // 영상 제작 과정 — 2026-10-14 에 생김
  '/image-edit': '2026-10-17T23:59:59+09:00',             // 포토샵(이미지 편집) — 2026-10-14 에 생김
  '/image-edit/guide': '2026-10-17T23:59:59+09:00',       // 포토샵 AI 사용설명서 — 2026-10-14 에 생김
  // 새 기능이 들어간 화면도 같은 방식으로 알린다 (사용자 요청 2026-10-21) — 화면 안의 버튼에는 NEW 표시(lib/new-features.ts)
  '/create': '2026-10-24T23:59:59+09:00',                 // 얼굴 다시 그리기 · 2인 이상 4K — 2026-10-21
};

export async function GET() {
  try {
    const db = await getDb();
    const since = new Date(Date.now() - NEW_BADGE_MS);
    const videoSince = new Date(Date.now() - NEW_VIDEO_BADGE_MS);
    const itemSince = new Date(Date.now() - NEW_ITEM_BADGE_MS);
    // 있는지만 보면 되니 한 건에서 멈춘다 — 컷·드롭박스는 수천 건이라 다 세지 않는다
    const any = (name: string, q: Record<string, unknown>) =>
      db.collection(name).countDocuments({ ...q, createdAt: { $gte: itemSince } }, { limit: 1 });
    const [newModelRefs, newTalents, newVideos, folderMeta, newCuts, newDropbox, newAiProducts] = await Promise.all([
      db.collection('model_refs').countDocuments({ hidden: { $ne: true }, createdAt: { $gte: since } }),
      db.collection('talents').countDocuments({ active: true, createdAt: { $gte: since } }),
      // fileAt = 카드는 그대로 두고 영상 파일만 새 것으로 바꾼 시각
      db.collection(COLLECTIONS.videos)
        .find({ hidden: { $ne: true }, $or: [{ createdAt: { $gte: videoSince } }, { fileAt: { $gte: videoSince } }] })
        .project<{ folder?: string }>({ folder: 1 }).limit(200).toArray(),
      db.collection<{ _id: string; folders?: { name: string; slug?: string }[] }>(COLLECTIONS.settings)
        .findOne({ _id: 'video_folders' }),
      any(COLLECTIONS.cuts, { hidden: { $ne: true }, source: 'imgcreate', origin: { $ne: 'sns-auto' } }),
      any('dropbox_assets', { active: { $ne: false } }),
      any(COLLECTIONS.aiProducts, { hidden: { $ne: true } }),
    ]);
    const badges: Record<string, string> = {};
    if (newModelRefs > 0) badges['/model-refs'] = 'N';
    if (newTalents > 0) badges['/talents'] = 'N';
    if (newCuts > 0) badges['/cuts'] = 'N';
    if (newDropbox > 0) badges['/dropbox'] = 'N';
    if (newAiProducts > 0) badges['/ai-products'] = 'N';
    for (const [href, until] of Object.entries(NEW_MENUS)) {
      if (Date.now() < new Date(until).getTime()) badges[href] = 'N';
    }
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
