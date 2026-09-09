import PageHeader from '@/components/PageHeader';
import SnsAutomation from '@/components/SnsAutomation';
import { getReferences, getTalents, getProducts } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * 자동화 > SNS 이미지 생성.
 *
 * 클라이언트 요청(확정은 다음 주)의 파일럿: 우리 자산 기준으로 매일 5장쯤
 * SNS 컷을 만든다. 지금은 사람이 버튼을 누르는 수동 실행 — 확정되면 예약으로 옮긴다.
 * 숏츠 영상 쪽은 힉스필드(오너 트랙)에서 따로 만든다.
 */
export default async function SnsAutomationPage() {
  const [references, talents, products] = await Promise.all([getReferences(5000), getTalents(), getProducts()]);
  /*
   * 후보 풀 — 폴더가 곧 만드는 방식이다.
   *   SNS 인물자동화(sns-person) : 사람이 있는 컷 → 그 사람을 우리 모델로 교체 (제미나이)
   *   SNS 배경자동화(sns-scene)  : 사람 없는 공간 컷 → 그 공간에 우리 빈백 배치 (GPT)
   * 기존에 쌓인 인스타그램·촬영 분류도 그대로 후보로 쓸 수 있게 남긴다 (4,500장이 이미 있다).
   */
  const KINDS = ['sns-person', 'instagram', 'shoot'] as const;
  const pool = references
    .filter((r) => (KINDS as readonly string[]).includes(r.category ?? ''))
    .map((r) => ({
      url: r.url,
      title: (r.title || '').slice(0, 40),
      cat: r.category as (typeof KINDS)[number],
    }));

  // 전체 모델을 내려보내되 아동은 표시해둔다 — 랜덤 배정은 성인만, 아동은 카드에서 직접 선택할 때만
  const models = talents.map((t) => ({
    code: String(t.code),
    label: `${t.category}${t.slot ?? ''}`,
    kid: t.category === '아동',
  }));

  // 제품컷용 — 컬러가 있는 라인만 (배경 사진에 얹을 대상)
  const productOpts = products.map((p) => ({
    line: p.line,
    colors: (p.colors ?? []).map((c) => ({ key: c.key, name: c.name })),
  }));

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title="SNS 인물 자동화"
        desc={`인스타+촬영 자산 ${pool.length.toLocaleString()}장 × 전속 모델 랜덤 배정 — 매일 5장 파일럿 (수동 실행)`}
      />
      <SnsAutomation pool={pool} models={models} products={productOpts} mode="person" />
    </div>
  );
}
