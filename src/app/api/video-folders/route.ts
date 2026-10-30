import { NextResponse } from 'next/server';
import { getDb, COLLECTIONS } from '@/lib/db';
import { IDEA_AREA, IDEA_FOLDERS_ID, NOT_IDEA } from '@/lib/idea-videos';

export const dynamic = 'force-dynamic';

type FolderMeta = { _id: string; folders?: { name: string; slug?: string }[] };

/**
 * GET /api/video-folders — 사이드바 하위 폴더 목록.
 *   folders     = '영상 제작물' 아래 폴더
 *   ideaFolders = '레퍼런스 제작물'(기획안 시험작) 아래 폴더 (2026-10-30)
 *
 * 사이드바는 루트 레이아웃의 클라이언트 컴포넌트라 서버 데이터를 직접 못 받는다(nav-badges 와 같은 이유).
 * 폴더 설정 순서대로, 주소(slug)가 있고 영상이 하나라도 든 폴더만 돌려준다.
 */
export async function GET() {
  try {
    const db = await getDb();
    const settings = db.collection<FolderMeta>(COLLECTIONS.settings);
    const countBy = (match: Record<string, unknown>) => db.collection(COLLECTIONS.videos)
      .aggregate<{ _id: string; n: number }>([
        { $match: { hidden: { $ne: true }, folder: { $nin: [null, ''] }, ...match } },
        { $group: { _id: '$folder', n: { $sum: 1 } } },
      ]).toArray();
    const [meta, counts, ideaMeta, ideaCounts] = await Promise.all([
      settings.findOne({ _id: 'video_folders' }),
      countBy(NOT_IDEA),
      settings.findOne({ _id: IDEA_FOLDERS_ID }),
      countBy({ area: IDEA_AREA }),
    ]);
    const pick = (m: FolderMeta | null, c: { _id: string; n: number }[]) => {
      const n = new Map(c.map((x) => [x._id, x.n]));
      return (m?.folders ?? [])
        .filter((f) => f.slug && n.get(f.name))
        .map((f) => ({ name: f.name, slug: f.slug as string, count: n.get(f.name) as number }));
    };
    return NextResponse.json(
      { ok: true, folders: pick(meta, counts), ideaFolders: pick(ideaMeta, ideaCounts) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    // 하위 폴더는 부가 메뉴 — 실패해도 메뉴 자체는 그대로 보이게 빈 값으로
    return NextResponse.json({ ok: false, folders: [], ideaFolders: [], error: (e as Error).message });
  }
}
