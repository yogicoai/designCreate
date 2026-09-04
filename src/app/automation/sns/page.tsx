import PageHeader from '@/components/PageHeader';
import SnsAutomation from '@/components/SnsAutomation';
import { getReferences, getTalents } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * 자동화 > SNS 이미지 생성.
 *
 * 클라이언트 요청(확정은 다음 주)의 파일럿: 우리 자산 기준으로 매일 5장쯤
 * SNS 컷을 만든다. 지금은 사람이 버튼을 누르는 수동 실행 — 확정되면 예약으로 옮긴다.
 * 숏츠 영상 쪽은 힉스필드(오너 트랙)에서 따로 만든다.
 */
export default async function SnsAutomationPage() {
  const [references, talents] = await Promise.all([getReferences(5000), getTalents()]);
  // 후보 풀 = 인스타 + 촬영(2022 실촬영 포함) — 실촬영 베이스가 품질이 제일 좋다
  const pool = references
    .filter((r) => r.category === 'instagram' || r.category === 'shoot')
    .map((r) => ({
      url: r.url,
      title: (r.title || '').slice(0, 40),
      cat: (r.category === 'shoot' ? 'shoot' : 'instagram') as 'shoot' | 'instagram',
    }));
  // 전체 모델을 내려보내되 아동은 표시해둔다 — 랜덤 배정은 성인만, 아동은 카드에서 직접 선택할 때만
  const models = talents.map((t) => ({
    code: String(t.code),
    label: `${t.category}${t.slot ?? ''}`,
    kid: t.category === '아동',
  }));

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title="SNS 이미지 생성"
        desc={`인스타+촬영 자산 ${pool.length.toLocaleString()}장 × 전속 모델 랜덤 배정 — 매일 5장 파일럿 (수동 실행)`}
      />
      <SnsAutomation pool={pool} models={models} />
    </div>
  );
}
