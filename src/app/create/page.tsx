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
          ⚠ <b>GPT 엔진 사용 기준</b> — GPT(gpt-image-1)는 전속 모델 <b>얼굴</b>이 유지되지 않고,
          <b>제품 형태·로고 재현과 배경 합성도 부정확합니다</b> (실측: 드롭·라운저가 다른 물건으로 생성됨).
          전속 모델 선택 시 GPT는 차단되며, <b>제품 컷·씬 합성은 제미나이를 사용</b>하세요.
          GPT는 분위기 참고용 러프 컷 정도에만 권장합니다.
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
