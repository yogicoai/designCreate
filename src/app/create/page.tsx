import CreateStudio from '@/components/CreateStudio';
import {
  getProducts, getTalents, getPoseRefs, getSizePresets,
  getPreservationModes, getExpressions, getCuts, getReferences,
} from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function CreatePage() {
  const [products, talents, poses, sizes, preservations, expressions, recentCuts, references] = await Promise.all([
    getProducts(),
    getTalents(),
    getPoseRefs(),
    getSizePresets(),
    getPreservationModes(),
    getExpressions(),
    getCuts({ limit: 400 }),
    getReferences(4000),
  ]);

  // 베이스로 쓸 수 있는 컷만 (라인이 있는 것) — 클라이언트로 넘기는 양을 줄인다
  const baseCuts = recentCuts
    .filter((c) => c.line && c.url)
    .map((c) => ({
      url: c.url,
      line: c.line,
      colorKey: c.colorKey,
      colorName: c.colorName,
      spec: c.spec,
      talentCodes: c.recipe?.talentCodes ?? [],
    }));

  return (
    <>
      {/* GPT 사용 기준 — 화면 최상단 상시 경고 (얼굴 유지 실측 실패로 허들 운영) */}
      {process.env.OPENAI_API_KEY && (
        <div className="mx-4 sm:mx-6 mt-4 px-3 py-2 rounded-[10px] text-[11.5px] leading-relaxed"
             style={{ background: 'rgba(240,180,41,.08)', border: '1px solid var(--warn)', color: 'var(--warn)' }}>
          ⚠ <b>GPT 엔진 사용 기준</b> — GPT(gpt-image-1)는 전속 모델 얼굴이 유지되지 않습니다.
          <b> 인물 노출이 없거나 최소인 컷, 또는 AI 가상 인물 컷에만</b> 사용하세요.
          전속 모델을 선택한 상태에서는 GPT 생성이 차단됩니다. (얼굴 컷은 제미나이 사용)
        </div>
      )}
      <CreateStudio
      products={products}
      talents={talents}
      poses={poses}
      sizes={sizes}
      preservations={preservations}
      expressions={expressions}
      baseCuts={baseCuts}
      references={references}
      promptMode={(process.env.PROMPT_MODE || 'opus') === 'opus' && process.env.ANTHROPIC_API_KEY ? 'opus' : 'local'}
      /* 넘기기 버튼은 로컬 전용 — MD 화면에 나올 기능이 아니다 */
      gptEnabled={Boolean(process.env.OPENAI_API_KEY)}
      localMode={process.env.NODE_ENV !== 'production'}
    />
    </>
  );
}
