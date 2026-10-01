import PageHeader from '@/components/PageHeader';
import VideoGallery from '@/components/VideoGallery';
import { loadGallery } from './load';

export const dynamic = 'force-dynamic';

/**
 * 영상 제작물 (예전 영상 갤러리) — 완성된 영상이 쌓이는 곳.
 * 스토리 시트로 요청 → 오너가 힉스필드로 제작 → 여기 등록, 이 흐름의 마지막 칸이다.
 * 폴더에 넣은 영상은 여기('전체')서 빠지고, 왼쪽 메뉴의 하위 폴더(/video/gallery/[폴더 주소])에서 본다.
 */
export default async function VideoGalleryPage() {
  const { videos, folders } = await loadGallery();

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title="영상 제작물"
        desc="완성된 영상을 모아 봅니다. 파일은 cafe24 에 올라가 있고 재생은 앱이 중계합니다 — 링크를 그대로 공유해도 열립니다."
      />
      <VideoGallery initial={videos} folders={folders} />
    </div>
  );
}
