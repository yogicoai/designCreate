import CreateStudio from '@/components/CreateStudio';
import {
  getProducts, getTalents, getPoseRefs, getSizePresets,
  getPreservationModes, getExpressions, getCuts, getReferences, getApprovedShapeSheets,
} from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function CreatePage() {
  const [products, talents, poses, sizes, preservations, expressions, recentCuts, references, aiSheets] = await Promise.all([
    getProducts(),
    getTalents(),
    getPoseRefs(),
    getSizePresets(),
    getPreservationModes(),
    getExpressions(),
    getCuts({ limit: 400 }),
    getReferences(4000),
    getApprovedShapeSheets(),
  ]);

  /*
   * 완성한 배너도 생성 소재로 쓸 수 있게 보관함에 합친다.
   * "이 배너 느낌으로", "이 배너 배경 위에" 같은 요청이 실제로 들어와서,
   * 배너를 다시 찾아 올리는 수고를 없앤다. 분류는 기존 '배너' 안에,
   * 하위 칩 '내가 만든 배너' 로 갈라 두어 업로드한 배너 레퍼와 섞이지 않게 한다.
   */
  const madeBanners = await getCuts({ source: 'imgcreate', provider: 'design', limit: 120 });
  const bannerRefs = madeBanners
    .filter((c) => c.url)
    .map((c) => ({
      url: c.url,
      title: c.title || '배너',
      width: c.width ?? 0,
      height: c.height ?? 0,
      category: 'banner' as const,
      sub: '내가 만든 배너',
      tags: [] as string[],
      source: 'design',
      createdAt: c.createdAt ? String(c.createdAt) : null,
    }));

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
          ⚠ <b>GPT 엔진 사용 기준</b> — GPT(gpt-image-1)는 전속 모델 <b>얼굴</b>이 유지되지 않고, <b>제품 형태도 참조대로 그리지 못합니다</b>
          (실측 2026-09-14: AI 생성 제품 칸을 넣어도 맥스·라운저가 다른 의자로 생성됨).
          제품 컷도 GPT로 만들 수 있지만 <b>결과의 제품 모양을 꼭 확인</b>하세요 — 제미나이 한도가 막혔을 때의 대안으로 쓰는 것을 권합니다.
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
      aiSheets={aiSheets}
      references={[...bannerRefs, ...references]}
      promptMode={(process.env.PROMPT_MODE || 'opus') === 'opus' && process.env.ANTHROPIC_API_KEY ? 'opus' : 'local'}
      /* 넘기기 버튼은 로컬 전용 — MD 화면에 나올 기능이 아니다 */
      gptEnabled={Boolean(process.env.OPENAI_API_KEY)}
      localMode={process.env.NODE_ENV !== 'production'}
    />
    </>
  );
}
