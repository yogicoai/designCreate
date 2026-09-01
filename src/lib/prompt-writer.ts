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

export type RefKind = 'base' | 'style' | 'background' | 'shape' | 'pose' | 'usage' | 'talent' | 'outfit' | 'product' | 'swatch';

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
  /** 인물 시트일 때 몇 번째 사람인지 (1-base, 왼쪽부터) */
  personIndex?: number;
  /** 인물 참조의 종류 — rep(대표컷) / expr(요청 표정 한 칸) / sheet(8칸 시트 폴백) */
  sub?: 'rep' | 'expr' | 'sheet';
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

/**
 * 업로드한 레퍼런스가 하는 일.
 *  style      — 조명·색감·분위기만 참고. 장면은 새로 그린다.
 *  base       — 이 이미지를 캔버스로 삼고 지정한 것만 바꾼다 (얼굴 교체·인물 합성).
 *  background — 배경·공간만 가져오고 인물과 제품은 우리 자산으로 채운다.
 */
export type RefRole = 'style' | 'base' | 'background';

export interface UploadedRefSpec {
  url: string;
  title: string;
  role: RefRole;
}

/** role=base 일 때 무엇을 바꿀지 */
export type EditTarget = 'face' | 'person' | 'add-person' | 'outfit' | 'product-color' | 'background' | 'text-removal';

const EDIT_TARGET_EN: Record<EditTarget, string> = {
  face: 'replace ONLY the face and hair of each specified person with the supplied model identity — keep body, pose, outfit, product and background untouched',
  person: 'replace each specified person entirely with the supplied model (face, hair, body proportions and outfit) while keeping their pose, the products and the background exactly as they are',
  // 사진에 사람이 없을 때 — 인물을 새로 합성해 앉힌다 (기존 가구·공간은 그대로)
  'add-person': 'ADD the specified people into the scene, seated naturally on the bean bags already in the photo — one person per seat, counting seats from the LEFT. The bean bags in the photo ARE the product being advertised: keep their shape, fabric texture, colour and position exactly as photographed — do not replace, recolour, move or add any furniture. The fabric must visibly compress and dent under each body; shadows, perspective and colour temperature must match the photo so the people look photographed in place, not pasted',
  outfit: 'change only the clothing to the specified outfit — keep the face, hair, pose, product and background untouched',
  'product-color': 'recolour only the product to the specified official colour, keeping its existing shading, folds and highlights',
  background: 'replace only the background and surrounding space — keep the people and the product exactly as they are',
  'text-removal': 'remove all overlaid text, badges, price tags and logos, reconstructing the surface beneath them cleanly',
};

export interface TalentSpec {
  code: string;
  category: string;
  slot: string;
  /** 영문 아이덴티티 — 프롬프트에 그대로 들어간다 */
  identityEn: string;
  /** 영문 체형 서술 (제품 대비 상대 크기 포함) */
  sizeEn: string;
  /**
   * 대표컷 — 자연스러운 미소의 단일 대형 초상 (승인본).
   * 무표정 턴어라운드 시트는 참조로 넣지 않는다: 표정 없는 다각도 시트가 들어가면
   * 결과 얼굴이 굳거나 흔들린다 (기존 팀 규칙 + 실사용 피드백).
   */
  repShot?: string;
  /** 요청한 표정 한 칸만 잘라낸 표정컷 — 있으면 8칸 시트 대신 이걸 쓴다 */
  expressionCrop?: string;
  exprSheet?: string;
  /** 사용할 표정 패널 */
  expression?: { kr: string; en: string };
  outfit?: { code: string; desc: string; descEn: string; cropUrl?: string };
}

export interface GenerationSpec {
  /** thumbnail = 제품 썸네일(텍스트 없음) / banner = 배너(카피 자리 확보) */
  mode: 'thumbnail' | 'banner';

  /** 베이스 컷 — 우리 자산 중 확정된 컷. 있으면 가장 강한 앵커. */
  baseCut?: {
    url: string; spec: string; line: string; colorName: string;
    /**
     * full = 이 컷을 그대로 재현하고 지정한 것만 교체 (포토에딧)
     * pose = 포즈·앵글·눌림만 빌리고 제품·컬러·모델은 아래 지정을 따른다
     */
    usage?: 'full' | 'pose';
  };

  /** 사용자가 올린 레퍼런스 */
  uploadedRefs?: UploadedRefSpec[];
  /** 업로드 레퍼런스를 얼마나 살릴지 */
  preservation?: { value: string; label: string; instruction: string };
  /** 업로드 base 에서 무엇을 바꿀지 */
  editTargets?: EditTarget[];

  /** 제품 형태 레퍼 (모델 제거본) */
  shapeRef?: { url: string; name: string };
  /** 포즈·각도 레퍼 (모델 포함본) */
  poseRef?: { url: string; name: string };
  /** 제품 연출컷 */
  usageShot?: { url: string; kindEn: string; kindKr: string };

  /** 등장 인물 — 여러 명이면 **사진 왼쪽부터** person 1, 2, 3… 순서로 배정 */
  talents?: TalentSpec[];

  /** 제품 */
  product?: {
    line: string;
    shape: string;
    negative: string;
    modes: string;
    dims: { w?: number; d?: number; h?: number; weight?: number };
    scalePrompt: string;
    color?: { name: string; nameEn: string; hex: string };
    /** product_items.notes 의 "연출:" 영문 지침 — 있으면 modes 대신 쓴다 (실제 판매 데이터 기준) */
    staging?: string;
    /**
     * 공식 제품 뷰 (360에서 뽑은 단일 각도 실사) — 형태·비례 앵커의 정본.
     * colorMatched=false 면 같은 라인의 다른 색 뷰(형태만 참고, 색은 스와치가 잡는다).
     */
    views?: { angle: string; url: string; colorMatched: boolean }[];
  };

  size: SizeSpec;

  /** 변형 축 (카메라/포즈/인물/조명/시나리오) — 영문 힌트만 쓴다 */
  variations?: { axis: string; label: string; hint: string }[];

  /** MD 가 한글로 적은 방향 지시 */
  direction?: string;

  /** 활성화된 전 컷 공통 규칙 (영문) */
  houseRules?: string[];
}

/**
 * 참조 상한. 나노바나나 Pro 는 여러 장을 받지만 무한정 넣으면 각 참조의 영향력이 희석된다.
 * 다인 구성(모델 4명 = 시트 4장) + 베이스 + 스와치까지 감당하려면 8장은 필요하다.
 */
/**
 * 참조 상한 — 나노바나나 Pro 의 참조 한도(14).
 * 예전 8장은 Vercel 4.5MB 를 의식한 값이었으나 그 한도는 브라우저→우리 서버 요청에만
 * 걸린다. 서버→Gemini 호출은 별개라 인물 3~4명 × (대표컷+표정컷) 도 여유 있다.
 */
const MAX_REFS = 14;

/**
 * 참조 이미지 목록을 우선순위대로 만든다.
 * 베이스(우리 컷 → 업로드 base → 배경) > 스타일 > 형태/포즈/연출 > 인물 시트(순서 유지) > 컬러 스와치
 */
export function buildReferences(spec: GenerationSpec): RefSlot[] {
  const slots: RefSlot[] = [];
  const uploads = spec.uploadedRefs ?? [];
  const bases = uploads.filter((u) => u.role === 'base');
  const backgrounds = uploads.filter((u) => u.role === 'background');
  const styles = uploads.filter((u) => u.role === 'style');

  if (spec.baseCut) {
    slots.push({
      kind: 'base',
      title: `${spec.baseCut.usage === 'pose' ? '포즈 소스' : '베이스 컷'} · ${spec.baseCut.line} ${spec.baseCut.colorName}`,
      url: spec.baseCut.url,
      role: spec.baseCut.usage === 'pose'
        ? 'a POSE reference from our own approved catalogue — copy ONLY the body pose, limb placement, camera angle, framing and how the fabric compresses under the body. Do NOT copy its product colour, its model identity or its outfit; those are specified separately below'
        : 'the base photograph — reproduce its camera angle, pose, product shape and compression, lighting and framing exactly',
    });
  }
  for (const u of bases) {
    slots.push({
      kind: 'base',
      title: `베이스 · ${u.title}`,
      url: u.url,
      role: 'the base photograph to edit — keep it as-is and change only what is specified below',
    });
  }
  for (const u of backgrounds) {
    slots.push({
      kind: 'background',
      title: `배경 · ${u.title}`,
      url: u.url,
      role: 'the background and setting to reproduce — same space, architecture, lighting direction and colour temperature',
    });
  }
  for (const u of styles) {
    slots.push({
      kind: 'style',
      title: `레퍼런스 · ${u.title}`,
      url: u.url,
      role: 'a style reference — match its lighting, colour temperature, materials, prop density and overall mood',
    });
  }

  /*
   * 모델 아이덴티티 참조 — 검증된 5원칙 "얼굴시트 최우선 배치".
   * 얼굴 턴어라운드(5패널, 얼굴 큼)가 1순위, 표정 시트가 2순위.
   * 1~2인이면 인당 2장, 3인 이상이면 슬롯 예산상 인당 1장(얼굴 시트 우선).
   */
  const talents = spec.talents ?? [];
  talents.forEach((t, i) => {
    const multi = talents.length > 1;
    const who = multi ? `PERSON ${i + 1} (counting people from the LEFT of the base image)` : 'the model';
    const n = multi ? `${i + 1} ` : '';
    const ident: { url?: string; title: string; role: string; sub: 'rep' | 'expr' | 'sheet' }[] = [
      {
        url: t.repShot,
        sub: 'rep',
        title: `대표컷 ${n}· ${t.category} ${t.slot}`,
        role: `the PRIMARY identity reference for ${who} — an approved portrait of ONE model; treat it as ground truth for face construction, eye/nose/lip shape, skin tone, hairline and hairstyle`,
      },
      // 요청 표정 한 칸 (있으면) — 없으면 8칸 시트로 폴백
      t.expressionCrop
        ? {
            url: t.expressionCrop,
            sub: 'expr',
            title: `표정컷 ${n}· ${t.category} ${t.slot}${t.expression ? ` · ${t.expression.kr}` : ''}`,
            role: `the SAME person as the previous image, showing EXACTLY the expression to use for ${who} — copy this facial expression precisely while keeping the identity identical`,
          }
        : {
            url: t.exprSheet,
            sub: 'sheet',
            title: `표정 시트 ${n}· ${t.category} ${t.slot}`,
            role: `the expression reference for ${who} — the SAME model in 8 expressions; pick the requested expression panel while keeping the identity identical`,
          },
    ];
    for (const r of ident) {
      if (!r.url) continue;
      slots.push({ kind: 'talent', title: r.title, url: r.url, personIndex: i + 1, role: r.role, sub: r.sub });
    }
  });

  // 베이스가 이미 있으면 형태·포즈 레퍼는 중복이라 넣지 않는다 (참조 과다는 오히려 흐려진다)
  /*
   * 포즈만 빌리는 경우(baseCut.usage==='pose')는 "베이스가 있다"로 치지 않는다.
   * 그 컷은 자세만 주는 것이라, 제품 형태·색 앵커(공식 뷰·형태 레퍼)가 여전히 필요하다.
   */
  const hasBase = (!!spec.baseCut && spec.baseCut.usage !== 'pose') || bases.length > 0;
  if (!hasBase) {
    if (spec.poseRef) {
      slots.push({
        kind: 'pose',
        title: `포즈 레퍼 · ${spec.poseRef.name}`,
        url: spec.poseRef.url,
        role: 'the pose, seating angle and camera viewpoint to reproduce — match how the body sinks into the product',
      });
    }
    if (spec.shapeRef) {
      slots.push({
        kind: 'shape',
        title: `형태 레퍼 · ${spec.shapeRef.name}`,
        url: spec.shapeRef.url,
        role: 'the exact product silhouette and compression — reproduce this three-dimensional shape, including how high the backrest rises and how deeply the body has dented it',
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

    // 공식 제품 뷰 — 형태가 어긋나는 사고의 직접 대응.
    // 눌림 레퍼는 "앉은 뒤의 변형"을, 공식 뷰는 "제품 자체의 형태·비례"를 잡는다.
    for (const v of spec.product?.views ?? []) {
      slots.push({
        kind: 'product',
        title: `제품 뷰 · ${v.angle}${v.colorMatched ? '' : ' (형태만)'}`,
        url: v.url,
        role: v.colorMatched
          ? `an official product photograph of the exact product from the ${ANGLE_EN[v.angle] ?? v.angle} — reproduce this exact three-dimensional shape, proportions and smooth seamless cover`
          : `an official product photograph showing the exact SHAPE and proportions from the ${ANGLE_EN[v.angle] ?? v.angle} — it is shown in a different colour, so take ONLY the shape; the colour comes from the swatch`,
      });
    }
  }


  // 의상 크롭 (얼굴 제거본) — 자리가 남을 때만. 원본(imageUrl)은 절대 넣지 않는다:
  // 레퍼 속 모델 얼굴이 결과에 섞이는 사고가 실측으로 확인돼 있다.
  talents.forEach((t, i) => {
    if (!t.outfit?.cropUrl) return;
    if (slots.length >= MAX_REFS - 1) return; // 스와치 자리는 남겨둔다
    slots.push({
      kind: 'outfit',
      title: `의상 크롭 · ${t.outfit.code}`,
      url: t.outfit.cropUrl,
      personIndex: i + 1,
      role:
        talents.length > 1
          ? `the outfit reference for PERSON ${i + 1} — garment only (the face has been cropped out on purpose; take ONLY the clothing design and colours from it)`
          : 'the outfit reference — garment only (the face has been cropped out on purpose; take ONLY the clothing design and colours from it)',
    });
  });

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

const ORDINALS = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH'];

/** 제품 뷰 각도 → 영문 표기 */
const ANGLE_EN: Record<string, string> = {
  front: 'front view',
  side: 'side view',
  back: 'back view',
  a045: '45-degree three-quarter view',
  a135: '135-degree rear three-quarter view',
  a225: '225-degree rear three-quarter view',
  a270: '270-degree side view',
  a315: '315-degree three-quarter view',
};

function describeRefs(refs: RefSlot[]): string {
  return refs.map((r, i) => `The ${ORDINALS[i]} image is ${r.role}.`).join('\n');
}

/** 사이즈별 구도 지시 — 배너 모드에서만 카피 자리를 비운다 */
function compositionFor(spec: GenerationSpec): string {
  const { width, height } = spec.size;
  const r = height ? width / height : 1;
  if (spec.mode === 'thumbnail') {
    if (r >= 1.3) return `WIDE PRODUCT SHOT (${width}x${height}). Centre the product and model; keep generous even margin on both sides.`;
    if (r >= 0.95) return `SQUARE PRODUCT THUMBNAIL (${width}x${height}). The product and model fill the frame with even margin — this is a catalogue thumbnail, so the product must read clearly at small size.`;
    return `TALL PRODUCT SHOT (${width}x${height}). Vertical framing; the product fills the lower two thirds.`;
  }
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
  const colorEn = p.color?.nameEn || p.color?.name || '';
  L.push(`PRODUCT — Yogibo ${p.line}${colorEn ? ` (${colorEn})` : ''}.`);
  L.push(`SHAPE: ${p.shape}.`);
  const d = p.dims ?? {};
  const dims = [d.w && `${d.w}cm wide`, d.d && `${d.d}cm deep`, d.h && `${d.h}cm tall/long`].filter(Boolean).join(' x ');
  if (dims) L.push(`EXACT SIZE: ${dims}${d.weight ? `, ${d.weight}kg` : ''}.`);
  if (p.scalePrompt) L.push(`SCALE ANCHOR: ${p.scalePrompt}.`);
  L.push(`NEGATIVE: ${p.negative}.`);
  if (p.color?.hex) L.push(`COLOUR: ${colorEn} (${p.color.hex}) — exact, must not drift toward a neighbouring hue.`);
  L.push(`USE: ${p.staging || p.modes}.`);
  return L;
}

/** 인물 블록 — 여러 명이면 사진 왼쪽부터 PERSON 1/2/3 */
function talentBlock(spec: GenerationSpec, refs: RefSlot[]): string[] {
  const talents = spec.talents ?? [];
  if (!talents.length) return [];
  const L: string[] = [];
  const multi = talents.length > 1;

  if (multi) {
    L.push(
      `PEOPLE — exactly ${talents.length} people, assigned by position COUNTING FROM THE LEFT of the frame. ` +
        'No extra people, no background bystanders, no duplicated faces.',
    );
  }

  talents.forEach((t, i) => {
    const head = multi ? `PERSON ${i + 1} (${i === 0 ? 'leftmost' : `${ORDINALS[i].toLowerCase()} from left`})` : 'MODEL';
    // 이 인물의 시트가 몇 번째 참조인지 명시한다 — 다인에서 얼굴이 섞이는 걸 막는 핵심
    const slotIdxs = refs
      .map((r, idx) => (r.kind === 'talent' && r.personIndex === i + 1 ? idx : -1))
      .filter((idx) => idx >= 0);
    const sheetRef = slotIdxs.length
      ? ` — identity from the ${slotIdxs.map((idx) => ORDINALS[idx]).join(' and ')} image${slotIdxs.length > 1 ? 's' : ''}`
      : '';
    L.push(`${head}${sheetRef}: ${t.identityEn}.`);
    L.push(`  BODY: ${t.sizeEn}.`);
    if (t.expression) {
      const exprIdx = refs.findIndex((r) => r.kind === 'talent' && r.personIndex === i + 1 && r.sub === 'expr');
      const sheetIdx = refs.findIndex((r) => r.kind === 'talent' && r.personIndex === i + 1 && r.sub === 'sheet');
      if (exprIdx >= 0) L.push(`  EXPRESSION: ${t.expression.en} — match the expression in the ${ORDINALS[exprIdx]} image exactly.`);
      else if (sheetIdx >= 0) L.push(`  EXPRESSION: ${t.expression.en} — use that panel from the expression sheet (the ${ORDINALS[sheetIdx]} image).`);
      else L.push(`  EXPRESSION: ${t.expression.en}.`);
    }
    if (t.outfit) L.push(`  OUTFIT: ${t.outfit.descEn || t.outfit.desc} (${t.outfit.code}), barefoot unless stated otherwise.`);
  });

  if (multi) {
    L.push(
      'Each person keeps their own distinct identity from their own reference sheet — never blend faces between people, never give two people the same face.',
    );
  }
  L.push(
    'FACE MATCH: the identity sheets are ground truth. The rendered face must be recognisably the SAME person — same bone structure, eye shape, nose, lips, hairline. Do not beautify, de-age, or drift toward a generic face.',
  );
  return L;
}

/** 업로드 base 편집 지시 */
function editBlock(spec: GenerationSpec): string[] {
  const targets = spec.editTargets ?? [];
  if (!targets.length) return [];
  const L: string[] = [];
  L.push('EDIT — change ONLY the following, and leave everything else pixel-faithful to the base image:');
  for (const t of targets) L.push(`  - ${EDIT_TARGET_EN[t] ?? t}`);
  return L;
}

/** 결정론적 템플릿 조립 — 무과금 경로 */
export function buildPromptLocal(spec: GenerationSpec, refs: RefSlot[]): string {
  const L: string[] = [];
  const uploads = spec.uploadedRefs ?? [];
  const hasUploadBase = uploads.some((u) => u.role === 'base');
  const hasBackground = uploads.some((u) => u.role === 'background');

  L.push(describeRefs(refs));
  L.push('');

  if (spec.baseCut?.usage === 'pose') {
    L.push(
      'Use the pose reference ONLY for body pose, limb placement, camera angle, framing and fabric compression. ' +
        'The product, its colour, the model identity and the outfit all come from the specifications below — ' +
        'do not inherit them from that image.',
    );
    L.push('');
  } else if (spec.baseCut || hasUploadBase) {
    L.push(
      'Reproduce the base photograph EXACTLY — same camera angle, same poses, same body positions and limb placement, ' +
        'same product shapes and compression, same lighting, same background, same framing and crop. ' +
        'Change ONLY what is specified below. Everything unspecified must stay pixel-faithful to the base.',
    );
    L.push('');
  } else if (hasBackground) {
    L.push(
      'Reproduce the supplied background exactly — same space, same architecture, same lighting direction and colour temperature — ' +
        'then place the product and people described below into that space, lit consistently with it. ' +
        'REMOVE or replace any existing seating (bean bags, sofas, cushions) that competes with the specified product; ' +
        'the specified product must be the only seating in frame.',
    );
    L.push('');
  }

  const eb = editBlock(spec);
  if (eb.length) { L.push(...eb); L.push(''); }

  if (spec.preservation?.instruction) {
    L.push(spec.preservation.instruction.trim());
    L.push('');
  }

  const pb = productBlock(spec);
  if (pb.length) { L.push(...pb); L.push(''); }

  const tb = talentBlock(spec, refs);
  if (tb.length) { L.push(...tb); L.push(''); }

  L.push(compositionFor(spec));

  if (spec.size.retention < 0.97) {
    const keepPct = Math.max(50, Math.round(spec.size.retention * 100) - 6); // 여유 6%p
    const axis = spec.size.cropAxis === 'vertical' ? 'height' : 'width';
    const edges = spec.size.cropAxis === 'vertical' ? 'top and bottom edges' : 'left and right edges';
    L.push(
      `CROP-SAFE FRAMING (critical): the delivered image is cropped from ${spec.size.genAspect} down to ` +
        `${spec.size.width}x${spec.size.height} — only the central ${Math.round(spec.size.retention * 100)}% of the ${axis} survives. ` +
        `Keep EVERY person — including full heads with clear space above the hair — and the entire product inside the central ${keepPct}% ${axis} band. ` +
        `Nothing important may touch the ${edges}. Never place a standing person's head near the top edge; ` +
        `if space is tight, make the people SMALLER rather than letting anything be cut off.`,
    );
  }
  // 크롭이 없어도 머리 잘림은 절대 금지 — 상단 여백은 항상 확보한다
  L.push('HEADROOM: every head must be fully inside the frame with visible margin above the hair. Never crop a head, hand or foot at any edge.');

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
  L.push(
    spec.mode === 'thumbnail'
      ? 'ABSOLUTELY NO TEXT: no typography, no Korean or English lettering, no numbers, no badges, no price tags, no logos, no watermarks. Photorealistic commercial product photography only.'
      : 'ABSOLUTELY NO TEXT: Korean copy will be overlaid later in a separate editing step, so the image must contain no typography, no lettering, no numbers, no CTA button, no badges and no watermarks.',
  );

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

  if (spec.baseCut) {
    L.push(
      spec.baseCut.usage === 'pose'
        ? `포즈 소스(우리 승인 컷) — 포즈·앵글·눌림만 가져오고 제품/컬러/모델/의상은 아래 지정을 따른다: ${spec.baseCut.spec}`
        : `베이스 컷 원문 스펙: ${spec.baseCut.spec}`,
    );
  }
  const eb = editBlock(spec);
  if (eb.length) { L.push(''); L.push('편집 지시 (이것만 바꾸고 나머지는 원본 그대로 — 가장 강하게 반영할 것):'); L.push(...eb.map((x) => '  ' + x)); }
  if (spec.preservation) { L.push(''); L.push(`레퍼런스 보존 강도: ${spec.preservation.label}`); L.push(spec.preservation.instruction); }

  const pb = productBlock(spec);
  if (pb.length) { L.push(''); L.push('제품 정보 (실측으로 확립된 값 — 그대로 써야 함):'); L.push(...pb.map((x) => '  ' + x)); }

  const tb = talentBlock(spec, refs);
  if (tb.length) { L.push(''); L.push('인물 정보 (여러 명이면 사진 왼쪽부터 순서 배정):'); L.push(...tb.map((x) => '  ' + x)); }

  const vars = (spec.variations ?? []).filter((v) => v.hint);
  if (vars.length) { L.push(''); L.push('연출 옵션: ' + vars.map((v) => `${v.label}(${v.hint})`).join(', ')); }
  if (spec.direction) { L.push(''); L.push(`MD 의 방향 지시 (한글): ${spec.direction}`); }
  if (spec.houseRules?.length) { L.push(''); L.push('전 컷 공통 규칙 (반드시 프롬프트에 반영):'); L.push(...spec.houseRules.map((r) => '  - ' + r)); }

  return L.join('\n');
}

const OPUS_SYSTEM = `너는 요기보(빈백 소파 브랜드) 자사몰의 AI 이미지 생성 프롬프트를 쓰는 전문가다.
결과물은 Gemini 이미지 모델(나노바나나)에 그대로 들어가는 **영문 프롬프트 한 덩어리**다.

지켜야 할 것:
1. 첨부된 참조 이미지를 실제로 보고 써라. 특히 사용자가 올린 레퍼런스는 조명 방향·색온도·
   벽/바닥 재질·소품 밀도·카메라 높이를 눈으로 읽어서 구체적인 영문 서술로 옮겨라.
   "match the reference" 같은 게으른 문장 대신, 무엇을 매치해야 하는지 적어라.
2. 브리프의 제품 수치·기하 서술·네거티브는 실측으로 확립된 값이다. 요약하거나 바꾸지 말고 그대로 실어라.
   카테고리 단어("beanbag")로 제품을 지칭하면 안 된다 — 기하 서술을 써야 한다.
3. 참조 이미지는 브리프에 적힌 순서대로 FIRST/SECOND/THIRD... 로 지칭하라. 순서를 바꾸면 안 된다.
4. 인물이 여러 명이면 사진 왼쪽부터 PERSON 1/2/3 으로 배정하고, 각 사람이 어느 시트의 얼굴인지
   명시하고, 얼굴이 섞이지 않게 못박아라.
5. 편집 지시(EDIT)가 있으면 "이것만 바꾸고 나머지는 원본 그대로"를 가장 앞에, 가장 강하게 써라.
6. 전 컷 공통 규칙은 빠짐없이 반영하라.
7. 텍스트·로고·워터마크 금지 문장을 마지막에 반드시 넣어라.

출력은 영문 프롬프트 본문만. 설명·머리말·코드펜스 없이 프롬프트 텍스트만 출력하라.`;

export interface WriteResult {
  prompt: string;
  refs: RefSlot[];
  mode: 'local' | 'opus';
  usage?: { input_tokens: number; output_tokens: number };
}

/**
 * 프롬프트를 만든다. PROMPT_MODE=opus 이고 키가 있으면 Opus 가 쓰고, 아니면 템플릿으로 조립한다.
 * Opus 호출이 실패하면 템플릿으로 떨어진다 — 프롬프트를 못 만들어 생성이 막히는 것이 가장 나쁘다.
 */
export async function writePrompt(spec: GenerationSpec): Promise<WriteResult> {
  const refs = buildReferences(spec);
  const wantOpus = (process.env.PROMPT_MODE || 'local') === 'opus' && !!process.env.ANTHROPIC_API_KEY;

  if (!wantOpus) return { prompt: buildPromptLocal(spec, refs), refs, mode: 'local' };

  try {
    const client = new Anthropic();
    // 참조는 전부 공개 URL 이라 URL 소스로 그대로 넘긴다 (base64 인코딩 불필요).
    const imageBlocks = refs
      .filter((r) => r.url)
      .map((r) => ({ type: 'image' as const, source: { type: 'url' as const, url: r.url! } }));

    const res = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: OPUS_SYSTEM,
      messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: specToBrief(spec, refs) }] }],
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
