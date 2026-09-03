import PageHeader from '@/components/PageHeader';
import ReferencesManager from '@/components/ReferencesManager';
import { getReferences } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function ReferencesPage() {
  // 페이지 나누기는 화면에서 한다(20개씩) — 여기서는 넉넉히 불러온다
  const references = await getReferences(5000);

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title="레퍼런스"
        desc="여기 등록한 이미지는 이미지 생성 화면의 보관함에 그대로 뜹니다. 생성 중에 올린 레퍼런스도 자동으로 여기 등록됩니다."
      />
      <ReferencesManager initial={references} />
    </div>
  );
}
