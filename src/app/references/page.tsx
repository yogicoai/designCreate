import PageHeader from '@/components/PageHeader';
import ReferencesManager from '@/components/ReferencesManager';
import { getReferences } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function ReferencesPage() {
  /*
   * 첫 묶음(400장)만 서버에서 받아 화면을 바로 띄운다 — 수천 장을 한 번에 실어 보내면
   * 그것만으로 페이지 진입이 느려진다. 나머지는 화면이 뜬 뒤 /api/references 로 이어 받는다.
   */
  const references = await getReferences(400);

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
