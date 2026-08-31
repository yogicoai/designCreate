import 'server-only';
import Anthropic from '@anthropic-ai/sdk';

/**
 * 생성 프롬프트 작성기.
 *
 * 두 모드가 같은 입력을 받는다:
 *   local — 결정론적 템플릿 조립. 무과금. 로컬 개발·API 장애 시 안전망.
 *   opus  — Claude Opus 가 레퍼런스 이미지를 실제로 보고 프롬프트를 쓴다. 라이브용.
 *
 * 참조 이미지의 **순서**가 프롬프트의 FIRST/SECOND/THIRD 와 반드시 일치해야 한다.
 * 그래서 참조 목록과 프롬프트를 따로 만들지 않고 여기서 함께 만든다.
 */

export type RefKind = 'base' | 'style' | 'shape' | 'pose' | 'usage' | 'talent' | 'swatch';

export interface RefSlot {
  kind: RefKind;
  /** 화면 표시용 이름 */
  title: string;
  /** 이미지 URL. swatchHex 가 있으면 비어 있다. */
  url?: string;
  /** 단색 스와치로 만들 hex */
  swatchHex?: string;
  /** 이 참조가 담당하는 역할 (영문 — 프롬프트에 들어간다) */
  role: string;
}

export interface SizeSpec {
  width: number;
  height: number;
  /** 나노바나나에 넘길 비율 */
  genAspect: string;
  /** 생성물에서 살아남는 비율 (1 = 손실 없음) */
  retention: number;
  cropAxis: 'vertical' | 'horizontal' | 'none';
  label: string;
}

export interface GenerationSpec {
  /** thumbnail = 제품 썸네일(텍스트 없음) / banner = 배너(카피 자리 확보) */
  mode: 'thumbnail' | 'banner';

  /** 베이스 컷 — 있으면 가장 강한 앵커. 이게 있으면 "포토에딧" 경로. */
  baseCut?: { url: string; spec: string; line: string; colorName: string };

  /** 사용자가 올린 레퍼런스 (스타일·분위기 소스) */
  uploadedRefs?: { url: string; title: string }[];
  /** 업로드 레퍼런스를 얼마나 살릴지 */
  preservation?: { value: string; label: string; instruction: string };

  /** 제품 형태 레퍼 (모델 제거본) */
  shapeRef?: { url: string; name: string };
  /** 포즈·각도 레퍼 (모델 포함본) */
  poseRef?: { url: string; name: string };
  /** 제품 연출컷 */
  usageShot?: { url: string; kindEn: string; kindKr: string };

  /** 전속 모델 */
  talent?: {
    code: string;
    category: string;
    slot: string;
    identity: string;
    size: string;
    exprSheet?: string;
    /** 사용할 표정 패널 */
    expression?: string;
    outfit?: { code: string; desc: string };
  };

  /** 제품 */
  product?: {
    line: string;
    shape: string;
    negative: string;
    modes: string;
    dims: { w?: number; d?: number; h?: number; weight?: number };
    scalePrompt: string;
    color?: { name: string; hex: string };
  };

  size: SizeSpec;

  /** 변형 축 (카메라/포즈/인물/조명/시나리오) — 영문 힌트만 쓴다 */
  variations?: { axis: string; label: string; hint: string }[];

  /** MD 가 한글로 적은 방향 지시 */
  direction?: string;

  /** 활성화된 전 컷 공통 규칙 (영문) */
  houseRules?: string[];
}

/** 참조는 많다고 좋지 않다. 우선순위 높은 것부터 5장까지만. */
const MAX_REFS = 5;

/**
 * 참조 이미지 목록을 우선순위대로 만든다.
 * 베이스 컷 > 업로드 레퍼런스 > 형태/포즈/연출 > 모델 시트 > 컬러 스와치
 */
export function buildReferences(spec: GenerationSpec): RefSlot[] {
  const slots: RefSlot[] = [];

  if (spec.baseCut) {
    slots.push({
      kind: 'base',
      title: `베이스 컷 · ${spec.baseCut.line} ${spec.baseCut.colorName}`,
      url: spec.baseCut.url,
      role: 'the base photograph — reproduce its camera angle, pose, product shape and compression, lighting and framing exactly',
    });
  }

  for (const r of spec.uploadedRefs ?? []) {
    slots.push({
      kind: 'style',
      title: `레퍼런스 · ${r.title}`,
      url: r.url,
      role: 'a style reference — match its lighting, colour temperature, materials, prop density and overall mood',
    });
  }

  // 베이스 컷이 있으면 형태·포즈는 중복이라 넣지 않는다 (참조 과다는 오히려 흐려진다)
  if (!spec.baseCut) {
    if (spec.poseRef) {
      slots.push({
        kind: 'pose',
        title: `포즈 레퍼 · ${spec.poseRef.name}`,
        url: spec.poseRef.url,
        role: 'the pose and camera angle to reproduce — match the body position and viewpoint',
      });
    }
    if (spec.shapeRef) {
      slots.push({
        kind: 'shape',
        title: `형태 레퍼 · ${spec.shapeRef.name}`,
        url: spec.shapeRef.url,
        role: 'the exact product shape and compression — a bean bag already dented and shaped by a body',
      });
    }
    if (spec.usageShot) {
      slots.push({
        kind: 'usage',
        title: `연출컷 · ${spec.usageShot.kindKr}`,
        url: spec.usageShot.url,
        role: `an official product staging shot showing ${spec.usageShot.kindEn}`,
      });
    }
  }

  if (spec.talent?.exprSheet) {
    slots.push({
      kind: 'talent',
      title: `모델 시트 · ${spec.talent.category} ${spec.talent.slot}`,
      url: spec.talent.exprSheet,
      role: 'a reference sheet of ONE model in 8 expressions — use her exact face construction, features, skin tone and hairstyle',
    });
  }

  if (spec.product?.color?.hex) {
    slots.push({
      kind: 'swatch',
      title: `컬러 스와치 · ${spec.product.color.name}`,
      swatchHex: spec.product.color.hex,
      role: `the exact official colour swatch (${spec.product.color.hex}) — match this hue, saturation and darkness precisely`,
    });
  }

  return slots.slice(0, MAX_REFS);
}

const ORDINALS = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH'];

/** 참조 목록을 "The FIRST image is ..." 문장들로 */
function describeRefs(refs: RefSlot[]): string {
  return refs.map((r, i) => `The ${ORDINALS[i]} image is ${r.role}.`).join('\n');
}

/** 사이즈별 구도 지시 — 배너 모드에서만 카피 자리를 비운다 */
function compositionFor(spec: GenerationSpec): string {
  const { width, height } = spec.size;
  const r = width / height;
  if (spec.mode === 'thumbnail') {
    if (r >= 1.3) return `WIDE PRODUCT SHOT (${width}x${height}). Centre the product and model; keep generous even margin on both sides.`;
    if (r >= 0.95) return `SQUARE PRODUCT THUMBNAIL (${width}x${height}). The product and model fill the frame with even margin — this is a catalogue thumbnail, so the product must read clearly at small size.`;
    return `TALL PRODUCT SHOT (${width}x${height}). Vertical framing; the product fills the lower two thirds.`;
  }
  // banner — 카피가 나중에 얹히므로 자리를 비워둔다
  if (r >= 2.5) {
    return `EXTREME WIDE BANNER (${width}x${height}). Place the product and model in the RIGHT third. The LEFT half must be an empty, uncluttered wall/floor plane. Keep every essential element inside the vertical middle band — the top and bottom will be cropped away.`;
  }
  if (r >= 1.6) {
    return `WIDE WEB BANNER (${width}x${height}). Split composition: the LEFT 45% stays clean and empty for copy, product and model occupy the RIGHT side.`;
  }
  if (r >= 0.95) {
    return `SQUARE SNS POST (${width}x${height}). Subject and product sit in the LOWER TWO THIRDS, centred slightly off-axis. The TOP THIRD stays a quiet, evenly lit area for copy.`;
  }
  return `TALL MOBILE FORMAT (${width}x${height}). The TOP third stays clean and empty for copy; the product and model fill the LOWER two thirds.`;
}

/** 제품 블록 — 12차 실측 4종 세트 */
function productBlock(spec: GenerationSpec): string[] {
  const p = spec.product;
  if (!p) return [];
  const L: string[] = [];
  L.push(`PRODUCT — Yogibo ${p.line}${p.color?.name ? ` (${p.color.name})` : ''}.`);
  L.push(`SHAPE: ${p.shape}.`);
  const d = p.dims ?? {};
  const dims = [d.w && `${d.w}cm wide`, d.d && `${d.d}cm deep`, d.h && `${d.h}cm tall/long`].filter(Boolean).join(' x ');
  if (dims) L.push(`EXACT SIZE: ${dims}${d.weight ? `, ${d.weight}kg` : ''}.`);
  if (p.scalePrompt) L.push(`SCALE ANCHOR: ${p.scalePrompt}.`);
  L.push(`NEGATIVE: ${p.negative}.`);
  if (p.color?.hex) {
    L.push(`COLOUR: ${p.color.name} (${p.color.hex}) — exact, must not drift toward a neighbouring hue.`);
  }
  L.push(`USE: ${p.modes}.`);
  return L;
}

/** 모델 블록 */
function talentBlock(spec: GenerationSpec): string[] {
  const t = spec.talent;
  if (!t) return [];
  const L: string[] = [];
  L.push(`MODEL — ${t.identity}`);
  L.push(`BODY: ${t.size}. Her scale against the product must be consistent with these measurements.`);
  if (t.expression) L.push(`EXPRESSION: use the "${t.expression}" panel from the expression sheet.`);
  if (t.outfit) L.push(`OUTFIT: ${t.outfit.desc} (${t.outfit.code}). Barefoot unless stated otherwise.`);
  return L;
}

/** 결정론적 템플릿 조립 — 무과금 경로 */
export function buildPromptLocal(spec: GenerationSpec, refs: RefSlot[]): string {
  const L: string[] = [];

  L.push(describeRefs(refs));
  L.push('');

  if (spec.baseCut) {
    // 포토에딧 경로 — 실측에서 가장 성공률이 높았던 방식
    L.push(
      'Reproduce the FIRST image EXACTLY — same camera angle, same pose, same body position and limb placement, ' +
        'same bean bag shape and compression, same lighting, same background, same framing and crop. ' +
        'Change ONLY what is specified below. Everything unspecified must stay pixel-faithful to the FIRST image.',
    );
    L.push('');
  }

  if (spec.preservation?.instruction) {
    L.push(spec.preservation.instruction.trim());
    L.push('');
  }

  const pb = productBlock(spec);
  if (pb.length) { L.push(...pb); L.push(''); }

  const tb = talentBlock(spec);
  if (tb.length) { L.push(...tb); L.push(''); }

  L.push(compositionFor(spec));

  // 크롭이 심하면 미리 경고 — 안 그러면 잘라낸 뒤 구도가 무너진다
  if (spec.size.retention < 0.85) {
    L.push(
      `IMPORTANT FRAMING: the delivered image is cropped from ${spec.size.genAspect} down to ` +
        `${spec.size.width}x${spec.size.height} — only ${Math.round(spec.size.retention * 100)}% of the ` +
        `${spec.size.cropAxis === 'vertical' ? 'height' : 'width'} survives. Compose so that nothing essential sits near the ` +
        `${spec.size.cropAxis === 'vertical' ? 'top or bottom' : 'left or right'} edge.`,
    );
  }

  const vars = (spec.variations ?? []).filter((v) => v.hint);
  if (vars.length) {
    L.push('');
    L.push(`STAGING: ${vars.map((v) => v.hint).join('; ')}.`);
  }

  if (spec.direction) {
    L.push('');
    L.push(`ADDITIONAL DIRECTION (translate faithfully): ${spec.direction}`);
  }

  if (spec.houseRules?.length) {
    L.push('');
    L.push(spec.houseRules.join(' '));
  }

  L.push('');
  if (spec.mode === 'thumbnail') {
    L.push(
      'ABSOLUTELY NO TEXT: no typography, no Korean or English lettering, no numbers, no badges, no price tags, ' +
        'no logos, no watermarks. Photorealistic commercial product photography only.',
    );
  } else {
    L.push(
      'ABSOLUTELY NO TEXT: Korean copy will be overlaid later in a separate editing step, so the image must contain ' +
        'no typography, no lettering, no numbers, no CTA button, no badges and no watermarks.',
    );
  }

  return L.join('\n');
}

/** Opus 에게 넘길 구조화 입력 — 사람이 읽을 수 있는 형태여야 모델도 잘 읽는다 */
function specToBrief(spec: GenerationSpec, refs: RefSlot[]): string {
  const L: string[] = [];
  L.push(`목적: ${spec.mode === 'thumbnail' ? '자사몰 상품 썸네일 (텍스트 없는 순수 비주얼)' : '이벤트 배너 (한글 카피는 나중에 별도로 얹음)'}`);
  L.push(`규격: ${spec.size.label} — ${spec.size.width}x${spec.size.height}`);
  L.push(`생성 비율: ${spec.size.genAspect}${spec.size.retention < 1 ? ` (${spec.size.cropAxis === 'vertical' ? '세로' : '가로'} ${Math.round((1 - spec.size.retention) * 100)}% 크롭 예정)` : ''}`);
  L.push('');
  L.push('첨부한 참조 이미지 (이 순서 그대로 프롬프트에서 FIRST/SECOND/... 로 불러야 함):');
  refs.forEach((r, i) => L.push(`  ${ORDINALS[i]} — [${r.kind}] ${r.title}\n      역할: ${r.role}`));
  L.push('');

  if (spec.baseCut) L.push(`베이스 컷 원문 스펙: ${spec.baseCut.spec}`);
  if (spec.preservation) L.push(`레퍼런스 보존 강도: ${spec.preservation.label}\n${spec.preservation.instruction}`);

  const pb = productBlock(spec);
  if (pb.length) { L.push(''); L.push('제품 정보 (실측으로 확립된 값 — 그대로 써야 함):'); L.push(...pb.map((x) => '  ' + x)); }

  const tb = talentBlock(spec);
  if (tb.length) { L.push(''); L.push('모델 정보:'); L.push(...tb.map((x) => '  ' + x)); }

  const vars = (spec.variations ?? []).filter((v) => v.hint);
  if (vars.length) { L.push(''); L.push('연출 옵션: ' + vars.map((v) => `${v.label}(${v.hint})`).join(', ')); }

  if (spec.direction) { L.push(''); L.push(`MD 의 방향 지시 (한글): ${spec.direction}`); }

  if (spec.houseRules?.length) { L.push(''); L.push('전 컷 공통 규칙 (반드시 프롬프트에 반영):'); L.push(...spec.houseRules.map((r) => '  - ' + r)); }

  return L.join('\n');
}

const OPUS_SYSTEM = `너는 요기보(빈백 소파 브랜드) 자사몰의 AI 이미지 생성 프롬프트를 쓰는 전문가다.
결과물은 Gemini 이미지 모델(나노바나나)에 그대로 들어가는 **영문 프롬프트 한 덩어리**다.

지켜야 할 것:
1. 첨부된 참조 이미지를 실제로 보고 써라. 특히 사용자가 올린 스타일 레퍼런스는 조명 방향·색온도·
   벽/바닥 재질·소품 밀도·카메라 높이를 눈으로 읽어서 구체적인 영문 서술로 옮겨라.
   "match the reference" 같은 게으른 문장 대신, 무엇을 매치해야 하는지 적어라.
2. 브리프에 있는 제품 수치·기하 서술·네거티브는 실측으로 확립된 값이다. 요약하거나 바꾸지 말고 그대로 실어라.
   특히 카테고리 단어("beanbag")로 제품을 지칭하면 안 된다 — 기하 서술을 써야 한다.
3. 참조 이미지는 브리프에 적힌 순서대로 FIRST/SECOND/THIRD... 로 지칭하라. 순서를 바꾸면 안 된다.
4. 전 컷 공통 규칙은 빠짐없이 반영하라.
5. 텍스트·로고·워터마크 금지 문장을 마지막에 반드시 넣어라.

출력은 영문 프롬프트 본문만. 설명·머리말·코드펜스 없이 프롬프트 텍스트만 출력하라.`;

export interface WriteResult {
  prompt: string;
  refs: RefSlot[];
  mode: 'local' | 'opus';
  /** opus 모드일 때 사용량 */
  usage?: { input_tokens: number; output_tokens: number };
}

/**
 * 프롬프트를 만든다. PROMPT_MODE=opus 이고 키가 있으면 Opus 가 쓰고,
 * 아니면 템플릿으로 조립한다. Opus 호출이 실패하면 템플릿으로 떨어진다 —
 * 프롬프트를 못 만들어서 생성 자체가 막히는 것이 가장 나쁜 결과다.
 */
export async function writePrompt(spec: GenerationSpec): Promise<WriteResult> {
  const refs = buildReferences(spec);
  const wantOpus = (process.env.PROMPT_MODE || 'local') === 'opus' && !!process.env.ANTHROPIC_API_KEY;

  if (!wantOpus) {
    return { prompt: buildPromptLocal(spec, refs), refs, mode: 'local' };
  }

  try {
    const client = new Anthropic();
    // 참조 이미지는 전부 공개 URL 이라 URL 소스로 그대로 넘긴다 (base64 인코딩 불필요).
    // 컬러 스와치는 URL 이 없으므로 브리프의 hex 서술로만 전달된다.
    const imageBlocks = refs
      .filter((r) => r.url)
      .map((r) => ({ type: 'image' as const, source: { type: 'url' as const, url: r.url! } }));

    const res = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: OPUS_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            ...imageBlocks,
            { type: 'text', text: specToBrief(spec, refs) },
          ],
        },
      ],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (!text) throw new Error('Opus 응답이 비어 있습니다.');
    return {
      prompt: text,
      refs,
      mode: 'opus',
      usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
    };
  } catch (e) {
    console.warn('[prompt-writer] Opus 실패 — 템플릿으로 대체:', (e as Error).message);
    return { prompt: buildPromptLocal(spec, refs), refs, mode: 'local' };
  }
}
