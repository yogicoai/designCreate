import { notFound } from 'next/navigation';
import PageHeader from '@/components/PageHeader';
import VideoGallery from '@/components/VideoGallery';
import { loadGallery } from '../load';

export const dynamic = 'force-dynamic';

/**
 * 영상 제작물 › 폴더 하나 — 왼쪽 메뉴 '영상 제작물' 아래 하위 폴더를 누르면 오는 곳.
 * 주소는 폴더 설정(settings.video_folders)의 slug (renewal · reference). 한글 폴더 이름으로 와도 연다.
 */
export default async function VideoFolderPage({ params }: { params: Promise<{ folder: string }> }) {
  const { folder } = await params;
  const want = decodeURIComponent(folder);
  const { videos, folders } = await loadGallery();
  const meta = folders.find((f) => f.slug === want || f.name === want);
  if (!meta) notFound();

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      {/* 폴더마다 하는 일이 달라(최종본 · 과정 기록) 설명은 아래 폴더 소개 카드가 맡는다 */}
      <PageHeader title={meta.name} desc="영상 제작물 안의 폴더입니다. 카드마다 만든 과정을 적어 두었습니다." />
      {/* key — 폴더끼리 옮겨 다닐 때 열린 폴더 상태를 새로 잡는다 */}
      <VideoGallery key={meta.name} initial={videos} folders={folders} initialFolder={meta.name} />
    </div>
  );
}
