import PageHeader from '@/components/PageHeader';
import TrendBoard from '@/components/TrendBoard';

export const dynamic = 'force-dynamic';

export default function TrendsPage() {
  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title="시즌 트렌드"
        desc="월별로 쌓아두는 참고 보드입니다. 원본은 우리 서버에 담지 않고 썸네일과 출처 링크만 보관하며, 이미지 생성의 레퍼런스로는 쓰이지 않습니다 — 보고 참고하는 용도입니다."
      />
      <TrendBoard />
    </div>
  );
}
