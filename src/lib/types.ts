import type { DesignDoc } from '@/lib/design-render';
/**
 * imgCreate 문서 스키마 — 앱(TS)과 시드 스크립트(mjs)가 공유하는 단일 정의.
 * 검증은 런타임 스키마 대신 이 타입 + 시드의 정규화 함수로 맞춘다.
 */

/** 제품 컬러 슬롯 — 라인 안의 색상 하나 */
export interface ProductColor {
  /** ASCII 키 (FTP 파일명에 쓰임 — 한글 금지) */
  key: string;
  /** 표시명 (한글) */
  name: string;
  /** 영문 표기 — 프롬프트에 한글이 섞이면 지시가 흐려진다 */
  nameEn: string;
  /** 공식 컬러칩 hex */
  hex: string;
  /** 대표 컬러 여부 */
  isRep: boolean;
  /** Higgsfield Element 토큰 — 70종 중 6종만 보유. 있으면 제품 정확도가 가장 높다. */
  elementId?: string;
  /** 360 스프라이트 원본 (프롬프트에 직접 넣으면 안 됨 — 아래 views 를 쓸 것) */
  sprite360?: string;
  /** 360에서 뽑아둔 단일 각도 뷰 */
  views?: Record<string, string>;
  /**
   * 컬러 보정 오프셋 (Lab).
   * 실측 결과 색상별 편차가 다르다(체리레드 ΔE 3~9 / 올리브그린 ΔE 16~21).
   * 생성 후 제품 영역을 이 값만큼 시프트해 공식 hex 에 맞춘다.
   */
  labOffset?: { L: number; a: number; b: number };
}

/** 제품 기하 서술 — 12차 실측 4종 세트 중 ①③④ (②치수는 dims) */
export interface ProductGeometry {
  /** 카테고리 단어 대신 쓰는 기하 서술. "beanbag" 이라고만 하면 둥근 공으로 그려진다. */
  shape: string;
  /** NOT 네거티브 */
  negative: string;
  /** 사용 자세 / 모드 */
  modes: string;
  /**
   * 12차 실측(productPrompt.js GEOMETRY)으로 검증된 서술인지.
   * false 면 시드에서 새로 작성한 것 — 생성 결과를 보고 다듬어야 한다.
   */
  verified: boolean;
}

export interface ProductDoc {
  /** 제품 라인 키 — 'Max' | 'Slim' | ... */
  line: string;
  emoji: string;
  /** 화면용 한 줄 설명 */
  spec: string;
  /** 실측 치수 */
  dims: { w?: number; d?: number; h?: number; weight?: number };
  /** 화면 표시용 원문 치수 문자열 ('h170 × w70 × d45 · 6.6kg') */
  sizeText: string;
  /** 인체 대비 스케일 앵커 — 모델은 cm 를 못 읽는다 */
  scalePrompt: string;
  /** youtube 카탈로그에서 가져온 제품은 기하 서술이 없다 (null) */
  geometry: ProductGeometry | null;
  /** 기본 썸네일 비율 */
  ratio: string;
  /** MD 가 지정해둔 추천 모델 (예: '여성A · 여성B · 남성A') */
  recommendedModels: string;
  /** 같은 형태의 상위 라인 (Slim/Midi/Mini 는 Max 와 동일 형태, 사이즈만 다름) */
  sameShapeAs?: string;
  /**
   * 라인 단위 형태 참조 — 컬러 슬롯 어디에도 뷰가 없을 때 쓰는 마지막 폴백.
   * legacy 에만 남은 단종 컬러의 사진이라 색은 못 쓰고 형태만 쓴다.
   * scripts/backfill-shape-views.mjs 가 채운다.
   */
  shapeViews?: { colorName: string; views: Record<string, string> };
  colors: ProductColor[];
  order: number;
  active: boolean;

  // ── youtube 프로젝트 제품 데이터에서 끌어온 필드 (scripts/sync-youtube-products.mjs) ──
  /** 카테고리 (빈백 / 메이트(인형) / 바디필로우·스툴 / 악세서리 …) */
  category?: string;
  /** 소품 여부 — 메인 제품 선택지에는 안 띄우고 '함께 놓을 제품'에만 나온다 */
  accessory?: boolean;
  /** 사용법·연출 서술 (영문 섞임). '연출: <영문>' 조각은 프롬프트 staging 으로 쓴다 */
  notes?: string;
  /** 실제 판매 페이지의 연출 사진들 — 이름(sitting_recliner 등) → URL */
  usageShots?: Record<string, string>;
}

/** 실사 포즈 레퍼 — 착석 썸네일 품질의 핵심 자산 */
export interface PoseRefDoc {
  key: string;
  /** 소속 제품 라인 */
  line: string;
  name: string;
  /** 모델 제거본 = 제품 형태·눌림(구김) */
  offUrl: string;
  /** 모델 포함본 = 포즈·각도·비례 */
  onUrl: string;
  note: string;
  /** '실사' | '실사·남성' | '실사·아동' 등 */
  tag: string;
  active: boolean;
}

/**
 * 전속 모델 아이덴티티 시트.
 * 원본에는 ④ 제품 착석 연출 시트도 있었지만 쓰지 않는다 — 착석 연출은 pose_refs(실사 레퍼)가
 * 맡고, 모델 시트는 얼굴·표정·체형 락만 담당한다. 역할이 겹치면 참조끼리 싸운다.
 */
export interface TalentSheets {
  /** 얼굴 턴어라운드 (5패널) */
  face?: string;
  /** 표정 시트 (2x4, 8표정) — 얼굴 드리프트 방지의 핵심. 항상 동반 투입한다. */
  expr?: string;
  /** 바디 턴어라운드 (5패널) */
  body?: string;
}

/** MD 가 지정한 의상 컨셉 — 코드 + 설명 + 레퍼 이미지 */
export interface Outfit {
  code: string;
  desc: string;
  /** 영문 표기 — 프롬프트에 들어간다 */
  descEn: string;
  /** web/img/none/clothes/<code>.jpg — 얼굴 포함 원본. 참조로 쓰지 말 것. */
  imageUrl: string;
  /** 얼굴을 잘라낸 의상 전용 크롭 — 생성 참조는 반드시 이쪽 (레퍼 얼굴 오염 방지) */
  cropUrl?: string;
}

export interface TalentDoc {
  /** 고유 코드 — 'W_A'(여성A) | 'M_A'(남성A) | 'K_B'(아동B) */
  code: string;
  /** '여성' | '남성' | '아동' */
  category: string;
  /** 카테고리 안의 표시 코드 — 'A' | 'B' | ... */
  slot: string;
  name: string;
  /** 고정 아이덴티티 서술 (락의 핵심) */
  identity: string;
  /** 아이덴티티의 영문 표기 — 프롬프트에 그대로 들어간다 */
  identityEn: string;
  /** 키·체형 — 제품 비례 연출에 필수 */
  size: string;
  /** 체형의 영문 표기 (제품 대비 상대 크기까지 서술) */
  sizeEn: string;
  /** 썸네일 페이지 쪽 설명 — 헤어 업데이트가 반영된 최신본이라 identity 보다 우선 표시 */
  thumbDesc: string;
  /** 대표 컷 */
  rep?: string;
  sheets: TalentSheets;
  /** 표정 시트 (썸네일 쪽 최신 버전). sheets.expr 보다 이걸 우선 쓴다. */
  exprSheet: string;
  /** 표정 시트를 칸별로 잘라둔 표정컷 — { 표정id: url }. 생성 시 요청 표정 한 장만 참조로 쓴다. */
  expressionCrops?: Record<string, string>;
  /** MD 지정 의상 컨셉 (레퍼 이미지 포함) */
  outfits: Outfit[];
  status: string;
  order: number;
  active: boolean;
}

/** 생성 컷의 레시피 — legacy spec 문자열에서 파싱하거나, 신규 생성 시 직접 기록 */
export interface CutRecipe {
  /** 모델 코드 ('W_D' 등). 2인 컷이면 여러 개. */
  talentCodes: string[];
  /** 포즈 레퍼 키 또는 번호 ('p4', '포즈레퍼') */
  pose?: string;
  /** 표정 ('미소' | '은은한미소' | '밝은미소' | '곁눈질미소' | '따뜻한미소') */
  expression?: string;
  /** 의상 코드 ('D_W_C_01' 등) */
  outfit?: string;
  /** 배경 hex ('#f2f2f4') */
  background?: string;
}

/** 생성에 실제로 넣은 입력 이미지 1장 — 삭제·수정에 흔들리지 않게 URL 을 스냅샷으로 박아둔다 */
export interface InputImage {
  /** 참조의 역할 — prompt-writer 의 RefKind 와 동일 */
  kind: 'base' | 'style' | 'background' | 'shape' | 'pose' | 'usage' | 'talent' | 'outfit' | 'product' | 'swatch';
  title: string;
  url: string;
  role?: string;
  /**
   * 색 스와치의 hex. 스와치는 생성한 이미지라 URL 이 없어서,
   * 이걸 안 남기면 나중에 갤러리에서 무슨 색을 넣었는지 되살릴 수 없다.
   */
  swatchHex?: string;
}

export interface CutDoc {
  line: string;
  colorKey: string;
  colorName: string;
  hex: string;
  /** 최종 이미지 URL (cafe24) */
  url: string;
  /** 원문 스펙 문자열 (legacy 이관분은 여기에 원본이 그대로 남는다) */
  spec: string;
  recipe: CutRecipe;
  /** 'legacy' = youtube 에서 이관 / 'imgcreate' = 이 앱이 생성 */
  source: 'legacy' | 'imgcreate';

  // ── 이 앱이 생성한 컷만 채워지는 필드 ──
  /** MD 가 붙인 작업 제목 */
  title?: string;
  prompt?: string;
  aiModel?: string;
  provider?: string;
  inputImages?: InputImage[];
  width?: number;
  height?: number;
  /** 컬러 보정 적용 후 실측 ΔE */
  deltaE?: number;
  /** 규격 이름 (배너는 '배너 디자인') */
  sizeLabel?: string;
  /**
   * 배너 디자인의 설계도 전체 (provider='design' 인 컷에만 있다).
   * 이게 있어야 저장한 배너를 다시 열어 고칠 수 있다.
   */
  design?: DesignDoc;
  /** 웹+모바일을 한 번에 만든 짝의 묶음 표식 */
  pairId?: string;
  /** 어느 화면이 만들었나 — 'sns-auto' = SNS 자동화. 갤러리에서 분리 관리한다 */
  origin?: string;
  /** 수정으로 만들어진 판이면 원본 배너의 id — 게시판에서 계보를 보여준다 */
  revisedFrom?: string;

  hidden: boolean;
  note: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ColorChipDoc {
  id: string;
  name: string;
  hex: string;
  note: string;
}

/** 전 컷 공통 규칙 — 구 CAUTIONS. MD 가 화면에서 켜고 끌 수 있게 데이터로 둔다. */
export interface HouseRuleDoc {
  order: number;
  /** 화면 표시용 한글 원문 */
  kr: string;
  /** 프롬프트에 실제로 들어가는 영문 */
  en: string;
  /** ★ 표시된 필수 규칙 여부 */
  critical: boolean;
  /**
   * image = 생성 프롬프트에 넣는 규칙 / operator = 사람이 지킬 작업 절차.
   * 작업 절차를 프롬프트에 넣으면 순수 노이즈가 된다 ("생성 전 크레딧을 고지하라" 같은 것).
   */
  appliesTo: 'image' | 'operator';
  /** 'no-scene' = MD 가 장면을 지정하면 이 규칙은 빠진다 (스튜디오 배경 규칙이 거실 지시와 충돌) */
  conditional: string | null;
  enabled: boolean;
}

/** 표정 시트 8패널 */
export interface ExpressionDoc {
  id: string;
  kr: string;
  en: string;
  order: number;
  active: boolean;
}

export interface ApiUsageDoc {
  key: string;
  count: number;
  limit: number;
  updatedAt: Date;
}
