/**
 * 배너 텍스트 템플릿.
 *
 * 왜 이렇게 만드는가:
 *   생성 모델에게 글자를 그리게 하면 반드시 뭉개진다 (로고 태그에서 확인됨).
 *   글자는 실제 폰트로 찍어야 한다. 그래서 이미지 생성과 텍스트 합성을 분리한다.
 *
 * 왜 숫자(비율)로 정의하는가:
 *   화면 미리보기는 CSS 로, 최종 저장은 서버에서 SVG 로 렌더한다.
 *   두 렌더러가 같은 숫자를 읽어야 "화면에서 본 그대로" 저장된다.
 *   그래서 좌표·크기를 전부 0~1 비율로 두고, 렌더 시점에 실제 픽셀을 곱한다.
 *   px 로 박아두면 1000px 컷과 2000px 배너에서 결과가 달라진다.
 */

export interface TextLayer {
  key: 'title' | 'subtitle' | 'badge' | 'caption';
  /** 화면에 보이는 이름 */
  label: string;
  /** 기본 문구 */
  placeholder: string;
  /** 가로 위치 (0~1). anchor 기준점이다 */
  x: number;
  /** 세로 위치 (0~1). 글자의 baseline 이 아니라 중심 */
  y: number;
  /** 글자 크기 — 이미지 가로 대비 비율 */
  size: number;
  weight: 400 | 500 | 600 | 700 | 800;
  /** 자간 — em 단위 */
  tracking: number;
  align: 'start' | 'middle' | 'end';
  /** 색 역할 — 테마에서 실제 색을 가져온다 */
  tone: 'strong' | 'soft' | 'accentText';
  /** 이 줄만 쓰지 않을 수 있다 */
  optional?: boolean;
}

export interface Decoration {
  kind: 'scrim' | 'band' | 'rule' | 'pill';
  /** 0~1 비율 사각형 */
  x: number; y: number; w: number; h: number;
  /** 색 역할 */
  tone: 'scrim' | 'accent' | 'strong';
  opacity: number;
  /** 모서리 반경 — 가로 대비 비율 */
  radius?: number;
  /** scrim 은 위/아래 방향 그라데이션 */
  direction?: 'top' | 'bottom';
}

export interface BannerTemplate {
  id: string;
  name: string;
  /** 어떤 상황에 쓰는지 — 고를 때 판단 기준이 된다 */
  hint: string;
  layers: TextLayer[];
  decorations: Decoration[];
}

/** 색 테마 — 배경 이미지가 밝은지 어두운지에 따라 고른다 */
export interface Theme {
  id: string;
  name: string;
  strong: string;
  soft: string;
  accent: string;
  accentText: string;
  scrim: string;
}

export const THEMES: Theme[] = [
  { id: 'light', name: '밝은 배경용 (짙은 글씨)', strong: '#1b1d21', soft: '#4a4f57', accent: '#e2503c', accentText: '#ffffff', scrim: '#ffffff' },
  { id: 'dark', name: '어두운 배경용 (흰 글씨)', strong: '#ffffff', soft: '#e6e3dd', accent: '#e2503c', accentText: '#ffffff', scrim: '#000000' },
  { id: 'warm', name: '따뜻한 톤 (크림·테라코타)', strong: '#fff8ee', soft: '#f0e2cf', accent: '#c2643a', accentText: '#fff8ee', scrim: '#3a2b1e' },
  { id: 'cool', name: '차분한 톤 (아이보리·네이비)', strong: '#f7f9fb', soft: '#d9e2ea', accent: '#2f4a6d', accentText: '#f7f9fb', scrim: '#101c2a' },
];

/*
 * 템플릿.
 * 자사몰에서 실제로 쓰는 배치만 넣었다 — 종류를 늘리는 것보다
 * 각각이 확실히 쓸 만한 게 낫다. 필요하면 여기 한 덩어리 추가하면 화면에 바로 뜬다.
 */
export const TEMPLATES: BannerTemplate[] = [
  {
    id: 'top-title',
    name: '상단 타이틀',
    hint: '제품이 아래쪽에 있는 컷. 위쪽 여백에 제목을 얹는다.',
    decorations: [{ kind: 'scrim', x: 0, y: 0, w: 1, h: 0.42, tone: 'scrim', opacity: 0.45, direction: 'top' }],
    layers: [
      { key: 'title', label: '제목', placeholder: '요기보 Week', x: 0.5, y: 0.15, size: 0.085, weight: 800, tracking: -0.01, align: 'middle', tone: 'strong' },
      { key: 'subtitle', label: '부제', placeholder: '· 보름달처럼 꽉 찬 휴식 ·', x: 0.5, y: 0.255, size: 0.032, weight: 500, tracking: 0.04, align: 'middle', tone: 'soft', optional: true },
    ],
  },
  {
    id: 'center',
    name: '중앙 정렬',
    hint: '배경이 단순한 컷. 화면 한가운데에 크게 건다.',
    decorations: [{ kind: 'scrim', x: 0, y: 0, w: 1, h: 1, tone: 'scrim', opacity: 0.32 }],
    layers: [
      { key: 'title', label: '제목', placeholder: '추석 단독 특가', x: 0.5, y: 0.44, size: 0.095, weight: 800, tracking: -0.015, align: 'middle', tone: 'strong' },
      { key: 'subtitle', label: '부제', placeholder: '온 가족이 둘러앉는 한가위', x: 0.5, y: 0.56, size: 0.036, weight: 500, tracking: 0.02, align: 'middle', tone: 'soft', optional: true },
      { key: 'badge', label: '뱃지', placeholder: '최대 32%', x: 0.5, y: 0.68, size: 0.034, weight: 700, tracking: 0, align: 'middle', tone: 'accentText', optional: true },
    ],
  },
  {
    id: 'left',
    name: '좌측 정렬',
    hint: '오른쪽에 제품이 있는 컷. 왼쪽 여백을 카피로 채운다.',
    decorations: [
      { kind: 'scrim', x: 0, y: 0, w: 0.62, h: 1, tone: 'scrim', opacity: 0.4 },
      { kind: 'rule', x: 0.08, y: 0.36, w: 0.006, h: 0.24, tone: 'accent', opacity: 1, radius: 0.004 },
    ],
    layers: [
      { key: 'title', label: '제목', placeholder: '집에서 보내는\n가장 편한 시간', x: 0.115, y: 0.42, size: 0.072, weight: 800, tracking: -0.01, align: 'start', tone: 'strong' },
      { key: 'subtitle', label: '부제', placeholder: '요기보 가을 홈퍼니싱', x: 0.115, y: 0.58, size: 0.03, weight: 500, tracking: 0.03, align: 'start', tone: 'soft', optional: true },
    ],
  },
  {
    id: 'bottom-band',
    name: '하단 띠',
    hint: '컷 전체를 살리고 아래 띠에만 문구를 넣는다. 썸네일에 안전하다.',
    decorations: [{ kind: 'band', x: 0, y: 0.79, w: 1, h: 0.21, tone: 'accent', opacity: 0.94 }],
    layers: [
      { key: 'title', label: '제목', placeholder: '가을 맞이 최대 32% 할인', x: 0.5, y: 0.862, size: 0.048, weight: 700, tracking: -0.005, align: 'middle', tone: 'accentText' },
      { key: 'subtitle', label: '부제', placeholder: '9/1 – 9/30 · 전 제품', x: 0.5, y: 0.935, size: 0.026, weight: 400, tracking: 0.03, align: 'middle', tone: 'accentText', optional: true },
    ],
  },
  {
    id: 'corner-badge',
    name: '모서리 뱃지',
    hint: '컷을 거의 안 가린다. 할인율만 강조할 때.',
    decorations: [{ kind: 'pill', x: 0.66, y: 0.06, w: 0.28, h: 0.13, tone: 'accent', opacity: 0.95, radius: 0.065 }],
    layers: [
      { key: 'badge', label: '뱃지', placeholder: '최대 32%', x: 0.8, y: 0.108, size: 0.052, weight: 800, tracking: -0.01, align: 'middle', tone: 'accentText' },
      { key: 'caption', label: '하단 문구', placeholder: '요기보 가을 특가', x: 0.5, y: 0.93, size: 0.034, weight: 600, tracking: 0.02, align: 'middle', tone: 'strong', optional: true },
    ],
  },
];

export function findTemplate(id: string): BannerTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function findTheme(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[1];
}
