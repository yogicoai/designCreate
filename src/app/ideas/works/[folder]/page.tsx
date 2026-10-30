import Link from 'next/link';
import { notFound } from 'next/navigation';
import PageHeader from '@/components/PageHeader';
import IdeaWorks from '../IdeaWorks';
import { loadIdeaWorks } from '../load';

export const dynamic = 'force-dynamic';

/**
 * 레퍼런스 제작물 › 폴더 하나(기획안 한 편) — 왼쪽 메뉴 '레퍼런스 제작물' 아래 폴더를 누르면 오는 곳.
 * 주소는 폴더 설정의 slug. 한글 폴더 이름으로 와도 연다.
 */
export default async function IdeaWorksFolderPage({ params }: { params: Promise<{ folder: string }> }) {
  const { folder } = await params;
  const want = decodeURIComponent(folder);
  const { videos, folders } = await loadIdeaWorks();
  const name = folders.find((f) => f.slug === want || f.name === want)?.name
    ?? (videos.some((v) => v.folder === want) ? want : '');
  if (!name) notFound();

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader title={name} desc="레퍼런스 제작물 안의 폴더입니다. 카드마다 만든 방법과 쓴 크레딧을 적어 두었습니다." />
      <div className="mb-4">
        <Link href="/ideas/works" className="chip">← 레퍼런스 제작물 전체</Link>
      </div>
      <IdeaWorks videos={videos} folders={folders} only={name} />
    </div>
  );
}
