import PageHeader from '@/components/PageHeader';
import VideoGallery from '@/components/VideoGallery';
import { getDb, COLLECTIONS } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * 영상 갤러리 — 완성된 영상이 쌓이는 곳.
 * 스토리 시트로 요청 → 오너가 힉스필드로 제작 → 여기 등록, 이 흐름의 마지막 칸이다.
 */
export default async function VideoGalleryPage() {
  const db = await getDb();
  const rows = await db.collection(COLLECTIONS.videos)
    .find({ hidden: { $ne: true } }).sort({ order: 1, createdAt: -1 }).limit(200).toArray();

  const videos = rows.map((r) => ({
    id: String(r._id),
    title: (r.title as string) ?? '무제',
    note: (r.note as string) ?? '',
    project: (r.project as string) ?? '',
    aspect: (r.aspect as string) ?? '9:16',
    key: (r.key as string) ?? '',
    src: `/api/video/${r.key ?? ''}`,
    poster: (r.poster as string) ?? '',
    createdAt: r.createdAt ? new Date(r.createdAt as Date).toISOString() : null,
  }));

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title="영상 갤러리"
        desc="완성된 영상을 모아 봅니다. 파일은 cafe24 에 올라가 있고 재생은 앱이 중계합니다 — 링크를 그대로 공유해도 열립니다."
      />
      <VideoGallery initial={videos} />
    </div>
  );
}
