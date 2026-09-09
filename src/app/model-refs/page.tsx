import PageHeader from '@/components/PageHeader';
import ModelRefsManager from '@/components/ModelRefsManager';
import { getTalents, getModelRefSummary } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * 자산관리 > 모델 레퍼런스.
 *
 * 전속 모델별로 인물 레퍼런스를 모아두고, 신체 사이즈를 직접 고치는 곳.
 * 사진 1,200장을 페이지에 다 실으면 안 되므로 개수만 집계해 내려보내고,
 * 실제 목록은 화면이 모델을 고를 때 /api/references 로 나눠 받는다.
 */
export default async function ModelRefsPage() {
  const [talents, summary] = await Promise.all([getTalents(), getModelRefSummary(0)]);

  const rows = talents.map((t) => {
    const label = `${t.category}${t.slot ?? ''}`;
    return {
      code: String(t.code),
      label,
      name: t.name ?? '',
      rep: t.rep ?? '',
      size: t.size ?? '',
      sizeEn: t.sizeEn ?? '',
      fitPct: (t as { fitPct?: number }).fitPct ?? 80,
      refCount: summary[label]?.total ?? 0,
    };
  });

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1400px]">
      <PageHeader
        title="모델 레퍼런스"
        desc="전속 모델별 인물 레퍼런스를 모으고 신체 사이즈를 지정합니다. 여기 올린 사진은 이미지 생성 화면의 보관함에서 그 모델 것만 골라 쓸 수 있습니다."
      />
      <ModelRefsManager initial={rows} />
    </div>
  );
}
