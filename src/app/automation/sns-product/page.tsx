import PageHeader from '@/components/PageHeader';
import SnsAutomation from '@/components/SnsAutomation';
import { getReferences, getTalents, getProducts } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * 자동화 > SNS 제품 자동화.
 *
 * 인물 자동화와 화면을 나눈 이유: 만드는 것도, 쓰는 엔진도 다르다.
 * 여기는 사람이 없는 공간 사진에 우리 빈백을 얹는다 — 배경 합성이 자연스러운 GPT 로 간다.
 * (인물 교체는 얼굴 유지력이 검증된 제미나이 쪽, /automation/sns)
 */
export default async function SnsProductAutomationPage() {
  const [references, talents, products] = await Promise.all([
    getReferences(5000), getTalents(), getProducts(),
  ]);

  /*
   * 후보 = 사람이 없는 공간 컷.
   *   SNS 배경자동화(sns-scene) : 이 화면을 위해 담당자가 채우는 폴더
   *   인테리어(interior)        : 예전부터 모아둔 빈 공간 컷 — 그대로 쓸 수 있다
   */
  const KINDS = ['sns-scene', 'interior'] as const;
  const pool = references
    .filter((r) => (KINDS as readonly string[]).includes(r.category ?? ''))
    .map((r) => ({
      url: r.url,
      title: (r.title || '').slice(0, 40),
      cat: r.category as (typeof KINDS)[number],
    }));

  const models = talents.map((t) => ({
    code: String(t.code),
    label: `${t.category}${t.slot ?? ''}`,
    kid: t.category === '아동',
  }));

  const productOpts = products.map((p) => ({
    line: p.line,
    colors: (p.colors ?? []).map((c) => ({ key: c.key, name: c.name })),
  }));

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title="SNS 제품 자동화"
        desc={`사람 없는 공간 컷 ${pool.length.toLocaleString()}장 × 우리 제품 랜덤 배치 — 인물 없이 제품만 (수동 실행)`}
      />
      <SnsAutomation pool={pool} models={models} products={productOpts} mode="product" />
    </div>
  );
}
