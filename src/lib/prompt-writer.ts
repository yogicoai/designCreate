import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { loadReference, colorSwatch } from './gemini';
import { PANEL_ANGLE_EN, TOP_FORM_LINES } from './ai-products';
import { NO_LOGO_RULE, withNoLogo, KEEP_REAL_TAG_RULE, withKeepRealTags } from './no-logo';

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

/** sheet = 자산관리 > AI 생성 제품(승인)의 칸 — 공식 사진(product)과 역할 문구가 다르다 */
export type RefKind = 'base' | 'style' | 'background' | 'shape' | 'pose' | 'usage' | 'talent' | 'outfit' | 'product' | 'sheet' | 'swatch';

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
  sub?: 'rep' | 'expr' | 'sheet' | 'angle';
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
  // 옷을 안 고른 사람은 OUTFIT 줄이 "원본 옷 그대로" 를 준다 — 여기서 옷까지 통째로 바꾸라고 하면 부딪힌다 (2차 검토 2026-09-22)
  person: 'replace each specified person entirely with the supplied model (face, hair, body proportions, and outfit unless that person\'s OUTFIT line keeps the base garment), keeping their pose',
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

/** ② 원본 사진 속 제품 — 크기 기준 + 형태 서술 (③ 에서 고르지 않고 사진 속 제품을 그대로 쓸 때) */
export interface PhotoProduct {
  line: string;
  dims: { w?: number; d?: number; h?: number };
  scalePrompt: string;
  /** products.geometry — 무엇인지(형태) · 아닌 것 · 실제 쓰임 */
  shape?: string;
  negative?: string;
  modes?: string;
}

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
  /** canonical = 확정 대표(마스터) 컷 — 다른 참조와 충돌 시 이긴다 */
  views?: {
    angle: string;
    url: string;
    colorMatched: boolean;
    canonical?: boolean;
    /**
     * sheet = AI 생성 제품 칸 (승인된 시트). 이게 오면 공식 뷰·대표 컷은 같이 오지 않는다.
     * primary = 사람이 고른 "배치 각도" 칸 — 장면 속 제품이 이 각도로 보여야 한다.
     * recolored = 칸 픽셀을 컬러칩 hex 로 이미 바꿔 넣었다.
     */
    source?: 'official' | 'sheet';
    primary?: boolean;
    recolored?: boolean;
    /** 칸 이름 (정면·45° 등) — 화면 표시용 */
    label?: string;
    /** 이 칸만의 영문 각도 문구 — 같은 키가 시트마다 다른 뜻일 때 (팟 side2 = 사선) */
    angleEn?: string;
  }[];
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
  /**
   * 얼굴 턴어라운드를 칸별로 잘라둔 각도컷 — { front, three_quarter_l, profile_l, three_quarter_r, profile_r }.
   * 대표컷·표정컷이 둘 다 정면이라, 고개를 돌리는 컷에서는 모델이 옆얼굴을 스스로 지어냈다
   * (실측 2026-09-23: 유럽계 여성이 동아시아 여성으로 바뀜, 얼굴 대조 40점).
   * 시트에는 3/4·옆이 이미 있었는데 생성에는 한 번도 안 들어가고 얼굴 검사 대조용으로만 쓰였다.
   */
  faceCrops?: Record<string, string>;
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
   * 배경 합성 (「모델과 함께」 ⑥ 배경 변경 — 사용자 요청 2026-09-21).
   * base 업로드(② 레퍼런스)에서는 인물·포즈·제품만 가져오고, background 업로드(⑥)의 공간에 옮겨 놓는다.
   * base 와 background 가 둘 다 있을 때만 켜진다(서버가 확인한다).
   * 켜지면 "베이스를 그대로 재현하라 — 같은 배경·같은 조명" 문장과 보존 강도 지시가 배경까지 붙잡지 않도록
   * 범위를 인물·제품으로 좁힌다 — 그대로 두면 두 지시가 정면으로 부딪힌다.
   */
  backgroundSwap?: boolean;

  /**
   * 레퍼런스(베이스)에 담긴 제품 — 인물 대비 스케일을 못박기 위한 것.
   * ref 흐름은 products[] 가 비어 제품 실측이 안 들어간다. 이걸 채우면
   * 모델 키와 이 제품 치수를 숫자로 비교해 빈백 대비 사람 크기를 잡는다.
   */
  scaleProduct?: PhotoProduct;
  /**
   * 사진 속 제품이 여러 개일 때 (사용자 요청 2026-09-22: 팟 + 서포트 + 트레이보 같은 조합 사진).
   * 하나만 고를 수 있을 때 서포트(ㄷ자 쿠션)가 무엇인지 몰라 사람 목에 둘렀다 — 제품마다 형태·치수·"사진 속 자리 그대로" 를 넣는다.
   * 있으면 scaleProduct 보다 우선한다.
   */
  scaleProducts?: PhotoProduct[];

  /**
   * 제품 조합 — 맥스에 서포트를 얹는 식으로 두 제품을 겹쳐 쓰는 연출.
   * 실측(2026-09-16): 제품을 따로 지시하면 상대 크기·접촉·방향이 반드시 틀어진다.
   * 조합 시트 칸(제품 참조로 이미 들어간다) + 공식 실사 + 아래 staging 세 겹으로 못박는다.
   */
  combo?: { lines: string[]; realRef?: string; staging: string[] };

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

  /**
   * 배경(또는 분위기 참고) 사진에서 잰 톤 — scene-tone.ts 의 영문 한 줄.
   * 있으면 제품·인물을 그 톤으로 찍힌 것처럼 맞추라는 블록이 숫자와 함께 들어간다.
   */
  sceneTone?: string;

  /**
   * 배경 사진 속 가구가 빈백 자리에 걸리면 지우라는 규칙을 넣을지.
   * 스토리보드 연속 컷은 앞 컷을 배경으로 넘기므로 가구를 지우면 컷끼리 이어지지 않는다 — 거기선 false.
   */
  clearBlockingFurniture?: boolean;

  /**
   * 편집 원본(base)이 전부 드롭박스 실촬영본이면 true — 그 사진의 진짜 태그를 지우지 않고 둔다 (사용자 결정 2026-09-22).
   * 로고 없음 규칙 대신 KEEP_REAL_TAG_RULE 이 들어가고, 제품·글자·보존 강도 문장의 "로고 없음" 도 그에 맞춘다.
   */
  keepRealTags?: boolean;

  /**
   * 편집 원본 사진의 가로/세로 비율 — 규격과 다르면 "구도는 그대로, 가장자리만 늘려라" 를 넣는다.
   * 실측 2026-09-23: 3:2 사진을 1:1 로 뽑자 모델이 장면을 다시 구성해 시선·인물 수·제품 모양이 바뀌었다.
   */
  baseAspect?: number;

  /**
   * 원본 사진 속 인물의 머리 각도·시선 (사진 왼쪽부터 한 줄씩, base-gaze.ts 가 읽는다).
   * 얼굴 시트·표정컷이 전부 정면이라 얼굴을 바꾸면 카메라를 보게 된다 — 원본이 어디를 보는지 적어 줘야 지켜진다.
   */
  baseGaze?: string[];
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
        ? (spec.talents?.length
          /*
           * 인물 있음 — 몸이 얼마나 가라앉는지까지가 포즈다. 제품 자체는 아무것도 가져오지 않는다.
           * 실측(2026-09-15 Drop 네이비 W_B): "눌림을 복사하라" 고 했더니 9/11 컷의 빈백을 통째로 옮겨 그렸다 —
           * 윗부분이 뒤로 말린 형태와 태그까지 그대로 따라왔다.
           */
          ? 'a POSE reference from our own approved catalogue — copy ONLY the body pose, limb placement, camera angle, framing and how deeply the body sinks in. Take NOTHING about the product itself from this image — not its shape, silhouette, top edge, folds, tags or colour — and not its model identity or outfit; all of those are specified separately below'
          /* 제품 단독 — 눌림을 복사하면 빈 제품이 눌린 채 나온다 (실측: 초코 드롭 주름 사고) */
          : 'a POSE reference from our own approved catalogue — copy ONLY the camera angle, framing and where the product sits in frame. Do NOT copy its product colour, and do NOT copy its compression or dents: the product in THIS image is unoccupied, so it stays fully inflated and taut regardless of how the reference looks')
        : 'the base photograph — reproduce its camera angle, pose, product shape and compression, lighting and framing exactly',
    });
  }
  /*
   * 배경 합성이면 두 사진의 역할을 칼같이 나눈다. 실측(2026-09-21): 참조 사진에 방이 있으면
   * "배경은 따로" 라고 해도 그 방이 통째로 따라온다 — 무엇을 가져오고 무엇을 버릴지를 사진마다 적어야 막힌다.
   */
  const swap = !!spec.backgroundSwap && bases.length > 0 && backgrounds.length > 0;
  /*
   * 인물 교체를 겸한 합성이면 원본은 "사람" 이 아니라 "포즈" 를 준다.
   * "원본에서 사람을 가져와라(정확한 팔다리 위치)" 는 원본 몸을 그대로 두라는 말로 읽혀,
   * 6살 아동 C 가 13살 원본 소년 자리를 못 채우고 원본 소년이 남았다 (검토 2026-09-22).
   */
  const recast = recastsPeople(spec);
  for (const u of bases) {
    slots.push({
      kind: 'base',
      title: `${swap ? '인물·제품 소스' : '베이스'} · ${u.title}`,
      url: u.url,
      role: swap
        /*
         * 합성에서도 아래 문장들은 원본을 "base image" 라고 부른다 — 여기서 그 이름을 원본에 묶는다 (2차 검토 2026-09-22).
         * 교체 인물의 크기·옷은 SCALE·OUTFIT 줄이 정한다 — 여기서 "몸 크기는 버린다" 로 단정하면 성인끼리 교체의 크기 유지와 부딪힌다.
         */
        ? recast
          ? 'the SOURCE photograph (called "the base image" below) for the POSES and the products ONLY — take from it where each person is and how they are posed (the people themselves are REPLACED by the models described below; nothing of their face, skin tone, hair or age is kept — their size relative to the bean bag and their garment follow the SCALE and OUTFIT lines below) and the products (their shape and size; under a replaced person of a different size the dent follows the new body). Take NOTHING of its environment: its room, walls, floor, windows, props, lighting and colour grade are all replaced by the background image'
          : 'the SOURCE photograph (called "the base image" below) for the people and the products ONLY — take from it the people (their exact pose, limb placement and position relative to each other and to the products) and the products (their shape, size and how they are compressed). Take NOTHING of its environment: its room, walls, floor, windows, props, lighting and colour grade are all replaced by the background image'
        : 'the base photograph to edit — keep it as-is and change only what is specified below',
    });
  }
  for (const u of backgrounds) {
    slots.push({
      kind: 'background',
      title: `${swap ? '새 배경' : '배경'} · ${u.title}`,
      url: u.url,
      role: swap
        ? 'the NEW ENVIRONMENT — the people and products from the source photograph are placed into THIS space. Reproduce its architecture, walls, floor, props, camera height, perspective, lighting direction and colour temperature'
        : 'the background and setting to reproduce — same space, architecture, lighting direction and colour temperature',
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
   *
   * 2인 이하는 2장 → 3장으로 늘렸다 (2026-09-23). 대표컷·표정컷이 둘 다 정면이라
   * 고개를 돌리는 컷에서 모델이 옆얼굴을 지어냈다 — 유럽계 여성이 동아시아 여성으로 바뀌어 나왔다.
   * 세 번째 자리는 얼굴 시트에서 그 방향으로 돌아간 칸 한 장이다(pickFaceAngle).
   * 시트를 통째로 넣지는 않는다 — 5칸이 한꺼번에 보이면 얼굴이 굳는다(repShot 주석 참고).
   */
  const identPerPerson = talents.filter((t) => !t.freeform).length >= 3 ? 1 : 3;
  talents.forEach((t, i) => {
    if (t.freeform) return; // 자유 서술 인물은 참조 이미지가 없다 — 텍스트로만 지정
    const multi = talents.length > 1;
    // 명시 위치가 있으면 그걸 쓴다 — '왼쪽부터 N번째'와 'centre' 가 동시에 붙으면 서로 모순된다
    const who = multi
      ? `PERSON ${i + 1}${t.placement ? ` (${wherePhrase(t.placement)})` : ' (counting people from the LEFT of the base image)'}`
      : 'the model';
    const n = multi ? `${i + 1} ` : '';
    const angle = pickFaceAngle(spec, i);
    const ident: { url?: string; title: string; role: string; sub: 'rep' | 'expr' | 'sheet' | 'angle' }[] = [
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
            // 표정컷은 정면 스튜디오 사진이다 — 표정만 가져오라고 못박지 않으면 머리 각도·시선까지 따라온다 (실측 2026-09-23)
            role: `the SAME person as the previous image, showing EXACTLY the expression to use for ${who} — copy this facial expression precisely while keeping the identity identical. Take ONLY the expression from it: ignore its frontal head angle and its eyeline, which come from the scene instead`,
          }
        : {
            url: t.exprSheet,
            sub: 'sheet',
            title: `표정 시트 ${n}· ${t.category} ${t.slot}`,
            role: `the expression reference for ${who} — the SAME model in 8 expressions; pick the requested expression panel while keeping the identity identical`,
          },
      /*
       * 얼굴 각도 칸 — 앞의 두 장은 둘 다 정면이라, 고개가 돌아가는 컷에서는 옆얼굴을 지어낸다.
       * 이 칸은 같은 사람이 그 방향으로 돌아간 모습이다. 표정은 앞 장이 정하고, 이 장은 뼈대만 준다.
       */
      {
        url: angle?.url,
        sub: 'angle',
        title: `얼굴 각도 ${n}· ${t.category} ${t.slot}${angle ? ` · ${angle.kr}` : ''}`,
        role:
          `the SAME person again, from the identity sheet — this panel shows ${who}'s face ${angle?.en ?? 'turned away from the lens'}. ` +
          'This scene turns their head away from the lens, so build the turned head FROM THIS PANEL: the skull and jaw seen from this angle, ' +
          'the cheekbone line, the nose profile, the brow and the ear. It is the same person as the two previous images — ' +
          'if the turned face you draw does not look like this panel, it is the wrong person. ' +
          'Take ONLY the head shape and features from it: not its expression (that comes from the expression reference), ' +
          'not its flat studio light, not its plain background',
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
      /*
       * AI 생성 제품 칸 — 공식 사진과 다르게 말한다.
       * 배치 각도 칸은 "이 제품을, 이 각도로" 가 핵심이고, 보조 칸은 입체만 알려준다
       * (보조 칸의 각도까지 따라가면 제품이 어느 방향을 볼지 모델이 헷갈린다).
       * 흰 스튜디오 배경·조명은 가져오지 않게 못박는다 — 배경은 장면이 정한다.
       */
      if (v.source === 'sheet') {
        const who = `the Yogibo ${p.line}${p.placement ? ` ${wherePhrase(p.placement)}` : ''}`;
        const angle = v.angleEn ?? ANGLE_EN[v.angle] ?? v.angle;
        // 자세 칸(세운 모습)은 "~에서 본" 이 아니라 자세다 — "seen from the standing upright…" 비문 방지
        const seen = POSTURE_KEYS.has(v.angle) ? angle : `seen from the ${angle}`;
        /*
         * 포즈 소스(포즈 레퍼·형태 레퍼·연출컷·포즈 컷)가 있으면 카메라·놓임새는 그쪽이 정한다.
         * 칸까지 "이 각도로 보여라" 라고 하면 참조 셋이 각도를 서로 주장해 형태가 평균난다 (검토 확인 2026-09-14).
         */
        const poseControls = hasPoseSource(spec);
        // describeRefs 가 끝에 마침표를 붙이므로 역할 문장은 마침표 없이 끝낸다
        const colourNote = v.recolored
          ? ' It is already shown in the requested colour'
          : v.colorMatched
            ? ''
            : ' It is shown in a different colour — take ONLY its shape; the colour is specified in the text';
        slots.push({
          kind: 'sheet',
          title: `AI 제품 · ${p.line}${p.placement ? `(${p.placement})` : ''} ${v.label || v.angle}${v.primary ? ' · 배치 각도' : ' · 형태 보조'}${v.recolored ? ' · 컬러 보정' : ''}`,
          url: v.url,
          role: v.primary && !poseControls
            ? `THE EXACT PRODUCT TO PLACE: an approved reference image of ${who}, ${seen}. ` +
              'Reproduce this very product — its three-dimensional shape, proportions, seams, plumpness and fabric — ' +
              `and show it in the scene ${POSTURE_KEYS.has(v.angle) ? `in this same posture (${angle})` : `from this same viewing angle (the ${angle})`}, so the camera sees the product the way this image does.` +
              `${colourNote ? `${colourNote}.` : ''} Take nothing else from it: ignore its plain studio background, studio lighting and framing`
            : v.primary
              ? `THE EXACT PRODUCT: an approved reference image of ${who}, ${seen} — reproduce this very product's three-dimensional shape, proportions, seams, plumpness and fabric. ` +
                `Its camera angle and how it sits in the scene come from the pose reference, not from this image.${colourNote ? `${colourNote}.` : ''} Ignore its plain studio background, studio lighting and framing`
            : `another angle of the SAME approved ${p.line} reference (${angle}) — use it ONLY to understand the product's full three-dimensional shape. ` +
              `Do not show the product from this angle and take nothing else from it${colourNote ? `.${colourNote}` : ''}`,
        });
        continue;
      }
      slots.push({
        kind: 'product',
        title: `제품 뷰 · ${p.line}${p.placement ? `(${p.placement})` : ''} ${v.angle}${v.canonical ? ' 대표' : v.colorMatched ? '' : ' 형태만'}`,
        url: v.url,
        role: (() => {
          const who = `the Yogibo ${p.line}${p.placement ? ` ${wherePhrase(p.placement)}` : ''}`;
          const angle = ANGLE_EN[v.angle] ?? v.angle;
          // 대표(마스터) 컷 — 형태·볼륨·태그까지 확정본. 다른 참조와 싸우면 이게 이긴다
          if (v.canonical) {
            return `the APPROVED MASTER photograph of ${who} — the definitive look of this product. Reproduce its ` +
              'exact shape, proportions and plumpness — but NOT its brand tag: the product is plain fabric with no tag or logo. Repaint it to the colour specified ' +
              'in the text and re-light it for this scene; if ANY other reference disagrees with this photograph, THIS ONE WINS';
          }
          return v.colorMatched
            ? `an official product photograph of ${who}, seen from the ${angle} — reproduce this exact three-dimensional shape, proportions and smooth seamless cover`
            : `an official product photograph of ${who}, seen from the ${angle} — it is shown in a different colour, so take ONLY the shape and proportions; the colour is specified in the text`;
        })(),
      });
    }
  }

  /*
   * 조합 공식 실사 — 두 제품이 실제로 겹쳐 놓인 판매사 사진.
   * 조합 시트 칸이 "어떻게 맞물리는지" 를 주고, 이 사진이 "사람이 들어갔을 때 얼마나 큰지" 를 준다.
   * 둘 중 하나만 넣으면 크기가 틀어진다 (실측 2026-09-16).
   */
  if (spec.combo?.realRef && slots.length < MAX_REFS) {
    const names = spec.combo.lines.map((l) => `Yogibo ${l}`).join(' + ');
    slots.push({
      kind: 'product',
      title: `조합 실사 · ${spec.combo.lines.join('+')}`,
      url: spec.combo.realRef,
      role:
        `the OFFICIAL photograph of the ${names} combination in real use, and the layout this shot copies. ` +
        'It is the ground truth for how the two products are laid out relative to each other, for their relative size, ' +
        'and for how large they are against a real person. Copy THAT layout and THAT scale relationship. ' +
        'Take nothing else from it — not its room, its furniture, its lighting, its colours or its model',
    });
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

/*
 * 참조 순서 표기 — MAX_REFS(14) 만큼 있어야 한다.
 * 8개뿐이던 시절, 참조가 9장을 넘으면 "The undefined image is …" 가 프롬프트에 들어갔다.
 */
const ORDINALS = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH', 'NINTH', 'TENTH', 'ELEVENTH', 'TWELFTH', 'THIRTEENTH', 'FOURTEENTH'];
if (ORDINALS.length < MAX_REFS) throw new Error('ORDINALS 가 MAX_REFS 보다 짧습니다');

/** 제품 뷰 각도 → 영문 표기 (AI 생성 제품 칸 키 포함) */
const ANGLE_EN: Record<string, string> = {
  ...PANEL_ANGLE_EN,
  front: 'front view',
  side: 'side view',
  back: 'back view',
  a045: '45-degree three-quarter view',
  a135: '135-degree rear three-quarter view',
  a225: '225-degree rear three-quarter view',
  a270: '270-degree side view',
  a315: '315-degree three-quarter view',
};

/** 보는 방향이 아니라 제품 자세가 바뀐 칸 */
/*
 * 각도가 아니라 '상태' 인 칸 — "seen from the ~" 로 이어 붙이면 비문이 된다.
 * real = 조합 사용컷(사람이 앉은 실사).
 */
const POSTURE_KEYS = new Set(['upright', 'real']);

/** 카메라·놓임새를 정하는 포즈 소스가 있는가 — 있으면 AI 제품 칸은 형태만 맡는다 */
function hasPoseSource(spec: GenerationSpec): boolean {
  return !!spec.poseRef || !!spec.shapeRef || !!spec.usageShot || spec.baseCut?.usage === 'pose';
}

/** 편집 베이스가 있는가 — 있으면 제품 뷰·AI 제품 칸이 참조로 붙지 않는다 (buildReferences 의 hasBase 와 같은 조건) */
function hasEditBase(spec: GenerationSpec): boolean {
  return (!!spec.baseCut && spec.baseCut.usage !== 'pose') || (spec.uploadedRefs ?? []).some((u) => u.role === 'base');
}

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
  /*
   * 인물 유무에 따라 주어를 바꾼다 — 모델을 안 골랐는데 문구가 "product and model"이라
   * AI 인물이 멋대로 등장하는 사고가 났다 (팟 검증 컷 실측). 제품 단독이면 사람 금지까지 명시.
   */
  const withPeople = (spec.talents?.length ?? 0) > 0;
  const SUBJ = withPeople ? 'the product and model' : 'the product';
  // 사람 금지는 "베이스 없이 새로 그리는 제품 단독 컷"에만 — 베이스에 있는 인물을 지우면 안 된다
  const hasBaseImg = (!!spec.baseCut && spec.baseCut.usage !== 'pose')
    || (spec.uploadedRefs ?? []).some((u) => u.role === 'base');
  const NO_PEOPLE = withPeople || hasBaseImg ? '' : ' There are NO people in this image — the product alone.';
  const PRODUCT_HERO = withPeople
    ? ' THE PRODUCT IS THE HERO of this frame, not the people. Shoot it like an editorial interior ' +
      'photograph: the camera stands back far enough that the bean bag is fully visible with breathing ' +
      'room around it, surrounded by its interior context — floor, rug, surrounding furniture, walls. ' +
      'The people are supporting cast, naturally absorbed into the scene, never so large that they ' +
      'dominate the frame or crop the product.'
    : ' THE PRODUCT IS THE HERO of this frame. Shoot it like an editorial interior photograph: the ' +
      'camera stands back far enough that the bean bag is fully visible with breathing room around it.';
  /*
   * 배경/베이스가 있는 "씬 합성"에서는 썸네일 구도의 "프레임을 채워라"가
   * 가구 잣대(SCALE FROM THE ROOM)와 정면충돌해 제품을 뻥튀기했다 (실측 — GPT 라운저+팟 컷).
   * 씬이면 채우기 대신 "방 안 실측 크기"를 구도가 다시 한 번 말한다.
   */
  const inScene = hasBaseImg
    || (spec.uploadedRefs ?? []).some((u) => u.role === 'background');
  /*
   * 사람이 고른 단일 제품 배치 — 구도 문장의 기본 위치(가운데·오른쪽)보다 우선한다.
   * 배너는 카피 자리를 제품 반대편으로 옮긴다 (검토 확인: 배치 왼쪽 + "제품은 오른쪽" 이 같이 들어갔다).
   */
  const place = (spec.products?.length === 1 ? spec.products[0].placement : '')?.trim().toLowerCase() ?? '';
  const side = place === 'left' || place === 'right' ? place : place === 'centre' || place === 'center' || place === 'middle' ? 'centre' : '';
  const copySide = side === 'left' ? 'RIGHT' : 'LEFT';
  const prodSide = side === 'left' ? 'LEFT' : 'RIGHT';
  if (spec.mode === 'thumbnail') {
    if (inScene) {
      return `INTERIOR SCENE (${width}x${height}). ${SUBJ.charAt(0).toUpperCase() + SUBJ.slice(1)} stand at TRUE physical scale inside the photographed room — modest within the space, with generous floor and room visible around them. Do NOT enlarge the products to fill the frame; the room's furniture sets their size.${NO_PEOPLE}` + PRODUCT_HERO + FILL_FRAME;
    }
    if (r >= 1.3) {
      return `WIDE PRODUCT SHOT (${width}x${height}). ${side && side !== 'centre' ? `Place ${SUBJ} on the ${side.toUpperCase()} side of the frame as specified` : `Centre ${SUBJ}; keep generous even margin on both sides`}.${NO_PEOPLE}` + PRODUCT_HERO + FILL_FRAME;
    }
    if (r >= 0.95) return `SQUARE PRODUCT THUMBNAIL (${width}x${height}). ${withPeople ? 'The product and model fill' : 'The product fills'} the frame with even margin — this is a catalogue thumbnail, so the product must read clearly at small size.${NO_PEOPLE}` + FILL_FRAME;
    return `TALL PRODUCT SHOT (${width}x${height}). Vertical framing; the product fills the lower two thirds.${NO_PEOPLE}` + FILL_FRAME;
  }
  if (r >= 2.5) {
    return `EXTREME WIDE BANNER (${width}x${height}). Place ${SUBJ} in the ${prodSide} third. The ${copySide} half must be an empty, uncluttered wall/floor plane. Keep every essential element inside the vertical middle band — the top and bottom will be cropped away.${NO_PEOPLE}` + PRODUCT_HERO + FILL_FRAME;
  }
  if (r >= 1.6) {
    return `WIDE WEB BANNER (${width}x${height}). Split composition: the ${copySide} 45% stays clean and empty for copy, ${SUBJ.replace('the ', '')} occupies the ${prodSide} side.${NO_PEOPLE}` + PRODUCT_HERO + FILL_FRAME;
  }
  if (r >= 0.95) {
    return `SQUARE SNS POST (${width}x${height}). ${withPeople ? 'Subject and product' : 'The product'} sit in the LOWER TWO THIRDS, centred slightly off-axis. The TOP THIRD stays a quiet, evenly lit area for copy.${NO_PEOPLE}` + FILL_FRAME;
  }
  return `TALL MOBILE FORMAT (${width}x${height}). The TOP third stays clean and empty for copy; ${SUBJ.replace('the ', '')} fills the LOWER two thirds.${NO_PEOPLE}` + FILL_FRAME;
}

/**
 * 제품끼리 크기 비교 — 여러 종을 한 장면에 넣을 때 (사용자 지시 2026-09-14: "제품별로 크기 차이가 제대로").
 *
 * 제품마다 EXACT SIZE 가 있어도 모델은 제품을 비슷한 크기로 맞춰 그리는 경향이 있다. 특히 AI 생성 제품 칸은
 * 제품마다 칸을 꽉 채워 찍혀 있어 참조 이미지끼리는 크기 차이가 전혀 안 보인다 — 크기는 숫자로만 전달된다.
 * 그래서 가장 긴 변 기준으로 큰 순서와 배율을 따로 적는다.
 */
function relativeSizeLines(products: Pick<ProductSpec, 'line' | 'dims' | 'placement'>[]): string[] {
  const sized = products
    .map((p, i) => {
      const d = p.dims ?? {};
      const longest = Math.max(d.w ?? 0, d.d ?? 0, d.h ?? 0);
      return { p, i, d, longest };
    })
    .filter((x) => x.longest > 0);
  if (sized.length < 2) return [];
  const multi = products.length > 1;
  const nameOf = (x: (typeof sized)[number]) =>
    `${multi && x.p.placement ? `${x.p.placement.toUpperCase()} ` : ''}Yogibo ${x.p.line}`;
  const order = [...sized].sort((a, b) => b.longest - a.longest);
  const big = order[0];
  const dimsText = (d: ProductSpec['dims']) =>
    [d.w && `${d.w}cm wide`, d.d && `${d.d}cm deep`, d.h && `${d.h}cm tall/long`].filter(Boolean).join(' x ');
  const L = [
    'RELATIVE SIZE BETWEEN THE PRODUCTS — they stand on the same floor, so their sizes must compare exactly as these real measurements do. ' +
      'The reference images are each cropped to fill their own frame, so they do NOT show relative size; use these numbers:',
  ];
  for (const x of order) {
    const ratio = x.longest / big.longest;
    L.push(`  - ${nameOf(x)}: ${dimsText(x.d)} — longest side ${x.longest}cm${x === big ? ' (the largest product)' : `, about ${ratio.toFixed(2)}× the ${big.p.line}'s longest side`}.`);
  }
  L.push(
    `  Order from largest to smallest: ${order.map((x) => x.p.line).join(' > ')}. ` +
      'A smaller product must never be drawn as large as a bigger one, and a large product must never shrink to match the others.',
  );
  L.push('');
  return L;
}

/**
 * 배경 톤 맞춤 — 프롬프트 끝(방향 지시 바로 앞)에 한 번 더 (사용자 요청 2026-09-22: "기본 프롬프트에 넣어줘").
 *
 * 왜 끝에 또: 가운데의 SCENE TONE·PHOTOGRAPHIC MATCH 만 있을 때는 합성 티가 났다(게임방 네온 컷 — 사람·팟이 밝고 고르게 붙음).
 * 같은 날 사용자가 방향 지시에 "배경 톤에 맞춰서 제품에 대한 컬러가 조절되게 해주고…" 라고 직접 적은 컷은 잘 나왔다.
 * 방향 지시는 프롬프트 맨 끝에 "이 지시가 이긴다" 로 들어가므로, 배경을 고르면 같은 자리에 같은 결의 지시를 자동으로 넣는다.
 * 제미나이는 한국어를 읽으므로, 잘 먹힌 한국어 문장 결도 그대로 한 줄 넣는다. 사람이 쓴 방향 지시는 이 뒤라 여전히 이긴다.
 */
function finalToneLines(spec: GenerationSpec): string[] {
  if (!spec.sceneTone) return [];
  const bg = isBackgroundSwap(spec) ? 'the BACKGROUND photograph' : 'the supplied background photograph';
  const who = spec.talents?.length ? 'the products and the people' : 'the products';
  const whoKr = spec.talents?.length ? '제품과 모델' : '제품';
  return [
    '',
    `FINAL TONE CHECK — this overrides any earlier colour or lighting wording: re-light and re-grade ${who} to ${bg}. ` +
      'Their brightness, contrast, shadow depth, white balance and colour cast must equal the room\'s — lit by the room\'s own light ' +
      'sources (its windows, lamps or coloured lights), from their direction and in their colour, with the room\'s own shadows falling on them. ' +
      'In a dim or night room they are dim too, lit only where that light reaches them; nothing in the frame is brighter, cleaner or more evenly ' +
      'lit than the room allows. Each product keeps its own colour identity — only the light on it changes.',
    `배경 이미지의 조명·톤에 맞춰서 ${whoKr}의 명도·대비·색감·그림자가 조절되게 해줘 — 배경 속 조명(창·스탠드·네온 등)의 방향과 색이 ${whoKr}에도 그대로 비쳐야 한다.`,
  ];
}

/**
 * 연출 최종 확인 — 새로 넣는 인물은 "찍힌 순간" 이어야 한다 (사용자 요청 2026-09-23: "자연스럽게 대화하는 연출이면 더 좋은데").
 *
 * 얼굴 시트·표정컷이 전부 정면 포트레이트라, 그냥 두면 둘 다 카메라를 보고 나란히 웃는 증명사진이 된다.
 * 가운데의 GAZE 규칙만으로는 안 눌려서 프롬프트 끝(사람이 쓴 방향 지시 바로 앞)에 한 번 더 못박는다 —
 * 방향 지시가 있으면 그게 이 문장을 덮는다(카메라를 보게 하고 싶을 때는 거기 적으면 된다).
 * 원본 인물을 교체하는 컷에는 넣지 않는다 — 거기선 원본의 시선을 그대로 지켜야 한다.
 */
function finalCandidLines(spec: GenerationSpec): string[] {
  const n = spec.talents?.length ?? 0;
  if (!n || recastsPeople(spec)) return [];
  /*
   * 2026-09-23 2차: 문장을 끝에 넣었는데도 둘 다 정면을 봤다 (실측 01:47 컷 — 연출 문장이 들어간 채로).
   * 정면 얼굴 참조 4장의 힘이 세서 "자연스럽게" 같은 말로는 안 눌린다. 그래서 각도를 숫자로 못박고,
   * 사람이 쓴 방향 지시가 없으면 이 문장을 "아트 디렉터 지시" 자리(프롬프트에서 가장 센 자리)에 넣는다.
   */
  const name = (i: number) => (n > 1 ? `PERSON ${i}` : 'the model');
  return [
    '',
    n > 1
      ? 'FINAL STAGING CHECK — a candid moment between them, NOT a portrait. Turn each head 25-40° away from the lens: ' +
        `${name(1)} turns toward ${name(2)} and looks AT THEIR FACE, ${name(2)} answers — talking, listening or laughing — ` +
        `and looks back at ${name(1)} or down at what they hold. Shoulders are angled, not squared to the camera. ` +
        'NEITHER of them looks into the lens. A frame where both faces are turned to the camera and smiling is a failure — ' +
        'if you have drawn that, turn the heads toward each other instead.'
      : 'FINAL STAGING CHECK — a candid moment, NOT a portrait. Turn the head 25-40° away from the lens and let the eyes follow it: ' +
        'looking down at what they hold, out of the window, or off-frame — absorbed in the moment, shoulders angled, not squared to the camera. ' +
        'Do not look into the lens unless the art director asked for it.',
  ];
}

/**
 * 인물 i 에게 줄 얼굴 각도 칸을 고른다 — 그 컷에서 고개가 실제로 돌아갈 방향의 칸.
 *
 * 왜: 생성에 들어가는 얼굴 참조(대표컷·표정컷)가 둘 다 정면이라, 고개를 돌리는 컷에서는
 * 모델이 옆얼굴을 스스로 지어냈다 — 실측 2026-09-23 에 유럽계 여성(W_A)이 동아시아 여성으로
 * 바뀌어 나왔다(얼굴 대조 40점). 시트에는 3/4·옆이 처음부터 있었는데 생성에는 안 들어갔다.
 *
 * 좌우 이름: 칸의 `_l` 은 얼굴이 **화면** 왼쪽을 향한 것, `_r` 은 오른쪽 (실측 확인).
 * base-gaze 가 읽어 주는 문장은 **인물** 기준("turned to their left")이라 좌우가 뒤집힌다 —
 * 인물의 왼쪽으로 돌면 화면에서는 오른쪽을 향하므로 `_r` 이다.
 */
function pickFaceAngle(spec: GenerationSpec, i: number): { url: string; kr: string; en: string } | undefined {
  const crops = spec.talents?.[i]?.faceCrops;
  if (!crops) return undefined;
  const n = spec.talents?.length ?? 0;
  const pick = (key: string, kr: string, en: string) => (crops[key] ? { url: crops[key], kr, en } : undefined);
  const q = (side: 'l' | 'r') =>
    side === 'l'
      ? pick('three_quarter_l', '3/4 · 화면 왼쪽', 'turned about 35° toward the LEFT side of the frame')
      : pick('three_quarter_r', '3/4 · 화면 오른쪽', 'turned about 35° toward the RIGHT side of the frame');
  const p = (side: 'l' | 'r') =>
    side === 'l'
      ? pick('profile_l', '옆모습 · 화면 왼쪽', 'in full profile facing the LEFT side of the frame')
      : pick('profile_r', '옆모습 · 화면 오른쪽', 'in full profile facing the RIGHT side of the frame');

  /*
   * 원본 인물을 교체하는 컷 — 원본이 보던 방향을 그대로 따른다 (인물 기준 ↔ 화면 기준 뒤집기 주의).
   * 단 시선을 읽지 못했으면(원본에 사람이 없거나 판독 실패) 아래의 연출 기본값으로 간다 —
   * 여기서 기본값을 쓰면 두 사람이 같은 쪽을 보게 된다.
   */
  if (recastsPeople(spec) && (spec.baseGaze ?? [])[i]) {
    const g = (spec.baseGaze ?? [])[i] ?? '';
    const profile = /\bprofile\b/i.test(g);
    if (/facing the camera|at the camera/i.test(g) && !profile) return undefined; // 정면 그대로면 각도 칸이 필요 없다
    if (/to their left/i.test(g)) return (profile ? p('r') : q('r')) ?? q('r');
    if (/to their right/i.test(g)) return (profile ? p('l') : q('l')) ?? q('l');
    return q('r');
  }

  // 인물을 새로 넣는 컷 — finalCandidLines 의 연출과 같은 방향으로 (PERSON 1 이 오른쪽의 상대를 본다)
  if (n > 1) return i === n - 1 ? q('l') : q('r');
  return q('r');
}

/**
 * 사람이 방향 지시를 안 썼을 때 대신 넣는 연출 지시 (한국어) — 프롬프트 맨 끝 "아트 디렉터 지시" 자리에 들어간다.
 * 그 자리는 "앞의 규칙과 부딪히면 이 지시가 이긴다" 로 읽히는 유일한 자리다 (실측: 사용자가 직접 쓴 지시는 잘 먹혔다).
 */
function autoDirection(spec: GenerationSpec): string {
  const n = spec.talents?.length ?? 0;
  if (!n || recastsPeople(spec) || spec.direction) return '';
  return n > 1
    ? '두 사람이 서로 마주 보며 대화하는 순간으로 연출해줘 — 한 사람은 말하고 다른 사람은 웃으며 듣는다. 고개는 렌즈에서 25~40도 돌아가 있고, 둘 다 카메라를 보지 않는다.'
    : '카메라를 의식하지 않는 순간으로 연출해줘 — 고개를 렌즈에서 25~40도 돌리고, 시선은 손에 든 것이나 창밖을 향한다.';
}

/** 배경 톤을 재려 했는데 실패했을 때 sceneTone 에 넣는 표시 — 톤 블록은 숫자 없이 "사진에서 직접 읽어라" 로 들어간다 */
export const SCENE_TONE_UNMEASURED = '__unmeasured__';

/**
 * 톤 맞추기 — 배경 사진에서 잰 수치로 "같은 카메라·같은 순간에 찍힌 사진" 을 요구한다.
 * 합성 티의 주범은 조명 방향보다 화이트밸런스·암부 깊이·채도·선명도 차이다 (제품 칸은 스튜디오 렌더라 전부 과하다).
 */
function toneBlock(spec: GenerationSpec): string[] {
  if (!spec.sceneTone) return [];
  const measured = spec.sceneTone !== SCENE_TONE_UNMEASURED;
  /*
   * 배경 합성(② 원본 + ⑥ 배경) — 인물·제품이 원본의 스튜디오 톤(평면광·그 방의 화이트밸런스·높은 채도)을
   * 그대로 달고 새 방에 붙는 게 합성 티의 전부였다 (사용자 지적 2026-09-22, 파스텔 3종 + 여성 B 컷).
   * 그래서 합성이면 "톤은 원본이 아니라 배경에서 온다" 를 먼저 못박고, 대상도 원본에서 가져온 것으로 짚는다.
   */
  const swap = isBackgroundSwap(spec);
  // 피부 — 톤 보정은 "그 방의 빛이 피부에 얹히는 것" 이지 피부색을 바꾸는 게 아니다 (피부색은 얼굴 시트가 정한다)
  const who = swap
    ? 'every person (skin, hair and clothing — each person\'s own skin colour stays as ' +
      (spec.talents?.length ? 'their identity sheet shows' : 'in the source photograph') +
      '; only the room\'s light and colour cast fall on it) and every product'
    : spec.talents?.length ? 'every product and person' : 'every product';
  // 합성엔 사진이 둘 — "그 사진" 이 원본으로 읽히지 않게 배경을 이름으로 부른다 (검토 2026-09-22)
  const target = swap ? 'the BACKGROUND photograph' : 'that photograph';
  // 색 hex 가 위에 적혀 있을 때만 그 문장을 가리킨다 — 원본 속 제품만 있는 합성 컷에는 hex 가 없다
  const hasHex = (spec.products ?? []).some((p) => !!p.color?.hex);
  return [
    /*
     * 채도는 방의 톤을 따라 누그러뜨리는 게 원래 설계다 (2026-09-14 "너무 AI 합성 느낌", PRODUCT RELIGHT 의 "mute its colours").
     * 2차 검토 때 "평균 채도는 제품 목표가 아니다" 를 넣었다가 그 설계·RE-GRADE 와 부딪혀 뺐다 (3차 확인 2026-09-22).
     * 색이 딴 색으로 바뀌는 것만 아래 "never recolour" 가 막는다.
     */
    measured
      ? `SCENE TONE (measured from the ${swap ? 'BACKGROUND' : 'supplied'} photograph): ${spec.sceneTone}.`
      // 측정 실패(사진을 못 받음 등) — 톤 맞춤 자체는 빠지면 안 된다 (사용자 지시 2026-09-22: "배경 고르면 조명 맞춤은 필수")
      : `SCENE TONE — read it directly from the ${swap ? 'BACKGROUND' : 'supplied'} photograph: its white balance (warm, neutral or cool), ` +
        'exposure, contrast, how deep its darkest shadows go, how saturated its colours are, and which side its main light comes from.',
    ...(swap
      ? ['TONE COMES FROM THE BACKGROUND, NOT FROM THE SOURCE — the source photograph was lit somewhere else (typically a studio: flat front light, ' +
          'its own white balance, clean shadows and its own saturation). None of that survives: the people and products are RE-LIT and RE-GRADED ' +
          'to the background photograph exactly as described below, as if they had been photographed in that room.']
      : []),
    `PHOTOGRAPHIC MATCH — render ${who} as if captured by the same camera in the same moment as ${target}, not composited: ` +
      "the same white balance (fabric colours shift toward the room's warmth or coolness exactly as real fabric would under that light), " +
      'shadows on the products no darker than the darkest shadows already in the room, the same contrast and saturation level, ' +
      'the same softness of light and shadow edges, the same sharpness, depth of field, lens perspective, camera height, noise and grain. ' +
      "Light reaches them from the same side as the room's own light: a brighter side facing the light source, a softer shaded side away from it, " +
      'and cast shadows falling the same way as the shadows of objects already in the room. ' +
      'Add a soft contact shadow and ambient occlusion where each product meets the floor, and gentle colour bounce from the floor and walls onto the fabric. ' +
      (hasHex
        ? "The hex colours above are the fabric's true dye colour under neutral daylight — show that same fabric as it would photograph in THIS room. "
        : 'Each fabric keeps its own colour identity (a lavender stays lavender, a mint stays mint, a pink stays pink) — only the light on it changes. ') +
      "Shift each colour's warmth and brightness by the same amount the room's light shifts the white and neutral surfaces already in the photograph — " +
      'never recolour a product into a different colour, and never keep the flat studio look. ' +
      'Any subject that looks cleaner, brighter, more saturated, higher-contrast or sharper than the room reads as an AI composite and is a failure.',
  ];
}

/** 제품 블록 — 12차 실측 4종 세트 */
function productBlock(spec: GenerationSpec): string[] {
  const products = spec.products ?? [];
  if (!products.length) return [];
  const multi = products.length > 1;
  const L: string[] = [];
  /*
   * 사람 없는 제품 컷 — USE(사용법) 문장을 넣지 않는다.
   * 실측 사고(2026-09-14 피라미드): 사람이 없는데 "경사면에 기대 앉거나, 눕혀서 로운저로 쓴다" 가 들어가자
   * 모델이 피라미드를 눕히고 앉은 뒤처럼 눌린 모양으로 그렸다. 사용법 문장은 곧 "그 상태를 그려라" 로 읽힌다.
   * 대신 빈 상태·레퍼런스와 같은 놓임새·눌림 없음을 제품마다 못박는다.
   * (포즈 소스 컷이 있어도 사람이 없으면 같다 — 포즈 역할도 "눌림 복사 금지" 로 이미 제한돼 있다)
   */
  const noPeople = !(spec.talents?.length);
  // 편집 베이스면 AI 제품 칸이 참조로 안 붙는다 — 없는 이미지를 가리키는 문장을 쓰지 않는다
  const baseEdit = hasEditBase(spec);
  const poseControls = hasPoseSource(spec);

  if (multi) {
    L.push(
      `PRODUCTS — ${products.length} different Yogibo products in one scene. ` +
        'Each is a separate product with its own shape and colour; do not merge them, ' +
        'do not give them the same shape, and do not swap their colours:',
    );
  }

  /*
   * 조합 배치 — 제품 블록의 맨 앞이다. 뒤로 밀면 모델이 덜 읽는다 (긴 프롬프트는 후반부 가중치가 떨어진다).
   * 이 컷이 실패하는 방식은 언제나 같다: 두 제품이 한 덩어리 쐐기로 뭉치고 높이 차가 사라진다.
   */
  if (spec.combo?.staging?.length) {
    L.push('');
    L.push(`HOW THE ${spec.combo.lines.map((l) => `Yogibo ${l}`).join(' AND THE ')} SIT TOGETHER — this is the point of the shot:`);
    for (const line of spec.combo.staging) L.push(`  ${line}`);
    L.push('');
  }

  L.push(...relativeSizeLines(products));

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
    // 단일 제품도 위치를 고를 수 있다 — 다중은 머리(where)에 이미 박혀 있다
    if (!multi && p.placement) L.push(`  PLACEMENT: put the product ${wherePhrase(p.placement)} of the frame.`);
    const placeRef = baseEdit ? undefined : (p.views ?? []).find((v) => v.source === 'sheet' && v.primary);
    if (placeRef && !poseControls) {
      const ang = placeRef.angleEn ?? ANGLE_EN[placeRef.angle] ?? placeRef.angle;
      L.push(POSTURE_KEYS.has(placeRef.angle)
        ? `  POSTURE: ${ang}, exactly as in its placement reference image.`
        : `  CAMERA ANGLE ON THIS PRODUCT: the ${ang}, exactly as in its placement reference image.`);
    }
    L.push(spec.keepRealTags
      ? '  LOGO: only the real sewn tag already on this product in the base photograph, kept as photographed (see BRAND TAGS) — never add one.'
      : '  LOGO: none — plain fabric with no brand tag, label, patch or lettering (mandatory).');
    /*
     * 윗부분 말림 금지 — 피라미드만 끝이 뾰족한 게 정상이다 (사용자 지시 2026-09-15: "저런 식으로 말리는 게 너무 많다").
     * 사람이 기대면 빈백 윗부분이 뒤로 접히거나 말리거나 꺾인 꼭지로 그려진다.
     * 부정문만으로는 안 먹혔다(drop-peak 기록: "NOT a teardrop with a pointed tip" 이 들어간 33장 중 다수에서 꼭지) —
     * 먼저 "어떤 모양이어야 하는지"를 긍정문으로 그리고, 금지는 마지막 한 줄로만 둔다.
     */
    if (TOP_FORM_LINES.has(p.line)) {
      /*
       * 둥근 빈백(Drop·Pod)은 "위로 갈수록 좁아지는 물방울" 이 가장 흔한 불량이다
       * (비전 검사 실측 2026-09-15: 최근 Drop 인물컷 4장 모두 물방울 꼭지) — 공 윗면처럼 넓게 끝난다고 따로 그린다.
       * 편집 베이스는 사진 속 빈백 형태를 그대로 지키는 게 원칙이라, "새로 그리거나 다시 그리는 빈백" 에만 건다
       * (실제 사진 속 빈백은 말려 있지 않다 — 베이스에 빈백이 없어 새로 그리는 경우가 이 규칙의 대상).
       */
      const ball = p.line === 'Drop' || p.line === 'Pod';
      const scope = baseEdit
        ? 'Wherever this bean bag is drawn or re-rendered (a bean bag already photographed in the base keeps its photographed shape), its upper part stays FULL and ROUNDED'
        : 'The upper part of this bean bag stays FULL and ROUNDED';
      L.push(
        `  TOP FORM: ${scope} — its top edge is one smooth, continuous convex arc held up by the filling, ` +
          (ball
            ? 'as broad and round as the top of a ball: the silhouette keeps nearly its full width all the way up and closes in a wide, rounded crown. '
            : 'like the top of a well-stuffed pillow. ') +
          (noPeople && !baseEdit
            ? 'The whole top stays a plump, upright, rounded dome. '
            : 'Where a person leans back, only the fabric directly under their back compresses; the part above and behind their shoulders stays a plump, upright, rounded dome. ') +
          'It never narrows into a teardrop, folds over, flops backwards, curls, rolls or bends into a tip.',
      );
    }
    if (baseEdit) {
      // 편집 베이스 — 제품 상태는 베이스 사진이 정한다 (사람이 앉아 있을 수도 있다)
    } else if (noPeople) {
      L.push(
        `  STATE: EMPTY — nobody sits, leans or lies on it. It stands in its normal resting position ${placeRef ? 'exactly as in its placement reference image' : 'as in its reference photographs'}, ` +
          'fully inflated and taut: no dents, no seat hollow, no slumped or sagging top, no sitting creases, never tipped over or laid down on its side.',
      );
    } else {
      L.push(`  USE: ${p.staging || p.modes}.`);
    }
  });
  /*
   * 공식 뷰는 제품을 눕혀/세워 놓고 찍은 "기본 자세"다.
   * 실사고(Max 초코브라운): 누운 로그형 뷰 + 착석 포즈 베이스를 모델이 멋대로 합쳐
   * 거대한 크레센트로 구부렸다. 뷰에서 가져올 것은 형태·치수뿐이고,
   * 장면 속 놓임새는 포즈가 정하되 껍데기 자체는 못 바꾼다고 못박는다.
   */
  L.push(
    noPeople && !baseEdit
      /* 사람이 없으면 놓임새를 바꿀 이유가 없다 — 눕히거나 세우는 순간 형태가 다른 물건이 된다 */
      ? 'PRODUCT VIEWS show each product in its resting orientation, and with nobody in this image each product KEEPS exactly the orientation and stance ' +
        'shown in its placement reference — do not tip it over, lay it down, turn it onto another face or pose it like furniture in use. ' +
        'Its shell keeps the exact shape and true dimensions from the views — never bend, curl, stretch, flatten, deflate or merge a product to fit the composition.'
      : 'PRODUCT VIEWS show each product in its factory resting orientation. In the scene, position the product however ' +
        'the pose and staging require, BUT its shell keeps the exact shape and true dimensions from the views — ' +
        'never bend, curl, stretch, inflate or merge a product to fit a pose, a person or the composition.',
    /*
     * 뷰 사진 > 텍스트 서술 — 형태가 생성마다 흔들리는 사고(라운저 등받이 각도·좌석 비례)의 대책.
     * 글로는 각도·비례를 다 못 박는다. 사진을 형태의 최종 기준으로 못박는다.
     */
    'THE VIEW PHOTOGRAPHS ARE GROUND TRUTH for each product\'s shape. Match their silhouette EXACTLY — ' +
      'the same backrest angle, the same seat-to-back proportion, the same curvature and stance. ' +
      'If this text and the photographs ever disagree, FOLLOW THE PHOTOGRAPHS.',
    /*
     * 빈 제품 눌림 금지 — 전 제품 공통 선언 (사용자: "이게 가장 중요").
     * 드롭·팟·라운저·피라미드 개별 정의에도 있지만, 엔진(제미나이·GPT·힉스필드)이
     * 무엇을 그리든 공통으로 받도록 여기서 한 번 더 못박는다.
     */
    'UNOCCUPIED PRODUCTS STAY FULLY INFLATED: a bean bag with nobody on it is taut, plump and full — ' +
      'never render dents, sitting hollows, sunken tops, creased pockets or sagging on an empty product. ' +
      'Fabric compresses ONLY at the exact spots where a person is actually in contact, and nowhere else.',
  );
  /*
   * 제품 뷰 조명 복사 금지 — 배경·베이스 합성에서 합성티의 주범 (실측: 스튜디오 렌더의
   * 평면광·채도가 방에 그대로 붙어 들어옴). 인물용 RELIGHT 와 같은 원리를 제품에도 건다.
   * 순수 스튜디오 썸네일(배경 없음)에서는 스튜디오 룩이 정답이라 안 붙인다.
   */
  /*
   * 배경 사진에 빈백을 채울 때 기존 가구가 걸리면 지운다 (사용자 지시 2026-09-14).
   * 배경 사진의 가구를 전부 지켜야 할 대상으로 읽으면, 모델은 빈백을 가구 틈에 욱여넣거나
   * 작게 줄이거나 가구 뒤에 숨긴다. 공간(벽·창·바닥·조명)은 지키되 걸리는 물건은 치운다.
   * 편집 베이스(base)가 아니라 배경(background)으로 쓸 때만 — 베이스는 원본 그대로가 원칙이다.
   * local 템플릿과 Opus 브리프가 이 블록을 같이 쓰므로 여기에 둔다.
   */
  const onBackground = spec.clearBlockingFurniture !== false
    && (!spec.baseCut || spec.baseCut.usage === 'pose') && (spec.uploadedRefs ?? []).some((u) => u.role === 'background')
    && !(spec.uploadedRefs ?? []).some((u) => u.role === 'base');
  if (onBackground) {
    L.push(
      'CLEAR THE PLACEMENT AREA — the background photograph supplies the room, but its existing furniture and objects are NOT fixed: ' +
        'if a sofa, armchair, coffee table, side table, shelf, plant or any other piece of furniture stands where the bean bag' + (multi ? 's need' : ' needs') + ' to go, ' +
        'or would overlap, block, crowd or hide ' + (multi ? 'them' : 'it') + ', REMOVE that object completely and rebuild the floor, ' +
        'wall and skirting behind it seamlessly. Furniture that does NOT get in the way stays exactly where it is, and a rug may simply stay under a bean bag. ' +
        'Keep the room itself unchanged — walls, windows, floor material, ceiling and light. ' +
        'Never shrink, squeeze, tilt or partially hide a bean bag to make it fit around existing furniture.',
    );
  }
  const inScene = (!!spec.baseCut && spec.baseCut.usage !== 'pose')
    || (spec.uploadedRefs ?? []).some((u) => u.role === 'base' || u.role === 'background');
  if (inScene) {
    L.push(
      'PRODUCT RELIGHT — the product view photographs are flat STUDIO shots on a plain background: take ONLY ' +
        'each product\'s shape, proportions, colour identity and fabric from them (never a tag or logo). NEVER copy their studio ' +
        'lighting, white balance, saturation or clean studio sharpness into this scene. Re-light every product ' +
        'entirely with THIS scene\'s light — same direction, warmth, softness and shadows as the room around it, ' +
        'with natural colour bounce from nearby surfaces — and mute its colours into the scene\'s palette. ' +
        'A product that looks brighter, sharper or more saturated than its surroundings reads as pasted-on and is a failure.',
    );
  }
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
 * 사람 ↔ 제품 크기 짝짓기 (사용자 지시 2026-09-16).
 *
 * 문제: 아동B(120cm)로 라운저를 뽑든 어른(175cm)으로 뽑든 화면 속 라운저가 같은 크기로 보인다.
 * 원인: 프롬프트가 제품 치수(EXACT SIZE)와 사람 키(BODY)를 각각 따로만 말한다. 둘을 이어주는 문장이 없으면
 * 모델은 "빈백은 사람이 앉기 좋은 크기" 라는 평균값으로 그려버린다 — 사람이 작아져도 제품이 같이 작아진다.
 * 대책: 사람 한 명 × 제품 한 종마다 두 숫자를 한 문장에 다시 넣고(제품 치수 + 그 사람 키),
 * 배율과 몸의 어디까지 오는지를 적는다. 그리고 "제품 크기는 고정, 달라지는 건 사람" 을 못박는다.
 */
/**
 * 짝 문장에 쓸 제품 — ③ 에서 고른 제품이 있으면 그것, 없으면 ② 사진 속 제품(scaleProduct).
 * 사진 속 제품을 골라도 짝 문장이 안 만들어져, 더블을 넣은 컷이 "170cm 맥스" 기준으로 작게 나왔다 (사용자 지적 2026-09-22).
 */
function pairingProducts(spec: GenerationSpec): Pick<ProductSpec, 'line' | 'dims'>[] {
  if (spec.products?.length) return spec.products;
  return photoProducts(spec).map((x) => ({ line: x.line, dims: x.dims }));
}

/** ② 사진 속 제품 목록 — 여러 개(scaleProducts)가 있으면 그것, 없으면 예전 하나짜리(scaleProduct) */
function photoProducts(spec: GenerationSpec): PhotoProduct[] {
  if (spec.scaleProducts?.length) return spec.scaleProducts;
  return spec.scaleProduct ? [spec.scaleProduct] : [];
}

/**
 * 사진 속 제품 블록 — 무엇인지(형태·아닌 것)·치수·"사진 속 자리 그대로".
 * ③ 에서 제품을 고르지 않고 원본 사진의 제품을 그대로 쓰는 편집에서만 (③ 을 고르면 productBlock 이 이 일을 한다).
 * 실측 사고 (2026-09-22): 팟 위에 얹힌 서포트(ㄷ자 쿠션)를 모델이 목베개로 읽고 사람 목에 둘렀다 —
 * 형태 서술의 "NOT a neck pillow" 가 있었지만 서포트를 고를 칸이 없어 프롬프트에 안 들어갔다.
 */
function photoProductsBlock(spec: GenerationSpec): string[] {
  const list = photoProducts(spec);
  const hasBase = !!spec.baseCut || (spec.uploadedRefs ?? []).some((u) => u.role === 'base');
  if (!list.length || !hasBase || spec.products?.length) return [];
  const L = ['PRODUCTS ALREADY IN THE BASE PHOTOGRAPH — these are the real Yogibo products in it; identify each one and keep it as that product:'];
  for (const p of list) {
    const d = p.dims || {};
    const dims = [d.w && `${d.w}cm wide`, d.d && `${d.d}cm deep`, d.h && `${d.h}cm tall/long`].filter(Boolean).join(' x ');
    L.push(
      `  - Yogibo ${p.line}${dims ? ` (${dims})` : ''}: ${p.shape || p.scalePrompt}.` +
        (p.negative ? ` It is ${p.negative}.` : '') +
        (p.modes ? ` Real use: ${p.modes}.` : ''),
    );
  }
  L.push(
    '  Every one of them stays where and how it sits in the base photograph — the same position, orientation and arrangement relative to ' +
      'the others (a product resting on top of another stays resting there). Never wear, drape, wrap or hang any of them on a person, never ' +
      'lift or carry them, and never move them to a new spot; people only sit, lean or rest on them as each product\'s real use allows.',
  );
  return L;
}

function scalePairingLines(products: Pick<ProductSpec, 'line' | 'dims'>[], talents: TalentSpec[]): string[] {
  const sized = products.filter((p) => Math.max(p.dims?.w ?? 0, p.dims?.d ?? 0, p.dims?.h ?? 0) > 0);
  const people = talents
    .map((t, i) => ({
      i,
      cm: Number((t.sizeEn.match(/(\d{2,3})\s?cm/) || [])[1] || 0),
      // composeSize 가 아동·틴에는 'child proportions' / 'pre-teen proportions' 를 붙인다 (키 숫자보다 확실한 판단 근거)
      child: /child|pre-?teen/i.test(t.sizeEn),
    }))
    .filter((x) => x.cm > 0);
  if (!sized.length || !people.length) return [];

  // 세워 놨을 때의 높이가 사람 몸의 어디에 오는가 — 배율만 주면 모델이 잘 못 읽는다
  const landmark = (ratio: number) =>
    ratio < 0.20 ? 'mid-shin'
      : ratio < 0.26 ? 'just below the knee'
        : ratio < 0.31 ? 'knee'
          : ratio < 0.36 ? 'just above the knee'
            : ratio < 0.41 ? 'mid-thigh'
              : ratio < 0.47 ? 'upper thigh'
                : ratio < 0.53 ? 'hip'
                  : ratio < 0.60 ? 'waist'
                    : ratio < 0.68 ? 'lower ribs'
                      : ratio < 0.78 ? 'chest'
                        : ratio < 0.88 ? 'shoulder'
                          : ratio < 0.97 ? 'chin'
                            : ratio < 1.06 ? 'the top of their head'
                              : 'well above their head';

  const L: string[] = [
    'SIZE PAIRING — the product sizes and the body sizes below are real measurements. Read them together: ' +
      'a Yogibo never changes its real size between images; only the person does. The SAME product must therefore ' +
      'look markedly LARGER against a small child than against a tall adult — it spans more of their body and rises ' +
      'higher up them. Never scale a product up or down to "fit" the person.',
  ];
  for (const p of sized) {
    const d = p.dims ?? {};
    const longest = Math.max(d.w ?? 0, d.d ?? 0, d.h ?? 0);
    const upright = d.h ?? longest;
    const dims = [d.w && `${d.w}cm wide`, d.d && `${d.d}cm deep`, d.h && `${d.h}cm tall`].filter(Boolean).join(' x ');
    for (const person of people) {
      const who = talents.length > 1 ? `PERSON ${person.i + 1}` : 'the model';
      const rHeight = upright / person.cm;
      const rLong = longest / person.cm;
      /*
       * 아동은 어른 컷의 크기를 그대로 베끼는 사고가 가장 잦다 (사용자 실측: 아동B 라운저가 어른 컷과 같은 크기).
       * 아동일 때는 배율만으로 부족해서 "어른 옆에서보다 눈에 띄게 커야 한다" 를 한 줄 더 못박는다.
       */
      const child = person.child || person.cm < 150;
      L.push(
        `  Yogibo ${p.line} (${dims}) vs ${who} (${person.cm}cm tall): standing beside them the product reaches about ` +
          `${landmark(rHeight)} — its ${upright}cm height is ${rHeight.toFixed(2)}x their ${person.cm}cm height, and its ` +
          `longest side (${longest}cm) is ${rLong.toFixed(2)}x their height. Seated or leaning on it, keep exactly this ratio.` +
          (child
            ? ` ${who} is a child, so this product must read visibly BIGGER against their body than it would against a 175cm adult:`
              + ` it swallows more of them, its top sits higher on them, and their limbs look short against it.`
            : ''),
      );
    }
  }
  return L;
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
    if (baseAnchored && !recastsPeople(spec)) {
      /*
       * 인물 추가(add-person)만 — 바꿀 원본 인물이 없으니 "원본 인물이 자" 라는 전제가 틀린다.
       * 사진 속 빈백·가구·카메라가 자다 (2차 검토 2026-09-22).
       */
      L.push(
        'SCALE — the base photograph\'s bean bags and furniture are the SIZE YARDSTICK. Seat each added person at their own stated real ' +
          'height against them, on the same floor plane' +
          (isBackgroundSwap(spec)
            ? '; the camera height and perspective come from the BACKGROUND room (see SCALE FROM THE ROOM).'
            : ', with the photo\'s own camera height and perspective.') +
          ' Heads and faces must not be enlarged.',
      );
      if (heights.length) L.push(`  Real heights: ${heights.join(', ')}. Keep these height proportions between the people.`);
    } else if (baseAnchored) {
      /*
       * 「원본 인물 크기 그대로」 는 같은 또래끼리 바꿀 때만 맞다.
       * 실측 사고 (2026-09-22): 13살쯤 된 원본 소년 자리에 아동 C(6살·116cm)를 넣자 "크기는 원본 그대로 · 얼굴·머리·옷만" 과
       * "나이는 시트대로" 가 정면으로 부딪혀, 모델이 교체를 포기하고 원본 소년을 그대로 남겼다 (얼굴 대조 40점).
       * 판단 기준은 키가 아니라 나이대다 — "키가 다르면 시트 키" 로 두면 성인끼리 교체도 키 몇 cm 차이로
       * 크기가 바뀌어 머리가 커지는 옛 사고가 돌아온다 (2차 검토 2026-09-22). 성인 둘은 늘 같은 나이대로 본다.
       */
      const SAME = 'Where you replace a person with someone of the SAME age group (young child / pre-teen / teen / adult — any two adults ' +
        'count as the same group, whatever their heights), ';
      const DIFF = 'Where the replacement is in a clearly DIFFERENT age group (for example a small child replacing a teenager), THE SHEET WINS: ';
      if (isBackgroundSwap(spec)) {
        /*
         * 배경 합성 — 원본은 사람↔빈백 비율만 준다. 화면 속 크기·카메라 높이·원근은 새 배경 방이 정한다.
         * 원본을 "방·카메라의 자" 라고 하면 COMPOSITE·SCALE FROM THE ROOM(배경이 정한다)과 정면으로 부딪힌다 (검토 2026-09-22).
         */
        L.push(
          'SCALE — the SOURCE photograph shows each person at the correct size RELATIVE TO THE BEAN BAG they use. ' + SAME +
            'keep that person-to-bean-bag ratio, the same seat contact and the same way their weight compresses the bean bag. ' + DIFF +
            'rebuild the whole body at the replacement\'s own stated age and height, keeping the same spot, the same kind of pose and the same ' +
            'interaction (what they hold, what they lean on, whom they look at). A size mismatch is NEVER a reason to keep the original person. ' +
            'Their size IN THE FRAME, the camera height and the perspective come from the BACKGROUND room (see SCALE FROM THE ROOM), never ' +
            'from the source frame. Heads and faces must not be enlarged.',
        );
        if (heights.length) L.push(`  Real heights: ${heights.join(', ')}. Within the same age group (any two adults included) keep the source person's size relative to the bean bag; where the age group clearly differs, these heights win.`);
      } else {
        L.push(
          'SCALE — the base photograph already shows real people at the correct real-world size against the furniture, so it is the ' +
            'SIZE YARDSTICK for the room, the camera and the bean bag. ' + SAME + 'keep that person\'s EXACT size and footprint — same ' +
            'height in the frame, same seat contact, same way their weight sinks into and compresses the bean bag, same limb placement. ' + DIFF +
            'rebuild the whole body at the replacement\'s own stated age and height against the furniture — the figure becomes smaller or ' +
            'larger in the frame while keeping the same spot, the same kind of pose and the same interaction (what they hold, what they lean ' +
            'on, whom they look at). A size mismatch is NEVER a reason to keep the original person. Any newly added person must be rendered ' +
            'at a true-to-life scale against the same furniture. Heads and faces must not be enlarged.',
        );
        if (heights.length) L.push(`  Real heights: ${heights.join(', ')}. Within the same age group (any two adults included) the base person's on-screen size wins; where the age group clearly differs, these heights win.`);
      }
    } else {
      L.push(
        'SCALE — render every person at ONE consistent, true-to-life human scale, correct relative to each other AND to ' +
          'every piece of furniture in the frame. Heads and faces must not be enlarged.',
      );
      if (heights.length) L.push(`  Real heights: ${heights.join(', ')}. Keep these height proportions between the people.`);
    }
    // 사람 ↔ 제품 두 숫자를 한 문장에 다시 — 아동/어른이 같은 크기 제품으로 나오는 문제 대책
    L.push(...scalePairingLines(pairingProducts(spec), talents));
  }

  const sps = photoProducts(spec);
  if (sps.length) {
    for (const sp of sps) {
      const d = sp.dims || {};
      const dims = [d.w && `${d.w}cm wide`, d.d && `${d.d}cm deep`, d.h && `${d.h}cm long/tall`].filter(Boolean).join(' x ');
      L.push(
        `  The Yogibo ${sp.line} in this scene measures ${dims || 'its real size'} — ${sp.scalePrompt}.` +
          (talents.length
            ? ' Size every person against it: do not shrink the people so it looks oversized, nor enlarge them so it looks like a small cushion.'
            : ' Its bulk must read correctly next to the sofas, tables and counters in the space.'),
      );
    }
    /*
     * 제품끼리 크기 비교(relativeSizeLines)는 넣지 않는다 — 원본 사진이 실제 크기 관계를 이미 보여 주고,
     * 그 문장의 "같은 바닥에 서 있다" 가 "위에 얹힌 제품은 그대로 얹혀 있게"(사진 속 제품 블록)와 부딪힌다.
     */
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
      // 합성엔 사진이 둘 — "그 사진" 이 원본으로 읽히지 않게 배경을 이름으로 부른다 (검토 2026-09-22)
      (isBackgroundSwap(spec)
        ? '  Integrate every person and product seamlessly INTO the BACKGROUND photograph, not pasted on top: match the BACKGROUND photograph\'s '
        : '  Integrate every person and product seamlessly INTO the photograph, not pasted on top: match the photo\'s ') +
        'lighting direction and softness, its depth of field and photographic grain. Where a person touches a bean bag ' +
        'or the floor, the surface must visibly dent and compress under their weight, with a soft contact shadow in the ' +
        'crease and correct ambient occlusion. The product casts a soft grounded shadow on the room\'s floor. No hard ' +
        'cut-out edges, no floating, no sticker look — same lens, same grain, same colour temperature as ' +
        (isBackgroundSwap(spec) ? 'the BACKGROUND photograph.' : 'the photo.'),
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
        'erase the whole person, not just the face. ' +
        // 합성이면 원본의 방은 버린다 — 지운 자리에 원본 바닥·러그를 되살리라고 하면 버린 방이 돌아온다 (2차 검토 2026-09-22)
        (isBackgroundSwap(spec)
          ? 'Reconstruct the product surface, its seams and silhouette where they were (the room itself comes from the background image), ' +
            'all consistent with the surrounding lighting and shadows. '
          : 'Reconstruct whatever was behind them: the product surface, its seams and silhouette, the floor, the rug and the background, ' +
            'all consistent with the surrounding lighting and shadows. ') +
        'No ghosting, no leftover limbs, no blurred smear where a person used to be. ' +
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
    /*
     * 키 설명의 "— slightly shorter than the 170cm Max" 는 맥스를 기본 자로 쓰던 시절의 문구다(model-profile.ts).
     * 이 컷에 맥스가 아닌 제품(예: 더블)이 있으면 그 제품과의 짝 문장(SIZE PAIRING)이 따로 들어가므로 맥스 비교는 뺀다 —
     * 남겨 두면 더블 컷에서도 맥스를 기준으로 떠올린다 (사용자 지적 2026-09-22, 더블이 작게 나온 컷).
     */
    const pairLines = pairingProducts(spec).map((x) => x.line);
    const bodyEn = pairLines.length && !pairLines.includes('Max')
      ? t.sizeEn.replace(/\s*—\s*(?:the same length as|(?:slightly|clearly) (?:taller|shorter) than) the 170cm Max/, '')
      : t.sizeEn;
    L.push(`  BODY: ${bodyEn}.`);
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
          '(same colour, fabric and style, sized to the new person\'s own body — a smaller child wears a child-sized version), ' +
          'with the collar and neckline redrawn to meet the new head, neck and hair.',
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
      /*
       * 교체(person·face)일 때만 "원본 인물의 시선을 그대로" 가 말이 된다.
       * 인물 추가(add-person)는 원본에 그 사람이 없어서 그 문장이 아무것도 지시하지 못했고, 정면 얼굴 참조가 이겨
       * 둘 다 카메라를 응시했다 (사용자 지적 2026-09-23 "자연스럽게 대화하는 연출이면 더 좋은데").
       */
      recastsPeople(spec)
        ? 'GAZE & HEAD DIRECTION — each replaced person keeps the head angle and EYELINE of the person they replace ' +
          'in the base photograph: if they were looking at each other, at the product, down at a book or off-frame, ' +
          'the new person looks the SAME way. Never rotate a head toward the camera just because the identity or ' +
          'expression references are frontal portraits — copy the expression, never the reference\'s eyeline.' +
          /*
           * 원본이 어디를 보는지 실제로 읽어 적는다 (base-gaze.ts) — "원본 그대로" 만으로는 안 지켜졌다
           * (실측 2026-09-23: 옆을 보던 두 사람이 둘 다 카메라를 응시).
           */
          ((spec.baseGaze ?? []).length
            ? `\n  In the base photograph, read from it: ${spec.baseGaze!.join(' / ')}. Keep each of these exactly — the new face is turned and looks the same way.`
            : '')
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
      // 키·체격이 아니라 나이대로 가른다 — 성인끼리의 키 차이로 몸 크기를 바꾸지 않게 (크기는 SCALE 이 정한다, 2차 검토 2026-09-22)
      'AGE IS LOCKED to what the sheet and the stated age say. Do not age a person up or down to suit the body, pose, ' +
        'clothing or seat of the figure they are replacing. If the person being replaced is visibly younger or older ' +
        '(a different age group), the SHEET WINS — rebuild the head, face and proportions to match the sheet and ' +
        'let the pose adapt around them; body size follows SCALE.',
      /*
       * 교체 누락 — 원본 인물과 시트 인물의 나이·피부색·머리색이 크게 다르면 모델이 교체를 건너뛰고 원본을 남긴다
       * (실측 2026-09-22: 흑인 10대 소년 자리의 금발 6살 아동 C → 원본 소년이 그대로 나옴).
       * "모든 교체는 필수, 원본의 인종·피부색·머리색·나이는 하나도 안 남는다" 를 따로 못박는다.
       * 원본 인물을 바꾸는 흐름(person·face)에서만 — 인물 추가(add-person)는 바꿀 사람이 없다.
       * 옷·크기는 각자 OUTFIT 줄·SCALE 이 정한다 (옷 유지 설정과 부딪히지 않게 여기서 단정하지 않는다).
       */
      ...(recastsPeople(spec)
        ? ['EVERY LISTED PERSON IS REPLACED — no exception. A result in which any base person is still recognisably the original ' +
            'person (their face, skin tone, ethnicity, hair colour or age) is a failure, however different the sheet person looks from them. ' +
            'The replacement takes the skin tone, ethnicity, hair colour and age from the identity sheet — nothing of the base person\'s face, ' +
            'skin tone, ethnicity, hair or age survives. From the base person keep the pose, position and interaction, the garment only where ' +
            'the OUTFIT line says so, and the size only as SCALE says.']
        : []),
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
        // 짧은 머리 시트(아동 C 등)에 "어깨로 흘러내린다" 를 주면 머리가 길어진다 — 길이는 시트가 정한다 (2차 검토 2026-09-22)
        'share one skin tone; no brightness, colour or sharpness step at the jawline or collar; hair (at whatever length ' +
        'the sheet shows) sits naturally and casts a soft shadow where it meets the skin or clothing; the head\'s size, angle and perspective sit ' +
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

/**
 * 보존 강도 프리셋 본문 — 드롭박스 실촬영본이면 "every product stays plain with no logo or tag" 구절을 뺀다.
 * 그 구절이 남으면 BRAND TAGS(진짜 태그 유지)와 정면으로 부딪힌다. 프리셋은 DB(preservation_modes)에 있어 여기서 걸러낸다.
 */
function presetBody(spec: GenerationSpec, instruction: string): string {
  const t = instruction.trim();
  return spec.keepRealTags ? t.replace(/,?\s*and every product stays plain with no logo or tag/i, '') : t;
}

/** 보존 강도 프리셋의 첫 줄(「IMAGE PRESERVATION LEVEL: MODERATE」) — 합성에서는 본문 대신 이 줄만 쓴다 */
function swapPreservationHeader(instruction: string): string {
  return instruction.trim().split(/\r?\n/)[0];
}

/** 원본 인물을 전속 모델로 바꾸는 편집인가 — 인물 추가(add-person)는 바꿀 원본 인물이 없어서 아니다 */
function recastsPeople(spec: GenerationSpec): boolean {
  const hasBase = !!spec.baseCut || (spec.uploadedRefs ?? []).some((r) => r.role === 'base');
  return hasBase && !!spec.talents?.length && (spec.editTargets ?? []).some((x) => x === 'person' || x === 'face');
}

/**
 * 원본 사진과 뽑을 규격의 비율이 다를 때 — 구도는 그대로 두고 가장자리만 늘린다 (사용자 결정 2026-09-23).
 *
 * 왜: 3:2 사진을 1:1 로 뽑으면 모델이 빈 자리를 채우려고 장면을 다시 구성한다. 실측(크리스마스 컷)에서
 * 두 사람의 시선이 옆에서 카메라로 바뀌고, 왼쪽에 앉아 있던 사람이 사라지고 양말 신은 발만 남았고,
 * 회색 빈백 모양이 변했다("맥스가 아니다" 판정). 프롬프트의 "원본 그대로·같은 프레이밍" 은 규격이 다르면 지킬 수가 없다.
 * 그래서 늘릴 방향(위아래/좌우)을 집어서 outpaint 로만 채우게 하고, 뒤에 오는 구도 문장보다 우선한다고 적는다.
 */
function framePreserveLines(spec: GenerationSpec): string[] {
  const hasBase = !!spec.baseCut || (spec.uploadedRefs ?? []).some((u) => u.role === 'base');
  if (!hasBase || !spec.baseAspect || spec.baseCut?.usage === 'pose') return [];
  const [gw, gh] = String(spec.size.genAspect || '').split(':').map(Number);
  const target = gw && gh ? gw / gh : spec.size.width / spec.size.height;
  if (!target) return [];
  if (Math.abs(spec.baseAspect - target) / target < 0.05) return []; // 거의 같은 비율이면 아무 말도 하지 않는다
  const r = (v: number) => (v >= 1 ? `${v.toFixed(2)}:1` : `1:${(1 / v).toFixed(2)}`);
  const wider = spec.baseAspect > target;
  return [
    `FRAME — the base photograph is ${r(spec.baseAspect)} and the picture you must deliver is ${r(target)}. ` +
      'Do NOT re-compose, re-frame, zoom into, crop or re-stage it to fit that shape, and do not move the camera. ' +
      'Keep the base photograph\'s composition exactly: every person, product and prop stays in the same place, at the same size in the frame, ' +
      'seen from the same angle, with the same eyelines — a person looking off to the side keeps looking there. ' +
      `Fill the new shape ONLY by EXTENDING the photograph at its ${wider ? 'TOP and BOTTOM' : 'LEFT and RIGHT'} edges: continue the same room outwards — ` +
      'the same wall, floor, ceiling, furniture and light — adding nothing that draws attention and no new people. ' +
      'This overrides any later instruction about camera distance, framing or filling the frame.',
  ];
}

/** 배경 합성이 실제로 켜졌는가 — base 와 background 가 둘 다 있어야 한다 */
function isBackgroundSwap(spec: GenerationSpec): boolean {
  const u = spec.uploadedRefs ?? [];
  return !!spec.backgroundSwap && u.some((r) => r.role === 'base') && u.some((r) => r.role === 'background');
}

/**
 * 배경 합성 지시 — 두 사진을 한 장으로.
 * 합성 티가 나는 지점은 오늘까지의 실측으로 셋이다: 조명 방향이 어긋남, 카메라 높이·원근이 어긋남,
 * 바닥에 닿은 그림자가 없음. 셋을 하나씩 못박는다. 인물의 포즈와 제품의 형태는 소스 그대로다.
 */
function compositeBlock(spec: GenerationSpec): string[] {
  return [
    'COMPOSITE — two photographs become one photograph.',
    recastsPeople(spec)
      // 교체 인물은 나이·키가 다를 수 있다 — 팔다리는 새 몸의 길이를 따르고 포즈의 종류·상호작용만 지킨다
      ? '  From the SOURCE photograph keep each person\'s pose and position (the same kind of pose and the same interaction — where a replacement is in a different age group (see SCALE), the limbs follow the new body\'s own length and the bean bag compresses under the new body\'s weight) and the products as shaped.'
      : '  From the SOURCE photograph keep the people exactly as posed (same body pose, limb placement and positions relative to each other) and the products exactly as shaped and compressed.',
    '  From the BACKGROUND image take the whole environment — the room, walls, floor, windows, props and light.',
    '  Re-stage the people and products inside that environment: match the background\'s camera height and perspective so they stand or sit on its floor at a natural, true-to-life scale.',
    '  RE-LIGHT the people and products from the background\'s own light direction and colour temperature, so they look photographed in that room rather than pasted into it.',
    /*
     * 톤 — 인물·제품의 화이트밸런스·밝기·대비·채도·암부를 배경에 맞춘다 (사용자 요청 2026-09-22).
     * 원본이 스튜디오 컷이면 그 평면광·높은 채도가 그대로 붙어 나와 합성 티가 났다.
     */
    '  RE-GRADE their tone to the background too: white balance, exposure, contrast, saturation and shadow depth on skin, hair, clothing and fabric match the background photograph' +
      (spec.sceneTone ? (spec.sceneTone === SCENE_TONE_UNMEASURED ? ' (see SCENE TONE below)' : ' (measured values in SCENE TONE below)') : '') +
      ' — none of the source photograph\'s studio light or colour grade stays on them.',
    '  Ground them with soft contact shadows on the background\'s floor where the bodies and products meet it.',
    '  Nothing of the source photograph\'s room, walls, floor, props, lighting or colour grade remains in the result.',
  ];
}

/** 업로드 base 편집 지시 */
function editBlock(spec: GenerationSpec): string[] {
  const targets = spec.editTargets ?? [];
  if (!targets.length) return [];
  const L: string[] = [];
  /*
   * 배경 합성에서는 "나머지는 베이스와 픽셀까지 똑같이" 가 틀린 말이 된다 — 조명·원근·배경이 바뀌어야 하기 때문.
   * 그래서 보존 대상을 인물의 포즈와 제품의 형태로 좁히고, 배경 항목은 새 배경 사진을 가리키게 한다.
   */
  if (isBackgroundSwap(spec)) {
    L.push('EDIT — apply the following to the people and products taken from the source photograph:');
    for (const t of targets) {
      L.push(`  - ${t === 'background'
        ? 'place them into the environment of the background image instead of their original surroundings (see COMPOSITE)'
        : (EDIT_TARGET_EN[t] ?? t)}`);
    }
    L.push(
      (recastsPeople(spec)
        ? 'Keep each person\'s pose and relative position (limb placement re-proportioned to each new person\'s own body), and each product\'s shape (its compression follows the weight of whoever now sits on it), as in the source photograph. '
        : 'Keep each person\'s pose, limb placement and relative position, and each product\'s shape and compression, exactly as in the source photograph. ') +
        'Their lighting, colour tone, perspective and scale in frame follow the background image.',
    );
    return L;
  }
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
      'Use the pose reference ONLY for body pose, limb placement, camera angle, framing and how deeply the body sinks in. ' +
        'The product (its shape, top edge, folds and surface), its colour, the model identity and the outfit all come from the specifications below — ' +
        'do not inherit them from that image.',
    );
    L.push('');
  } else if (isBackgroundSwap(spec)) {
    // 배경 합성 — 아래 "베이스를 그대로 재현(같은 배경·같은 조명)" 과 정면으로 부딪히므로 그 문장 대신 합성 지시를 쓴다
    L.push(...compositeBlock(spec));
    L.push('');
  } else if (spec.baseCut || hasUploadBase) {
    L.push(
      /*
       * 인물 교체면 "같은 팔다리 위치·같은 눌림" 을 픽셀 단위로 요구하지 않는다 — 원본 몸 크기를 강요해
       * 나이가 다른 아동이 들어갈 자리가 없어진다 (합성과 같은 원인, 2차 검토 2026-09-22).
       */
      (recastsPeople(spec)
        ? 'Reproduce the base photograph EXACTLY — same camera angle, same poses (the same kind of pose and the same interaction — where a ' +
          'replacement is in a different age group (see SCALE), the limbs follow the new body\'s own length and the bean bag dents under the new body\'s ' +
          'weight), same product shapes, same lighting, same background, same framing and crop. '
        : 'Reproduce the base photograph EXACTLY — same camera angle, same poses, same body positions and limb placement, ' +
          'same product shapes and compression, same lighting, same background, same framing and crop. ') +
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

  // 규격이 원본 사진과 다르면 — 구도는 그대로, 가장자리만 늘린다 (편집 지시 바로 뒤, 구도 문장보다 앞)
  const fp = framePreserveLines(spec);
  if (fp.length) { L.push(...fp); L.push(''); }

  const eb = editBlock(spec);
  if (eb.length) { L.push(...eb); L.push(''); }

  if (spec.preservation?.instruction) {
    /*
     * 보존 강도 지시는 "원본의 조명·구도·장면을 유지하라" 는 내용이라 배경 합성과 부딪힌다.
     * 처음엔 본문 뒤에 "인물·제품에만 적용" 을 덧붙였는데, 본문의 "원본의 색감·조명 무드 유지" 가 그대로 남아
     * 인물·제품을 원본 톤에 묶어 두었다 (사용자 지적 2026-09-22). 합성이면 강도 이름 줄만 남기고 적용 범위를 새로 쓴다.
     */
    if (isBackgroundSwap(spec)) {
      L.push(swapPreservationHeader(spec.preservation.instruction));
      L.push(
        'This level sets ONLY how closely the people\'s poses and placement and the products\' shape' +
          (recastsPeople(spec) ? ' (their compression follows each new person\'s weight)' : ' and compression') +
          ' follow the source photograph. ' +
          'Light, white balance, colour grade and mood come from the BACKGROUND photograph. Every fabric and garment keeps its own colour — only the room\'s light on it changes.',
      );
    } else {
      L.push(presetBody(spec, spec.preservation.instruction));
    }
    L.push('');
  }

  const pb = productBlock(spec);
  if (pb.length) { L.push(...pb); L.push(''); }
  const ppb = photoProductsBlock(spec);
  if (ppb.length) { L.push(...ppb); L.push(''); }

  const tb = talentBlock(spec, refs);
  if (tb.length) { L.push(...tb); L.push(''); }

  const sb = scaleBlock(spec);
  if (sb.length) { L.push(...sb); L.push(''); }

  const toneL = toneBlock(spec);
  if (toneL.length) { L.push(...toneL); L.push(''); }

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

  L.push(...finalToneLines(spec));
  L.push(...finalCandidLines(spec));
  /*
   * 시선 최종 확인 — 표정컷이 정면이라 얼굴을 바꾸면 카메라를 보게 된다. 가운데의 GAZE 규칙만으로는 안 지켜져서
   * 끝(방향 지시 바로 앞)에 원본에서 읽은 문장을 한 번 더 박는다 (사용자 지적 2026-09-23).
   */
  if ((spec.baseGaze ?? []).length) {
    L.push('');
    L.push(
      'FINAL GAZE CHECK — this overrides the frontal look of the identity and expression reference portraits: ' +
        `${spec.baseGaze!.join(' ')} Copy ONLY the expression from the expression reference — never its head angle or eyeline. ` +
        'A person who is not looking at the camera in the base photograph must not look at the camera here.',
    );
  }

  /*
   * 사람이 쓴 방향 지시가 없으면 연출 지시를 대신 넣는다 (2026-09-23) — 이 자리가 "부딪히면 이게 이긴다" 인 유일한 자리라,
   * 같은 내용도 여기 있을 때만 정면 응시를 눌렀다. 사람이 적었으면 그 글이 그대로 들어간다(사람 것이 우선).
   */
  const direction = spec.direction || autoDirection(spec);
  if (direction) {
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
    L.push(direction);
  }

  if (spec.houseRules?.length) {
    L.push('');
    L.push(spec.houseRules.join(' '));
  }

  L.push('');
  L.push(
    spec.mode === 'thumbnail'
      ? (spec.keepRealTags
        ? 'ABSOLUTELY NO TEXT: no typography, no Korean or English lettering, no numbers, no badges, no price tags, no logos, no watermarks — the ONLY exception is the real sewn product tag kept per BRAND TAGS. Photorealistic commercial product photography only.'
        : 'ABSOLUTELY NO TEXT: no typography, no Korean or English lettering, no numbers, no badges, no price tags, no logos, no watermarks. Photorealistic commercial product photography only.')
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
  /*
   * 예전 BRAND TAGS 규칙("태그는 하나만·작게·글자가 무너지면 비워라")은 없앴다 — 계속 이상하게 나왔다.
   * 로고·태그는 모든 생성에서 뺀다 (no-logo.ts).
   */
  // 드롭박스 실촬영본이 편집 원본이면 진짜 태그는 살린다 (사용자 결정 2026-09-22) — 그 외는 전부 로고 없음
  L.push(spec.keepRealTags ? KEEP_REAL_TAG_RULE : NO_LOGO_RULE);

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
        ? (spec.talents?.length
          ? `포즈 소스(우리 승인 컷) — 몸 포즈·팔다리 배치·앵글·프레이밍·몸이 가라앉는 깊이만 가져온다. 제품 자체(형태·실루엣·윗선·주름·태그·컬러)와 모델/의상은 이 컷에서 아무것도 가져오지 않고 아래 지정을 따른다: ${spec.baseCut.spec}`
          : `포즈 소스(우리 승인 컷) — 앵글·프레이밍·제품의 화면 속 위치만 가져온다. 눌림·찌그러짐·태그는 가져오지 않는다(빈 제품은 빵빵하게). 제품/컬러는 아래 지정을 따른다: ${spec.baseCut.spec}`)
        : `베이스 컷 원문 스펙: ${spec.baseCut.spec}`,
    );
  }
  const eb = editBlock(spec);
  // 규격이 원본 사진과 다르면 — 구도는 그대로, 가장자리만 늘린다 (반드시 프롬프트에 실을 것)
  const fpB = framePreserveLines(spec);
  if (fpB.length) { L.push(''); L.push('규격이 원본 사진과 다르다 (가장 강하게 반영할 것 — 구도 재구성 금지):'); L.push(...fpB.map((x) => '  ' + x)); }
  if (isBackgroundSwap(spec)) {
    L.push('');
    L.push('배경 합성 (가장 강하게 반영할 것) — 인물·제품 소스 사진에서는 인물의 포즈와 제품만, 새 배경 사진에서는 공간 전체를 가져온다. 조명 방향·색온도·카메라 높이·원근을 새 배경에 맞추고, 새 바닥에 접지 그림자를 넣는다:');
    L.push(...compositeBlock(spec).map((x) => '  ' + x));
  }
  if (eb.length) { L.push(''); L.push(isBackgroundSwap(spec) ? '편집 지시:' : '편집 지시 (이것만 바꾸고 나머지는 원본 그대로 — 가장 강하게 반영할 것):'); L.push(...eb.map((x) => '  ' + x)); }
  if (spec.preservation) {
    L.push(''); L.push(`레퍼런스 보존 강도: ${spec.preservation.label}${isBackgroundSwap(spec) ? ' — 인물·제품의 포즈·배치·형태에만 적용 (조명·색감·톤은 원본이 아니라 새 배경 사진을 따른다)' : ''}`);
    // 합성이면 프리셋 본문("원본 색감·조명 무드 유지")을 싣지 않는다 — 로컬 템플릿과 같은 규칙
    L.push(isBackgroundSwap(spec) ? swapPreservationHeader(spec.preservation.instruction) : presetBody(spec, spec.preservation.instruction));
  }

  const pb = productBlock(spec);
  if (pb.length) { L.push(''); L.push('제품 정보 (실측으로 확립된 값 — 그대로 써야 함):'); L.push(...pb.map((x) => '  ' + x)); }
  const ppb = photoProductsBlock(spec);
  if (ppb.length) { L.push(''); L.push('사진 속 제품 (사진 속 자리 그대로 — 사람 몸에 두르거나 옮기지 않는다):'); L.push(...ppb.map((x) => '  ' + x)); }

  const tb = talentBlock(spec, refs);
  if (tb.length) { L.push(''); L.push('인물 정보 (여러 명이면 사진 왼쪽부터 순서 배정):'); L.push(...tb.map((x) => '  ' + x)); }

  const sb = scaleBlock(spec);
  if (sb.length) { L.push(''); L.push('스케일 (빈백 대비 사람 크기 — 반드시 반영):'); L.push(...sb.filter(Boolean).map((x) => '  ' + x)); }

  const toneB = toneBlock(spec);
  if (toneB.length) { L.push(''); L.push('톤 맞추기 (배경 사진에서 잰 값 — 합성 티 방지, 반드시 반영):'); L.push(...toneB.map((x) => '  ' + x)); }

  const vars = (spec.variations ?? []).filter((v) => v.hint);
  if (vars.length) { L.push(''); L.push('연출 옵션: ' + vars.map((v) => `${v.label}(${v.hint})`).join(', ')); }
  // 배경 톤 맞춤 — 로컬 템플릿처럼 끝에 한 번 더, 가장 강하게 (Opus 가 본문 끝에 녹이게)
  const ft = finalToneLines(spec).filter(Boolean);
  if (ft.length) { L.push(''); L.push('최종 톤 확인 (배경을 골랐으므로 필수 — 프롬프트 끝에 가장 강하게 넣을 것):'); L.push(...ft.map((x) => '  ' + x)); }
  const dirB = spec.direction || autoDirection(spec);
  if (dirB) { L.push(''); L.push(`MD 의 방향 지시 (한글 — 가장 강하게 반영할 것): ${dirB}`); }
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
   단, 브리프에 '배경 합성'이 있으면 '나머지는 원본 그대로'를 쓰지 마라 — 원본에서는 인물의 포즈·배치와 제품 형태만 보존하고,
   조명·색감·톤·원근은 새 배경 사진을 따른다고 가장 강하게 써라.
6. 전 컷 공통 규칙은 빠짐없이 반영하라.
7. 텍스트·로고·워터마크 금지 문장을 마지막에 반드시 넣어라.
7-2. 로고·태그는 어떤 경우에도 그리지 않는다 (필수, 2026-09-15 확정). 베이스·참조 사진에 요기보 봉제 태그·
   케어라벨·로고가 보여도 "그 자리를 같은 색의 매끈한 원단으로 비워라" 고 지시하라. 태그를 살리거나
   새로 붙이라는 문장은 절대 쓰지 마라 — 제미나이는 태그 글자를 뭉개거나 없던 태그를 붙인다.
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
      `- ${spec.keepRealTags ? KEEP_REAL_TAG_RULE : NO_LOGO_RULE}`,
      '- Any watermark, copyright line, credit or username printed ON a reference photo is NOT part of the scene — ' +
        'remove it and reconstruct the surface beneath. The output carries no inherited overlay text.',
    ];
    const anchors = (spec.products ?? []).map((p) => p.scalePrompt).filter(Boolean);
    if (anchors.length) guard.push(`- TRUE SCALE: ${anchors.join(' / ')}`);
    // 사람 ↔ 제품 치수 짝짓기 — 매뉴얼 프롬프트에도 숫자로 한 번 더 (아동/어른 크기 차이)
    guard.push(...scalePairingLines(pairingProducts(spec), spec.talents ?? []).map((x) => `- ${x.trim()}`));
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
      // Opus 가 로고 규칙을 빠뜨려도 필수 문장은 붙는다
      prompt: spec.keepRealTags ? withKeepRealTags(text) : withNoLogo(text),
      refs,
      mode: 'opus',
      usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
    };
  } catch (e) {
    console.warn('[prompt-writer] Opus 실패 — 템플릿으로 대체:', (e as Error).message);
    return { prompt: buildPromptLocal(spec, refs), refs, mode: 'local' };
  }
}
