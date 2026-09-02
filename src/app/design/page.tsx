import PageHeader from '@/components/PageHeader';
import DesignStudio from '@/components/DesignStudio';
import { getCuts } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function DesignPage() {
  // 이 앱이 만든 컷만 배경 후보로 준다 — 이관 컷은 배너 소재가 아니다
  const cuts = await getCuts({ source: 'imgcreate', limit: 60 });
  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title="배너 디자인 생성"
        desc="생성한 컷 위에 문구·버튼·아이콘을 얹어 배너를 완성합니다. 문구만 넣고 자동 배치를 누르면 배경의 빈 곳을 찾아 읽히는 색으로 놓아줍니다 — 마음에 안 들면 끌어서 옮기고 크기를 조절하면 됩니다."
      />
      <DesignStudio
        cuts={cuts.map((c) => ({
          id: c.id,
          url: c.url,
          label: c.title || `${c.line} ${c.colorName}`.trim() || c.spec || '컷',
        }))}
      />
    </div>
  );
}
