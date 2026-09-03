import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { loadReference, colorSwatch } from './gemini';

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
  /*
   * "얼굴만 바꿔라"라고 하면 모델이 말 그대로 얼굴을 오려 붙인다 — 목 경계 단차,
   * 조명 불일치, 머리카락이 옷깃을 안 덮는 합성티가 그대로 남는다 (실사용 피드백).
   * 그래서 지시를 "사람을 통째로 다시 그리되, 입고 있던 옷을 그대로 입힌다"로 잡는다.
   */
  face: 'REPLACE each specified person\'s identity by REBUILDING the whole person as one continuous render: ' +
    'the new face and hair come from the supplied model identity, the body pose stays the same, and they wear ' +
    'the SAME outfit the base person wears — re-rendered naturally on the new person. Never paste a face onto ' +
    'the existing photo: head, neck, shoulders and hands are redrawn together, with one skin tone and the scene\'s own lighting',
  person: 'replace each specified person entirely with the supplied model (face, hair, body proportions and outfit), keeping their pose',
  // 사진에 사람이 없을 때 — 인물을 새로 합성해 앉힌다 (기존 가구·공간은 그대로)
  'add-person': 'ADD the specified people into the scene, seated naturally on the bean bags already in the photo — one person per seat, counting seats from the LEFT. The bean bags in the photo ARE the product being advertised: keep their shape, fabric texture, colour and position exactly as photographed — do not replace, recolour, move or add any furniture. The fabric must visibly compress and dent under each body; shadows, perspective and colour temperature must match the photo so the people look photographed in place, not pasted',
  outfit: 'change the clothing to the specified outfit, keeping the face, hair and pose',
  'product-color': 'recolour the product to the specified official colour, keeping its existing shape, shading, folds and highlights',
  background: 'replace the background and surrounding space, keeping the people and the products exactly where and as they are (same position, scale, perspective and contact shadows)',
  'text-removal': 'remove all overlaid text, badges, price tags and logos, reconstructing the surface beneath them cleanly',
};

/** 편집 대상이 명시적으로 건드리는 영역 — "나머지는 그대로" 문장에서 제외해야 모순이 없다 */
const EDIT_TOUCHES: Record<EditTarget, string[]> = {
  // face 는 사람을 통째로 다시 그리므로("얼굴만"이라고 하면 붙여넣기가 된다) 보존 문장에서 사람 전체를 제외한다
  face: ['the replaced people'],
  person: ['the people'],
  'add-person': ['the added people'],
  outfit: ['the clothing'],
  'product-color': ['the product colour'],
  background: ['the background'],
  'text-removal': ['the overlaid text'],
};

export interface ProductSpec {
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
  /** 화면상 위치 — 'left' | 'centre' | 'right' | 'back' 등. 다중 배치에서 색·형태를 못박는다 */
  placement?: string;
}

export interface TalentSpec {
  code: string;
  category: string;
  slot: string;
  /**
   * 자유 서술 인물 — 전속 모델이 아닌 경우 (예: 한국인 중년 남성).
   * true 면 참조 이미지(대표컷·표정컷)가 없고 identityEn 서술만으로 생성한다.
   */
  freeform?: boolean;
  /** 화면상 위치 — 다중 인물에서 누가 어디 앉는지 못박는다 */
  placement?: string;
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
  /** 자유 서술 의상 — 전속 의상을 안 쓸 때 (예: 'a charcoal knit sweater and grey trousers') */
  outfitFree?: string;
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

  /**
   * 레퍼런스(베이스)에 담긴 제품 — 인물 대비 스케일을 못박기 위한 것.
   * ref 흐름은 products[] 가 비어 제품 실측이 안 들어간다. 이걸 채우면
   * 모델 키와 이 제품 치수를 숫자로 비교해 빈백 대비 사람 크기를 잡는다.
   */
  scaleProduct?: { line: string; dims: { w?: number; d?: number; h?: number }; scalePrompt: string };

  /** 제품 형태 레퍼 (모델 제거본) */
  shapeRef?: { url: string; name: string };
  /** 포즈·각도 레퍼 (모델 포함본) */
  poseRef?: { url: string; name: string };
  /** 제품 연출컷 */
  usageShot?: { url: string; kindEn: string; kindKr: string };

  /** 등장 인물 — 여러 명이면 **사진 왼쪽부터** person 1, 2, 3… 순서로 배정 */
  talents?: TalentSpec[];

  /**
   * 제품 — 한 컷에 여러 종을 배치할 수 있다 (예: 왼쪽 Lounger · 가운데 Max · 오른쪽 Pod).
   * 순서는 화면 왼쪽부터. placement 로 위치를 못박으면 색이 뒤섞이지 않는다.
   */
  products?: ProductSpec[];

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
  /*
   * 인당 참조 장수. 얼굴이 많아질수록 한 장당 가중치가 떨어져 골격이 뭉개진다.
   * 4인 교체에서 인당 2장(총 8장 + 베이스)을 넣었더니 네 얼굴 모두 시트에서 벗어났다 —
   * 특히 표정컷을 "정확히 복사하라"고 시키면 표정을 따라가며 골격까지 끌려간다.
   * 그래서 3인 이상이면 대표컷 한 장만 쓰고 표정은 텍스트로만 지시한다.
   */
  const identPerPerson = talents.filter((t) => !t.freeform).length >= 3 ? 1 : 2;
  talents.forEach((t, i) => {
    if (t.freeform) return; // 자유 서술 인물은 참조 이미지가 없다 — 텍스트로만 지정
    const multi = talents.length > 1;
    // 명시 위치가 있으면 그걸 쓴다 — '왼쪽부터 N번째'와 'centre' 가 동시에 붙으면 서로 모순된다
    const who = multi
      ? `PERSON ${i + 1}${t.placement ? ` (${wherePhrase(t.placement)})` : ' (counting people from the LEFT of the base image)'}`
      : 'the model';
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
    let used = 0;
    for (const r of ident) {
      if (!r.url) continue;
      if (used >= identPerPerson) break;
      slots.push({ kind: 'talent', title: r.title, url: r.url, personIndex: i + 1, role: r.role, sub: r.sub });
      used++;
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
    for (const { p, v } of (spec.products ?? []).flatMap((p) => (p.views ?? []).map((v) => ({ p, v })))) {
      slots.push({
        kind: 'product',
        title: `제품 뷰 · ${p.line}${p.placement ? `(${p.placement})` : ''} ${v.angle}${v.colorMatched ? '' : ' 형태만'}`,
        url: v.url,
        role: (() => {
          const who = `the Yogibo ${p.line}${p.placement ? ` ${wherePhrase(p.placement)}` : ''}`;
          const angle = ANGLE_EN[v.angle] ?? v.angle;
          return v.colorMatched
            ? `an official product photograph of ${who}, seen from the ${angle} — reproduce this exact three-dimensional shape, proportions and smooth seamless cover`
            : `an official product photograph of ${who}, seen from the ${angle} — it is shown in a different colour, so take ONLY the shape and proportions; the colour is specified in the text`;
        })(),
      });
    }
  }


  /*
   * 의상 크롭 (얼굴 제거본) — 자리가 남을 때만. 원본(imageUrl)은 절대 넣지 않는다:
   * 레퍼 속 모델 얼굴이 결과에 섞이는 사고가 실측으로 확인돼 있다.
   *
   * 인물이 3인 이상이면 크롭을 아예 넣지 않는다. 참조 예산은 유한한데
   * 얼굴은 이미지가 없으면 못 살리고, 옷은 문장으로도 충분히 지정된다
   * ("an ivory ringer tee with grey shorts"). 4인 × 의상크롭을 넣었다가
   * 참조가 9장이 되면 얼굴 가중치가 다시 무너진다 — 얼굴엔 이미지, 옷은 텍스트.
   */
  const outfitCropAllowed = talents.filter((t) => !t.freeform).length < 3;
  talents.forEach((t, i) => {
    if (!outfitCropAllowed) return;
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

  // 컬러 스와치 — 제품마다 한 장. 다중이면 어느 제품 색인지 못박는다.
  for (const p of spec.products ?? []) {
    if (!p.color?.hex) continue;
    if (slots.length >= MAX_REFS) break;
    const multi = (spec.products ?? []).length > 1;
    slots.push({
      kind: 'swatch',
      title: `컬러 스와치 · ${p.color.name}${multi ? ` (${p.line})` : ''}`,
      swatchHex: p.color.hex,
      role: multi
        ? `the exact official colour swatch (${p.color.hex}) for the Yogibo ${p.line}${p.placement ? ` ${wherePhrase(p.placement)}` : ''} — match this hue, saturation and darkness precisely on that product only`
        : `the exact official colour swatch (${p.color.hex}) — match this hue, saturation and darkness precisely`,
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
/**
 * 프레임을 끝까지 채우라는 지시.
 *
 * 레퍼런스가 목표 규격과 비율이 다르면(가로 레퍼 → 정사각), 모델이 남는
 * 구석을 흰/투명/레터박스로 비워두는 사고가 난다 (사용자 확인 — 좌상단 빈 칸).
 * 원본이 그랬더라도 목표 규격을 골랐으면 그 구석까지 씬을 자연스럽게 이어
 * 채워야 한다.
 */
const FILL_FRAME =
  ' FILL THE ENTIRE FRAME edge to edge — absolutely no blank, white, grey, transparent, ' +
  'black-bar or letterboxed area, and no empty corners. If the reference does not cover the whole ' +
  'target shape, EXTEND (outpaint) the scene naturally to every edge — continue the walls, floor, ' +
  'window, curtains and background seamlessly so the whole rectangle is a single continuous photograph.';

function compositionFor(spec: GenerationSpec): string {
  const { width, height } = spec.size;
  const r = height ? width / height : 1;
  /*
   * 와이드 규격 구도 — 빈백이 주인공, 인물은 인테리어에 녹아드는 조연 (사용자 확정).
   * 처음엔 "베이스 샷 스케일 유지(인물 크게)"를 넣었다가 정반대 피드백을 받았다:
   * 모델이 너무 크게 나오는 게 문제였고, 원하는 그림은 룸 전체가 보이는 에디토리얼
   * 인테리어 컷 — 카메라가 물러나 제품 전체 + 주변 가구·바닥·벽이 함께 잡히고,
   * 사람은 그 안에 자연스럽게 앉아 있는 연출이다.
   */
  const PRODUCT_HERO =
    ' THE PRODUCT IS THE HERO of this frame, not the people. Shoot it like an editorial interior ' +
    'photograph: the camera stands back far enough that the bean bag is fully visible with breathing ' +
    'room around it, surrounded by its interior context — floor, rug, surrounding furniture, walls. ' +
    'The people are supporting cast, naturally absorbed into the scene, never so large that they ' +
    'dominate the frame or crop the product.';
  if (spec.mode === 'thumbnail') {
    if (r >= 1.3) {
      return `WIDE PRODUCT SHOT (${width}x${height}). Centre the product and model; keep generous even margin on both sides.` + PRODUCT_HERO + FILL_FRAME;
    }
    if (r >= 0.95) return `SQUARE PRODUCT THUMBNAIL (${width}x${height}). The product and model fill the frame with even margin — this is a catalogue thumbnail, so the product must read clearly at small size.` + FILL_FRAME;
    return `TALL PRODUCT SHOT (${width}x${height}). Vertical framing; the product fills the lower two thirds.` + FILL_FRAME;
  }
  if (r >= 2.5) {
    return `EXTREME WIDE BANNER (${width}x${height}). Place the product and model in the RIGHT third. The LEFT half must be an empty, uncluttered wall/floor plane. Keep every essential element inside the vertical middle band — the top and bottom will be cropped away.` + PRODUCT_HERO + FILL_FRAME;
  }
  if (r >= 1.6) {
    return `WIDE WEB BANNER (${width}x${height}). Split composition: the LEFT 45% stays clean and empty for copy, product and model occupy the RIGHT side.` + PRODUCT_HERO + FILL_FRAME;
  }
  if (r >= 0.95) {
    return `SQUARE SNS POST (${width}x${height}). Subject and product sit in the LOWER TWO THIRDS, centred slightly off-axis. The TOP THIRD stays a quiet, evenly lit area for copy.` + FILL_FRAME;
  }
  return `TALL MOBILE FORMAT (${width}x${height}). The TOP third stays clean and empty for copy; the product and model fill the LOWER two thirds.` + FILL_FRAME;
}

/** 제품 블록 — 12차 실측 4종 세트 */
function productBlock(spec: GenerationSpec): string[] {
  const products = spec.products ?? [];
  if (!products.length) return [];
  const multi = products.length > 1;
  const L: string[] = [];

  if (multi) {
    L.push(
      `PRODUCTS — ${products.length} different Yogibo products in one scene. ` +
        'Each is a separate product with its own shape and colour; do not merge them, ' +
        'do not give them the same shape, and do not swap their colours:',
    );
  }

  products.forEach((p, i) => {
    const colorEn = p.color?.nameEn || p.color?.name || '';
    // 다중일 때는 위치를 머리에 박아 색·형태가 뒤섞이는 걸 막는다
    const where = p.placement ? `${p.placement.toUpperCase()} — ` : multi ? `PRODUCT ${i + 1} — ` : '';
    if (multi) L.push('');
    L.push(`${multi ? where : 'PRODUCT — '}Yogibo ${p.line}${colorEn ? ` (${colorEn})` : ''}.`);
    L.push(`  SHAPE: ${p.shape}.`);
    const d = p.dims ?? {};
    const dims = [d.w && `${d.w}cm wide`, d.d && `${d.d}cm deep`, d.h && `${d.h}cm tall/long`].filter(Boolean).join(' x ');
    if (dims) L.push(`  EXACT SIZE: ${dims}${d.weight ? `, ${d.weight}kg` : ''}.`);
    if (p.scalePrompt) L.push(`  SCALE ANCHOR: ${p.scalePrompt}.`);
    L.push(`  NEGATIVE: ${p.negative}.`);
    if (p.color?.hex) L.push(`  COLOUR: ${colorEn} (${p.color.hex}) — exact, must not drift toward a neighbouring hue.`);
    L.push(`  USE: ${p.staging || p.modes}.`);
  });
  /*
   * 공식 뷰는 제품을 눕혀/세워 놓고 찍은 "기본 자세"다.
   * 실사고(Max 초코브라운): 누운 로그형 뷰 + 착석 포즈 베이스를 모델이 멋대로 합쳐
   * 거대한 크레센트로 구부렸다. 뷰에서 가져올 것은 형태·치수뿐이고,
   * 장면 속 놓임새는 포즈가 정하되 껍데기 자체는 못 바꾼다고 못박는다.
   */
  L.push(
    'PRODUCT VIEWS show each product in its factory resting orientation. In the scene, position the product however ' +
      'the pose and staging require, BUT its shell keeps the exact shape and true dimensions from the views — ' +
      'never bend, curl, stretch, inflate or merge a product to fit a pose, a person or the composition.',
  );
  return L;
}

/** 인물 블록 — 여러 명이면 사진 왼쪽부터 PERSON 1/2/3 */
/**
 * 위치를 자연스러운 영어 구로 바꾼다.
 * 'on the centre' 는 비문이고, 비문은 모델이 위치를 무시하는 원인이 된다.
 */
function wherePhrase(placement: string): string {
  const p = placement.trim().toLowerCase();
  if (p === 'centre' || p === 'center' || p === 'middle') return 'in the centre';
  if (p === 'foreground') return 'in the foreground';
  if (p === 'background') return 'in the background';
  return `on the ${p}`;
}

/**
 * 인물-가구 스케일 블록.
 *
 * 빈백 대비 사람 크기가 흔들리는 걸 막는다. 모델별 실측 키를 한데 모아
 * "하나의 일관된 사람 크기"로 못박고, 레퍼런스에 담긴 제품이 지정되면
 * 그 제품 치수와 숫자로 비교한다. 제품이 없으면 일반적인 가구 현실성 문장만.
 *
 * ref(베이스 교체) 흐름은 productBlock 이 비어 스케일 앵커가 통째로 빠졌다 —
 * 그래서 모델이 사람을 크게/작게 그렸다. 이 블록이 그 구멍을 메운다.
 */
function scaleBlock(spec: GenerationSpec): string[] {
  const talents = spec.talents ?? [];
  const hasBackground = (spec.uploadedRefs ?? []).some((r) => r.role === 'background');
  // 사람이 없어도 배경 사진이 있으면 축척 블록은 필요하다 — 방의 가구가 자(yardstick)다
  if (!talents.length && !hasBackground) return [];
  const heights = talents
    .map((t, i) => {
      const h = (t.sizeEn.match(/(\d{2,3})\s?cm/) || [])[1];
      if (!h) return null;
      return talents.length > 1 ? `PERSON ${i + 1} ${h}cm` : `${h}cm`;
    })
    .filter(Boolean) as string[];

  // 베이스에 이미 사람이 있고 그 사람을 교체하는 흐름이면, 그 사람이 최고의 크기 기준이다.
  // 실촬영 원본은 사람↔빈백 크기가 정답이라, 외부 키(cm)를 억지로 넣으면 오히려
  // 원본 크기와 싸워 합성 티가 난다. 원본 인물을 자(yardstick)로 삼는다.
  const editingPeople = (spec.editTargets ?? []).some((x) => x === 'person' || x === 'face' || x === 'add-person');
  const hasBase = !!spec.baseCut || (spec.uploadedRefs ?? []).some((r) => r.role === 'base');
  const baseAnchored = editingPeople && hasBase;

  const L: string[] = [''];

  /*
   * 배경 사진이 캔버스일 때 — 그 공간의 가구·건축이 축척의 자다.
   * (사용자 요청: 배경 속 가구 크기를 읽어, 들어가는 모델·빈백이 거기 맞게 리사이징되도록)
   * 소파 좌면 40~45 / 카운터 85~95 / 스툴 65~75 / 문 200~210 / 천장 230~250cm 는
   * 어디서나 통하는 표준치라, 모델이 사진만 보고 공간의 실측 축척을 역산할 수 있는
   * 가장 확실한 단서다. 축척을 먼저 세우고, 사람·제품을 그 축척 위에 놓게 한다.
   */
  if (hasBackground) {
    L.push(
      'SCALE FROM THE ROOM — the supplied background is a real photographed space. FIRST establish its metric scale ' +
        'from its own furniture and architecture: sofa seats sit about 40-45cm off the floor, coffee tables are ' +
        '~40-45cm tall, kitchen counters ~85-95cm, bar stools ~65-75cm, dining chair seats ~45cm, interior door ' +
        'openings ~200-210cm, ceilings ~230-250cm. THEN place every person and every product at TRUE size inside ' +
        'that metric space — sized correctly against the actual sofa, counters, chairs and doors visible in the ' +
        'photo, standing on the same floor plane with the room\'s own perspective and camera height. Feet and ' +
        'product bases sit ON that floor with correct diminution into depth; nothing floats, and nothing reads ' +
        'giant or miniature next to the room\'s furniture.',
    );
  }

  if (talents.length) {
    if (baseAnchored) {
      L.push(
        'SCALE — the base photograph already shows real people at the correct real-world size against the furniture. ' +
          'Use the person(s) in the base as the SIZE YARDSTICK. Where you replace a base person, keep their EXACT ' +
          'size and footprint — same height in the frame, same seat contact, same way their weight sinks into and ' +
          'compresses the bean bag, same limb placement — and change only the face, hair and outfit. Any newly added ' +
          'person must be rendered at that SAME human scale as the base person relative to the furniture. Do not resize ' +
          'people to some other height; heads and faces must not be enlarged.',
      );
      if (heights.length) L.push(`  For consistency between people, their real heights are ${heights.join(', ')} — keep these proportions, but the base person's on-screen scale wins over any absolute number.`);
    } else {
      L.push(
        'SCALE — render every person at ONE consistent, true-to-life human scale, correct relative to each other AND to ' +
          'every piece of furniture in the frame. Heads and faces must not be enlarged.',
      );
      if (heights.length) L.push(`  Real heights: ${heights.join(', ')}. Keep these height proportions between the people.`);
    }
  }

  const sp = spec.scaleProduct;
  if (sp) {
    const d = sp.dims || {};
    const dims = [d.w && `${d.w}cm wide`, d.d && `${d.d}cm deep`, d.h && `${d.h}cm long/tall`].filter(Boolean).join(' x ');
    L.push(
      `  The Yogibo ${sp.line} in this scene measures ${dims || 'its real size'} — ${sp.scalePrompt}.` +
        (talents.length
          ? ' Size every person against it: a seated adult sinks into it and their body takes up a large part of it, ' +
            'and an adult lying along it spans nearly its whole length. Do not shrink the people so it looks oversized, ' +
            'nor enlarge them so it looks like a small cushion.'
          : ' Its bulk must read correctly next to the sofas, tables and counters in the space.'),
    );
  } else if (talents.length) {
    L.push(
      '  Keep the Yogibo furniture at its true real-world size against these people — a Yogibo floor lounger is ' +
        'roughly as long as an adult is tall (about 170cm). Do NOT shrink the people so the furniture looks oversized, ' +
        'nor enlarge them so a large floor lounger reads like a small cushion.',
    );
  }

  // 합성 티 방지 — 사람·제품을 씬 안으로 '촬영해 넣는다'. 접촉 그림자·눌림·조명·질감을 원본에 맞춘다.
  // 배경 사진에 얹는 경우도 같은 문제가 나서(붙임 티) 베이스와 동일하게 적용한다.
  if (hasBase || hasBackground) {
    L.push(
      '  Integrate every person and product seamlessly INTO the photograph, not pasted on top: match the photo\'s ' +
        'lighting direction and softness, its depth of field and photographic grain. Where a person touches a bean bag ' +
        'or the floor, the surface must visibly dent and compress under their weight, with a soft contact shadow in the ' +
        'crease and correct ambient occlusion. The product casts a soft grounded shadow on the room\'s floor. No hard ' +
        'cut-out edges, no floating, no sticker look — same lens, same grain, same colour temperature as the photo.',
    );
  }
  // 여러 명이면 사람마다 밝기·조명이 달라 따로 노는 문제 (사용자 지적: 명암도 불일치).
  // 한 방·한 조명으로 전부 똑같이 비추게 못박는다.
  if (talents.length > 1) {
    L.push(
      '  CONSISTENT LIGHTING — every person is lit by the SAME light in the SAME room: identical key-light direction, ' +
        'intensity, colour temperature and shadow softness on each face and body. No one is brighter, darker, warmer, ' +
        'cooler or more contrasty than the others; their skin tones and exposure read as a single photograph taken at ' +
        'one moment, not separate cut-outs lit differently.',
    );
  }
  return L;
}

function talentBlock(spec: GenerationSpec, refs: RefSlot[]): string[] {
  const talents = spec.talents ?? [];
  if (!talents.length) return [];
  const L: string[] = [];
  const multi = talents.length > 1;

  /*
   * 베이스에 사람이 더 있으면 지워야 한다.
   * 레퍼런스 3인 사진에 모델 2명만 지정하면 "정확히 2명"이라고만 말해봐야
   * 남은 1명을 어떻게 하라는 지시가 없어서, 모델이 그 사람을 그대로 두거나
   * 어정쩡하게 뭉갠다. 지우고 그 뒤에 있던 제품·바닥·배경을 복원하라고 못박는다.
   * (사람이 줄면 가려져 있던 제품 형태가 드러나므로 오히려 제품 컷에 유리하다)
   */
  const editingPeople = (spec.editTargets ?? []).some((x) => x === 'person' || x === 'face' || x === 'add-person');
  const hasBase = !!spec.baseCut || (spec.uploadedRefs ?? []).some((r) => r.role === 'base');
  if (editingPeople && hasBase) {
    L.push(
      `If the base image contains MORE people than the ${talents.length} listed here, remove the extra ones completely — ` +
        'erase the whole person, not just the face. Reconstruct whatever was behind them: the product surface, its ' +
        'seams and silhouette, the floor, the rug and the background, all consistent with the surrounding lighting ' +
        'and shadows. No ghosting, no leftover limbs, no blurred smear where a person used to be. ' +
        'The product must read as a complete, undistorted form where it becomes visible again.',
    );
  }

  if (multi) {
    // 위치가 하나라도 명시되면 '왼쪽부터' 문장을 쓰면 안 된다 — PERSON 1 이 가운데인데
    // 헤더가 왼쪽부터 세라고 하면 모델이 둘 중 하나를 버린다
    const anyPlacement = talents.some((t) => t.placement);
    L.push(
      anyPlacement
        ? `PEOPLE — exactly ${talents.length} people. Each person's position in the frame is stated explicitly below; ` +
            'place them exactly there. No extra people, no background bystanders, no duplicated faces.'
        : `PEOPLE — exactly ${talents.length} people, assigned by position COUNTING FROM THE LEFT of the frame. ` +
            'No extra people, no background bystanders, no duplicated faces.',
    );
  }

  talents.forEach((t, i) => {
    const where = t.placement
      ? wherePhrase(t.placement)
      : i === 0 ? 'leftmost' : `${ORDINALS[i].toLowerCase()} from left`;
    const head = multi ? `PERSON ${i + 1} (${where})` : 'MODEL';
    // 이 인물의 시트가 몇 번째 참조인지 명시한다 — 다인에서 얼굴이 섞이는 걸 막는 핵심
    const slotIdxs = refs
      .map((r, idx) => (r.kind === 'talent' && r.personIndex === i + 1 ? idx : -1))
      .filter((idx) => idx >= 0);
    // freeform 인물은 참조 이미지가 없다 — 없는 이미지를 가리키면 안 된다
    const sheetRef = !t.freeform && slotIdxs.length
      ? ` — identity from the ${slotIdxs.map((idx) => ORDINALS[idx]).join(' and ')} image${slotIdxs.length > 1 ? 's' : ''}`
      : '';
    L.push(`${head}${sheetRef}: ${t.identityEn}.`);
    L.push(`  BODY: ${t.sizeEn}.`);
    if (t.expression) {
      const exprIdx = refs.findIndex((r) => r.kind === 'talent' && r.personIndex === i + 1 && r.sub === 'expr');
      const sheetIdx = refs.findIndex((r) => r.kind === 'talent' && r.personIndex === i + 1 && r.sub === 'sheet');
      /*
       * 미소가 아닌 표정(놀람·무표정·진지함·슬픔·찡그림)은 공통 규칙과 충돌한다.
       * 하우스 룰에 "모델은 항상 자연스러운 미소" 가 있어서, MD 가 '놀람'을 골라도
       * 결과가 미소로 나온다 — 실측으로 확인된 문제다.
       * MD 가 명시적으로 고른 표정이 공통 규칙을 이겨야 한다.
       */
      const isSmile = /smile|grin/i.test(t.expression.en);
      const beatsHouseRule = isSmile
        ? ''
        : ' This is a deliberate art-direction choice and OVERRIDES any general instruction to smile — do not substitute a smile here.';
      if (exprIdx >= 0) L.push(`  EXPRESSION: ${t.expression.en} — match the expression in the ${ORDINALS[exprIdx]} image exactly.${beatsHouseRule}`);
      else if (sheetIdx >= 0) L.push(`  EXPRESSION: ${t.expression.en} — use that panel from the expression sheet (the ${ORDINALS[sheetIdx]} image).${beatsHouseRule}`);
      else L.push(`  EXPRESSION: ${t.expression.en}.${beatsHouseRule}`);
    }
    /*
     * 편집(인물/의상 교체)일 때는 "베이스 옷을 갈아입힌다"를 명시해야 한다.
     * 안 그러면 모델이 베이스의 옷을 그대로 두고 지정 의상을 무시한다.
     */
    const swaps = (spec.editTargets ?? []).some((x) => x === 'person' || x === 'outfit');
    const overrideNote = swaps
      ? ' This REPLACES whatever the person in the base image is wearing — do not keep the base garment.'
      : '';
    if (t.outfit) L.push(`  OUTFIT: ${t.outfit.descEn || t.outfit.desc} (${t.outfit.code}), barefoot unless stated otherwise.${overrideNote}`);
    else if (t.outfitFree) L.push(`  OUTFIT: ${t.outfitFree}, barefoot unless stated otherwise.${overrideNote}`);
    else if (hasBase && (spec.editTargets ?? []).some((x) => x === 'face' || x === 'person')) {
      /*
       * 의상 미지정(자동) + 인물 교체 — 여기가 합성티의 진원지였다.
       * "옷은 그대로"라고만 두면 모델이 옷 위에 얼굴만 붙인다. 같은 옷을 새 인물에게
       * 다시 입혀 그리라고 못박아야 목선·옷깃이 새 머리·머리카락에 맞게 다시 그려진다.
       */
      L.push(
        '  OUTFIT: the SAME garment this person wears in the base image — but RE-RENDER it naturally on the new person ' +
          '(same colour, fabric and fit), with the collar and neckline redrawn to meet the new head, neck and hair.',
      );
    }
  });

  if (multi) {
    const anyRef = talents.some((t) => !t.freeform);
    L.push(
      anyRef
        ? 'Each person keeps their own distinct identity — those with a reference sheet must match it exactly; never blend faces between people, never give two people the same face.'
        : 'Each person has a clearly distinct face and age; never give two people the same face.',
    );
  }
  /*
   * 시선 처리 — 정면 응시가 너무 잦다 (사용자 확인).
   * 원인: 아이덴티티 시트·표정컷이 전부 정면 스튜디오 포트레이트라, 모델이 표정과 함께
   * 시선·머리 각도까지 복사한다. 표정만 가져오고 시선은 장면이 정하게 못박는다.
   */
  if (talents.length) {
    L.push(
      editingPeople && hasBase
        ? 'GAZE & HEAD DIRECTION — each replaced person keeps the head angle and EYELINE of the person they replace ' +
          'in the base photograph: if they were looking at each other, at the product, down at a book or off-frame, ' +
          'the new person looks the SAME way. Never rotate a head toward the camera just because the identity or ' +
          'expression references are frontal portraits — copy the expression, never the reference\'s eyeline.'
        : 'GAZE & HEAD DIRECTION — direct eye contact with the camera is the EXCEPTION, not the default. ' +
          'The people are candid, absorbed in the scene: looking at each other, at the product, out the window, ' +
          'at a prop, or into the middle distance, with relaxed three-quarter head angles. At most ONE person may ' +
          'glance toward the camera, and only when it feels natural — never the whole group locking eyes with the ' +
          'lens like a posed studio photo.',
    );
  }
  if (talents.some((t) => !t.freeform)) {
    L.push(
      /*
       * 얼굴 일관성은 이 프로젝트의 핵심 요구사항이다.
       * 실패 사례에서 배운 것: 모델은 시트와 베이스 얼굴을 "평균"내려 하고,
       * 교체 대상의 나이·체형에 맞춰 시트 쪽을 구부린다(10~12세 시트가 6~7세로 내려갔다).
       * 그래서 ①평균 금지 ②나이 고정 ③충돌 시 시트가 이긴다 를 못박는다.
       */
      'FACE IDENTITY IS THE SINGLE HIGHEST PRIORITY OF THIS IMAGE — above pose, above composition, above styling. ' +
        'For every person that has an identity sheet, that sheet is absolute ground truth. The rendered face must be ' +
        'unmistakably the SAME person: same skull and jaw shape, same cheekbones, same eye shape and spacing, same nose, ' +
        'same lips, same hairline and hair texture.',
      // 실패 사례: 시트는 중간길이 곱슬인데 베이스 인물의 짧은 머리가 그대로 남았다.
      // 얼굴만 말하면 모델이 머리는 베이스에서 가져온다 — 머리를 따로 못박는다.
      'HAIR COMES FROM THE SHEET, NOT FROM THE BASE: length, cut, parting, volume, curl or straightness and colour ' +
        'must all match the identity sheet. Never keep the haircut of the person being replaced.',
      'DO NOT AVERAGE. Never blend the sheet face with whatever face is already in the base image — the base face is to be ' +
        'discarded completely and rebuilt from the sheet. A result that looks like a mix of the two is a failure.',
      'AGE IS LOCKED to what the sheet and the stated age say. Do not age a person up or down to suit the body, pose, ' +
        'clothing or seat of the figure they are replacing. If the person being replaced is visibly younger, older, ' +
        'shorter or differently built, the SHEET WINS — rebuild the head, face and proportions to match the sheet and ' +
        'let the pose adapt around them.',
      'Do not beautify, slim, smooth, de-age or drift toward a generic attractive face. Keep the real skin texture, ' +
        'pores and asymmetry.',
      /*
       * 참조 조명 복사 금지 — 합성티의 실제 주범.
       * 아이덴티티 시트는 스튜디오 정면 포트레이트라, 그대로 두면 모델이 그 평면광·화이트밸런스·
       * 정면 각도까지 장면 속 몸 위에 복사한다. 얼굴만 딴 데서 온 것처럼 보이는 이유가 이것이다.
       */
      'THE IDENTITY REFERENCES ARE STUDIO PORTRAITS — take ONLY the person from them: face geometry, features, ' +
        'skin character and hairstyle. Do NOT copy their flat studio lighting, white balance or head-on frontal angle. ' +
        'Light every face with THIS scene\'s light — same direction, warmth and softness as the room, with matching ' +
        'shadows on the face and neck — and turn the head to whatever angle the pose calls for.',
      'NO COMPOSITE LOOK — each person must read as ONE continuous photograph: face, ears, neck, chest and hands ' +
        'share one skin tone; no brightness, colour or sharpness step at the jawline or collar; hair falls naturally ' +
        'over the shoulders and casts a soft shadow on the clothing; the head\'s size, angle and perspective sit ' +
        'correctly on the body. A result that looks like a face pasted onto a photo is a failure.',
      /*
       * 착석 자세 — 자사몰 컷의 최소 기준.
       * 빈백·좌식 소파는 몸이 낮게 가라앉아서, 그냥 두면 다리가 크게 벌어진 자세로 나온다.
       * 실측에서 여성 모델이 다리를 넓게 벌린 컷이 나왔고 그대로는 자사몰에 못 쓴다.
       * 편안함은 유지하되 자세는 단정해야 한다 — 둘은 양립한다.
       */
      'SEATED POSTURE — keep every pose relaxed but modest and commercially usable. Knees stay together, ' +
        'crossed, angled to one side, or tucked up; legs may stretch forward but never splay wide apart. ' +
        'No wide-open straddling posture, no crotch-forward framing, no upward angle between the legs. ' +
        'Skirts and dresses fall naturally over the knees. This applies to everyone in the frame regardless ' +
        'of how deeply the seat sinks under their weight.',
    );
  }
  return L;
}

/** 업로드 base 편집 지시 */
function editBlock(spec: GenerationSpec): string[] {
  const targets = spec.editTargets ?? [];
  if (!targets.length) return [];
  const L: string[] = [];
  L.push('EDIT — change ONLY the following, and leave everything else pixel-faithful to the base image:');
  for (const t of targets) L.push(`  - ${EDIT_TARGET_EN[t] ?? t}`);
  /*
   * 항목별 지시가 각자 "나머지는 그대로"라고 말하면 여러 개를 함께 고를 때 모순이 된다
   * (제품 리컬러는 "배경 유지", 배경 교체는 "제품 유지"). 그래서 각 지시는 자기가 바꿀 것만
   * 말하게 하고, 무엇을 보존할지는 여기서 한 번에 정리한다.
   */
  const touched = targets.flatMap((t) => EDIT_TOUCHES[t] ?? []);
  if (touched.length) {
    L.push(
      `Everything other than ${touched.join(', ')} must stay exactly as in the base image — ` +
        'same composition, camera angle, object positions, scale and lighting direction.',
    );
  }
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

  const sb = scaleBlock(spec);
  if (sb.length) { L.push(...sb); L.push(''); }

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
    /*
     * 로컬(템플릿) 모드에는 번역기가 없어 한글 지시가 그대로 나간다.
     * 나노바나나는 한국어를 이해하므로 동작은 하지만, 무엇을 하라는 건지 못 박아준다.
     * 라이브(Opus) 모드에서는 Opus 가 이 지시를 영문으로 옮겨 본문에 녹인다.
     */
    L.push('');
    L.push(
      'ADDITIONAL DIRECTION FROM THE ART DIRECTOR (written in Korean). ' +
        'Read it, translate it faithfully, and apply it to the scene, lighting, props, camera and pose. ' +
        'Where it conflicts with any rule above, THIS DIRECTION WINS:',
    );
    L.push(spec.direction);
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

  /*
   * 브랜드 태그·라벨 처리.
   *
   * 처음엔 무조건 무지 태그로 비우게 했는데, 그러면 제대로 나올 기회까지 없앤다.
   * 태그가 충분히 크게 잡힌 컷에서는 워드마크가 멀쩡히 나오기도 한다.
   *
   * 그래서 조건부다 — 깨끗하게 읽히면 살리고, 그 크기에서 글자꼴이 무너질 것 같으면
   * 비운다. 절대 하면 안 되는 건 '뭉개진 글자'다 ("yogibo" -> "qo ㅕo").
   * 없는 것보다 나쁜 건 틀린 것이다.
   */
  /*
   * 베이스로 쓰는 SNS·외부 이미지에 찍힌 워터마크/저작권 문구가 결과물까지 살아남는 사고
   * (실측: 인스타 베이스의 "© 2026 ..." 가 생성 컷 구석에 그대로 남았다).
   * "베이스에 충실하라"보다 우선하는 예외로 못박는다 — 오버레이 텍스트는 장면이 아니다.
   */
  L.push(
    'WATERMARK CLEANUP: any overlaid watermark, copyright line, credit, username handle, timestamp, UI element or ' +
      'caption text PRINTED ON a base or reference photo is NOT part of the scene — remove it completely and ' +
      'reconstruct the image beneath it, matching the surrounding texture, colour and lighting. This overrides ' +
      '"stay faithful to the base": the output must carry no inherited overlay text of any kind.',
  );
  L.push(
    'BRAND TAGS: if the base image shows a sewn-in fabric tag or brand patch on the product, keep the tag itself — ' +
      'same shape, size, position, fabric and fold. EXACTLY ONE tag per product — if different references show the ' +
      'tag in different spots, pick the single most natural position and render only that one; never two tags on one ' +
      'product. Reproduce its wordmark ONLY if it can be rendered cleanly and ' +
      'legibly at the size it occupies in this frame. If the tag is too small for the letterforms to hold their shape, ' +
      'render the tag BLANK instead, with no lettering at all. Never output distorted, misspelled, mirrored or ' +
      'invented lettering: a garbled logo is worse than a clean blank tag.',
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

  const sb = scaleBlock(spec);
  if (sb.length) { L.push(''); L.push('스케일 (빈백 대비 사람 크기 — 반드시 반영):'); L.push(...sb.filter(Boolean).map((x) => '  ' + x)); }

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
4-1. **얼굴 일관성은 이 프로젝트의 최우선 요구사항이다.** 전속 모델은 여러 컷에 반복 등장하므로
   매번 같은 사람으로 보여야 한다. 브리프의 FACE IDENTITY / DO NOT AVERAGE / AGE IS LOCKED 문장은
   요약하거나 부드럽게 바꾸지 말고, 뜻을 그대로 살려 프롬프트 안에서 **가장 강한 문장**으로 실어라.
   특히 이런 실패를 막아야 한다:
     - 시트 얼굴과 베이스 사진 속 얼굴을 평균내서 제3의 인물이 나오는 것
     - 교체 대상의 나이·체형에 맞추려고 시트 쪽 나이를 올리거나 내리는 것
       (10~12세 모델이 6~7세로 나오는 식)
     - 미화·보정으로 시트의 골격이 뭉개지는 것
   인물 교체(EDIT: person/face)일 때는 "베이스의 얼굴은 완전히 버리고 시트에서 새로 만든다"를
   프롬프트 앞쪽에 배치하라.
5. 편집 지시(EDIT)가 있으면 "이것만 바꾸고 나머지는 원본 그대로"를 가장 앞에, 가장 강하게 써라.
6. 전 컷 공통 규칙은 빠짐없이 반영하라.
7. 텍스트·로고·워터마크 금지 문장을 마지막에 반드시 넣어라.
7-2. 베이스에 요기보 봉제 태그·케어라벨이 찍혀 있으면, 태그 자체는 그대로 두되
   **로고 글자는 조건부**로 지시하라. 그 크기에서 깨끗하게 읽힐 수 있으면 살리고,
   글자꼴이 무너질 만큼 작으면 글자 없이 비우게 하라.
   절대 나오면 안 되는 건 뭉개지거나 틀린 글자다 — 없는 것보다 나쁘다.
   태그를 통째로 지우라고는 하지 마라. 태그가 있어야 제품이 진짜로 보인다.
7-1. 인물마다 지정된 EXPRESSION 은 MD 가 직접 고른 값이다. 전 컷 공통 규칙에
   "항상 자연스러운 미소" 같은 문장이 있어도, **지정된 표정이 우선**이다.
   놀람·무표정·진지함·슬픔·찡그림이 지정됐다면 그대로 살리고 미소로 바꾸지 마라.
   공통 규칙의 미소 문장은 표정이 지정되지 않은 인물에게만 적용하라.
7-3. 착석 자세는 편안하되 **단정해야** 한다. 빈백·좌식 소파는 몸이 낮게 가라앉아
   그냥 두면 다리가 크게 벌어진 자세가 나온다. 무릎을 모으거나 꼬거나 한쪽으로 틀거나
   접어 올린 자세로 지시하고, 다리를 넓게 벌린 자세·가랑이가 정면으로 오는 프레이밍은
   명시적으로 금지하라. 자사몰에 걸 컷이라 이건 협상 대상이 아니다.
8. **MD 의 한글 방향 지시는 반드시 영문으로 옮겨 프롬프트 본문에 녹여라.**
   한글을 그대로 남기지 마라. 그리고 따로 떨어진 문장으로 덧붙이지 말고, 해당하는 항목
   (장면·조명·소품·카메라·포즈)에 각각 흡수시켜라. 예: "배경을 밝은 거실로, 45도 측면에서"
   → 장면 서술과 카메라 서술에 각각 반영한다.
   지시가 기존 규칙과 충돌하면 **MD 지시를 우선**한다 (배경 지정이 스튜디오 배경 규칙을 이기는 식).

출력은 영문 프롬프트 본문만. 설명·머리말·코드펜스 없이 프롬프트 텍스트만 출력하라.`;

export interface WriteResult {
  prompt: string;
  refs: RefSlot[];
  /** manual = 사람이 써서 붙여넣은 프롬프트. 아무 API 도 호출하지 않는다 (무과금) */
  mode: 'local' | 'opus' | 'manual';
  usage?: { input_tokens: number; output_tokens: number };
}

export interface WriteOptions {
  /** 'local' | 'opus' — 미지정이면 서버 env(PROMPT_MODE) */
  mode?: 'local' | 'opus';
  /**
   * 사람이 직접 쓴 프롬프트. 오면 이게 무조건 이긴다 — 템플릿도 Opus 도 타지 않는다.
   * 참조 이미지 목록은 그대로 조립하므로 FIRST/SECOND 순서는 유지된다.
   */
  manualPrompt?: string;
}

/**
 * 프롬프트를 만든다. PROMPT_MODE=opus 이고 키가 있으면 Opus 가 쓰고, 아니면 템플릿으로 조립한다.
 * Opus 호출이 실패하면 템플릿으로 떨어진다 — 프롬프트를 못 만들어 생성이 막히는 것이 가장 나쁘다.
 */
export async function writePrompt(spec: GenerationSpec, opts: WriteOptions = {}): Promise<WriteResult> {
  const refs = buildReferences(spec);

  // 사람이 쓴 프롬프트가 최우선. 로컬에서 무과금으로 최고 품질을 쓰는 길이다.
  const manual = opts.manualPrompt?.trim();
  if (manual) {
    /*
     * 사람이 쓴 프롬프트도 참조 매핑과 최소 가드는 받아야 한다.
     * 실사고(2026-09-02 · Max 초코브라운): 매뉴얼 프롬프트가 규칙 전부를 우회해
     * 제품이 크레센트로 휘고(누운 360 뷰 + 착석 포즈를 멋대로 합침), 태그가 2개 찍히고,
     * 스케일이 뻥튀기됐다. 창작 지시는 사람 것을 그대로 두되,
     * ① 몇 번째 이미지가 무엇인지(매핑이 이미 있으면 생략) ② 제품 형태·태그·스케일·얼굴
     * 같은 사실 규칙만 앞뒤로 붙인다.
     */
    const hasMapping = /\bFIRST image\b/i.test(manual);
    const guard: string[] = [
      'HOUSE GUARDRAILS — these apply on top of everything above:',
      '- Every product keeps its factory shape and true dimensions. The official product views show its resting ' +
        'orientation — in the scene, position it as the pose requires WITHOUT reshaping it: never bend, curl, ' +
        'stretch, inflate or merge the shell to fit a pose or composition.',
      '- EXACTLY ONE small sewn Yogibo fabric tag per product — never two. Render it clean and legible, or blank; ' +
        'never garbled lettering.',
      '- Any watermark, copyright line, credit or username printed ON a reference photo is NOT part of the scene — ' +
        'remove it and reconstruct the surface beneath. The output carries no inherited overlay text.',
    ];
    const anchors = (spec.products ?? []).map((p) => p.scalePrompt).filter(Boolean);
    if (anchors.length) guard.push(`- TRUE SCALE: ${anchors.join(' / ')}`);
    const negatives = (spec.products ?? []).map((p) => p.negative).filter(Boolean);
    if (negatives.length) guard.push(`- NEVER: ${negatives.join(' / ')}`);
    if ((spec.talents ?? []).some((t) => !t.freeform)) {
      guard.push(
        '- Faces with identity references must match those references exactly, lit by the scene\'s own light — ' +
          'never the reference\'s flat studio lighting.',
      );
    }
    const parts = [...(hasMapping ? [] : [describeRefs(refs)]), manual, guard.join('\n')];
    return { prompt: parts.join('\n\n'), refs, mode: 'manual' };
  }

  // 키가 있으면 기본이 Opus 다. 장당 ~₩60 은 품질 대비 감수할 값이고,
  // 손으로 쓴 프롬프트 수준이 나오는 지점이 바로 여기다.
  // 로컬 개발만 .env.local 의 PROMPT_MODE=local 로 명시적으로 끈다.
  // 컷 단위 override 가 오면 그게 이긴다 (화면의 프롬프트 작성 토글).
  const wantOpus = (opts.mode ?? process.env.PROMPT_MODE ?? 'opus') === 'opus' && !!process.env.ANTHROPIC_API_KEY;

  if (!wantOpus) return { prompt: buildPromptLocal(spec, refs), refs, mode: 'local' };

  try {
    const client = new Anthropic();
    /*
     * 참조 이미지는 **우리가 받아서** base64 로 넘긴다.
     * URL 소스로 넘기면 Anthropic 서버가 cafe24 를 직접 받아오는데, 거기서 타임아웃이 나면
     *   400 "The request timed out while trying to download the file"
     * 로 통째로 실패하고 템플릿으로 폴백된다 — 이미지 생성비는 그대로 나가면서
     * 프롬프트만 예전 품질로 돌아가는 최악의 조합이다. 우리가 받아오면 재시도도 우리 몫이다.
     *
     * 겸사겸사 768px 로 줄인다. Opus 가 할 일은 조명 방향·재질·구도를 읽는 것이지
     * 얼굴 픽셀을 세는 게 아니다 (그건 나노바나나가 1024~1600px 원본으로 한다).
     * 입력 토큰이 줄어 프롬프트 원가도 같이 내려간다.
     *
     * 스와치도 이제 함께 보낸다. 예전에는 URL 이 없어 빠졌는데, 그러면 Opus 가
     * 보지도 않은 이미지를 'the SIXTH image swatch' 라고 지칭하게 된다.
     */
    const OPUS_MAX_SIDE = 768;
    const loaded = await Promise.all(
      refs.map(async (r) => {
        if (r.url) return loadReference(r.url, OPUS_MAX_SIDE);
        if (r.swatchHex) return colorSwatch(r.swatchHex);
        return null;
      }),
    );
    const imageBlocks = loaded
      .filter((img): img is NonNullable<typeof img> => !!img)
      .map((img) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: img.mimeType as 'image/jpeg' | 'image/png', data: img.data },
      }));
    // 한 장도 못 받아오면 Opus 에게 텍스트만 주는 셈이라 템플릿과 다를 게 없다
    if (!imageBlocks.length && refs.length) throw new Error('참조 이미지를 한 장도 받아오지 못했습니다.');

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
