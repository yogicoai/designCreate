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
    getReferences(80),
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
      /* 키가 없으면 화면에서 Opus 를 켤 수 없게 한다 — 켜봐야 매번 실패 후 템플릿 폴백이다 */
      opusAvailable={!!process.env.ANTHROPIC_API_KEY}
    />
  );
}
