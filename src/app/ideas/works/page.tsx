import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import IdeaWorks from './IdeaWorks';
import { loadIdeaWorks } from './load';

export const dynamic = 'force-dynamic';

/**
 * 레퍼런스 제작물 — 기획안을 영상으로 시험해 본 것 (사용자 요청 2026-10-30: "아이디어 레퍼런스 아래다가 · 레퍼런스 제작물로 해서
 * · 거기서 확인해보자"). 폴더 = 기획안 한 편, 왼쪽 메뉴 '레퍼런스 제작물' 아래에도 폴더가 붙는다.
 * 완성본은 여기가 아니라 '영상 제작물'로 옮긴다.
 */
export default async function IdeaWorksPage() {
  const { videos, folders } = await loadIdeaWorks();
  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title="레퍼런스 제작물"
        desc="기획안을 영상으로 먼저 만들어 본 것입니다. 기획안 한 편이 폴더 하나이고, 힉스필드에서 뽑은 장면 원본과 편집본을 함께 둡니다."
      />
      <div className="text-[12px] mb-4" style={{ color: 'var(--text-dim)' }}>
        기획안 내용은 <Link href="/ideas" style={{ color: 'var(--accent)' }}>아이디어 · 레퍼런스</Link>에 있습니다.
        확정된 완성본은 영상 제작물로 옮깁니다.
      </div>
      <IdeaWorks videos={videos} folders={folders} />
    </div>
  );
}
