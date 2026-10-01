import { getDb, COLLECTIONS } from '@/lib/db';
import type { VideoFolder, VideoRow } from '@/components/VideoGallery';

/**
 * 영상 제작물 화면 공통 — 숨기지 않은 영상 전부와 폴더 설정(이름·주소·소개·묶음 순서).
 * /video/gallery(전체)와 /video/gallery/[폴더 주소](폴더 하나)가 같이 쓴다.
 */
export async function loadGallery(): Promise<{ videos: VideoRow[]; folders: VideoFolder[] }> {
  const db = await getDb();
  const rows = await db.collection(COLLECTIONS.videos)
    .find({ hidden: { $ne: true } }).sort({ order: 1, createdAt: -1 }).limit(200).toArray();

  const videos = rows.map((r) => ({
    id: String(r._id),
    title: (r.title as string) ?? '무제',
    note: (r.note as string) ?? '',
    project: (r.project as string) ?? '',
    folder: (r.folder as string) ?? '',
    summary: (r.summary as string) ?? '',
    aspect: (r.aspect as string) ?? '9:16',
    key: (r.key as string) ?? '',
    src: `/api/video/${r.key ?? ''}`,
    poster: (r.poster as string) ?? '',
    createdAt: r.createdAt ? new Date(r.createdAt as Date).toISOString() : null,
  }));

  // 폴더 소개와 폴더 안 묶음 순서·소개 — 2026-10-01 「리뉴얼 영상 제작」·「레퍼런스 영상 제작」
  const meta = await db.collection<{ _id: string; folders?: VideoFolder[] }>(COLLECTIONS.settings)
    .findOne({ _id: 'video_folders' });
  const folders = (meta?.folders ?? []).map((f) => ({
    name: f.name,
    slug: f.slug ?? '',
    desc: f.desc ?? '',
    sections: (f.sections ?? []).map((s) => ({ project: s.project, desc: s.desc ?? '' })),
  }));

  return { videos, folders };
}
