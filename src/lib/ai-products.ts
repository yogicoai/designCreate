/**
 * AI 생성 제품 — 제품 한 개를 여러 각도로 한 장에 뽑아 칸별로 잘라둔 시트.
 *
 * 왜 한 장인가: 각도를 따로 뽑으면 각도마다 모양이 조금씩 달라지고, 그 사진들이
 * 섞여 참조로 들어가면 모델이 평균을 내 형태가 무너진다(Drop 삼각형 꼭지).
 * 한 번에 생성하면 모든 칸이 같은 물건이다. 크레딧도 한 장 값이다.
 *
 * 전속 모델의 얼굴 시트와 같은 발상이지만 기준이 다르다 — 얼굴은 "같은 사람"이면
 * 되지만 제품은 "실물과 같아야" 한다. 그래서 검증중 → 승인 을 거친다.
 *
 * 생성은 대화 쪽 힉스필드에서 돌고(앱 키에는 크레딧이 없다), 여기는 결과와 상태만 든다.
 */

export type SheetKind = 'shape' | 'usage';
export type SheetStatus = 'review' | 'approved';

export const KIND_LABEL: Record<SheetKind, string> = {
  shape: '형태 시트',
  usage: '사용 시트',
};

export const STATUS_LABEL: Record<SheetStatus, string> = {
  review: '검증중',
  approved: '승인',
};

export interface SheetPanel {
  key: string;
  label: string;
  url: string;
}

export interface AiProductSheet {
  id: string;
  line: string;
  /** 시트를 뽑은 컬러 — 생성에서 고른 컬러와 같으면 색 보정 없이 그대로 쓴다 */
  colorKey: string;
  colorName: string;
  hex: string;
  kind: SheetKind;
  title: string;
  /** 칸이 전부 들어 있는 원본 한 장 */
  sheet: string;
  panels: SheetPanel[];
  status: SheetStatus;
  /** 사양과 대조한 결과 — 사람이 승인 판단할 때 본다 */
  check: string;
  note: string;
  model: string;
  credits: number;
  createdAt: string | null;
}

export function toSheet(r: Record<string, unknown>): AiProductSheet {
  const kind = r.kind === 'usage' ? 'usage' : 'shape';
  const status = r.status === 'approved' ? 'approved' : 'review';
  const src = (r.source ?? {}) as Record<string, unknown>;
  return {
    id: String(r._id),
    line: String(r.line ?? ''),
    colorKey: String(r.colorKey ?? ''),
    colorName: String(r.colorName ?? ''),
    hex: String(r.hex ?? ''),
    kind,
    title: String(r.title ?? ''),
    sheet: String(r.sheet ?? ''),
    panels: Array.isArray(r.panels)
      ? (r.panels as SheetPanel[]).filter((p) => p && p.url).map((p) => ({ key: String(p.key ?? ''), label: String(p.label ?? ''), url: String(p.url) }))
      : [],
    status,
    check: String(r.check ?? ''),
    note: String(r.note ?? ''),
    model: String(src.model ?? ''),
    credits: Number(src.credits) || 0,
    createdAt: r.createdAt ? new Date(r.createdAt as string).toISOString() : null,
  };
}

/*
 * ── 이미지 생성에서 쓰는 칸 규칙 ──────────────────────────────
 * 생성 화면에서 사람이 "배치 각도" 칸 하나를 고르면, 같은 시트의 다른 각도 몇 칸을
 * 형태 보조로 붙인다. 한 시트의 칸은 같은 물건이라 섞여도 형태가 평균나지 않는다.
 */

/** 칸 키 → 프롬프트 각도 표기 (시트마다 키 이름이 조금씩 다르다) */
export const PANEL_ANGLE_EN: Record<string, string> = {
  front: 'front view',
  d45: '45-degree three-quarter view',
  fl34: '45-degree three-quarter view',
  d65: 'steep three-quarter view',
  high34: 'high three-quarter view from above',
  side: 'side view',
  side2: 'side view from the opposite side',
  // 맥스 시트의 left/right 는 "좌측 끝·우측 끝" — 긴 몸통을 끝에서 본 컷이다
  left: 'end-on view along its length',
  right: 'end-on view along its length',
  end: 'end-on view along its length',
  back: 'back view',
  top: 'top-down view from directly above',
  upright: 'standing upright on its end',
  tips: 'view from the arm-tip end',
};

/**
 * 같은 키가 시트마다 다른 칸일 때의 덮어쓰기 — 라인 → 칸 키 → 문구.
 * 팟의 side2 는 "측면 2 (사선)" 이라 라운저의 side2(반대쪽 측면)와 뜻이 다르다.
 */
const LINE_PANEL_ANGLE_EN: Record<string, Record<string, string>> = {
  Pod: { side2: 'diagonal three-quarter view' },
};

/** 칸의 영문 각도 문구 — 라인별 덮어쓰기 > 공통 표 > 키 그대로 */
export function panelAngleEn(line: string, key: string): string {
  return LINE_PANEL_ANGLE_EN[line]?.[key] ?? PANEL_ANGLE_EN[key] ?? key;
}

/**
 * 형태 보조로 자동으로 붙이지 않는 칸 — 자세가 바뀐 컷(세운 모습)·위에서 내려다본 컷·확대 컷은
 * 장면 속 제품을 그 자세로 끌고 간다(실측: 누운 로그형 뷰 + 착석이 크레센트로 휨).
 * 사람이 배치 각도로 직접 고르는 건 막지 않는다.
 */
const NOT_SUPPORT = new Set(['top', 'upright', 'handle', 'detail']);

/**
 * 보조 칸 우선순위 — 입체를 가장 많이 알려주는 순서.
 * 긴 제품(맥스 계열)은 끝면(end·left·right)이 두께를 알려줘서 후면보다 앞선다 — 후면은 정면과 실루엣이 거의 같다.
 */
const SUPPORT_ORDER = ['d45', 'fl34', 'side', 'front', 'end', 'right', 'left', 'back', 'd65', 'high34', 'side2', 'tips'];

/** 배치 각도 칸을 뺀 나머지에서 형태 보조 칸을 고른다 */
export function supportPanels(sheet: Pick<AiProductSheet, 'panels'>, primaryKey: string, max: number): SheetPanel[] {
  if (max <= 0) return [];
  const rank = (k: string) => { const i = SUPPORT_ORDER.indexOf(k); return i < 0 ? 99 : i; };
  // 같은 방향(측면·측면2 등)이 두 번 들어가면 한 방향만 강조된다 — 각도 표기가 같은 칸은 하나만
  const primaryAngle = PANEL_ANGLE_EN[primaryKey] ?? primaryKey;
  const seen = new Set([primaryAngle]);
  const out: SheetPanel[] = [];
  for (const p of [...sheet.panels].sort((a, b) => rank(a.key) - rank(b.key))) {
    if (p.key === primaryKey || NOT_SUPPORT.has(p.key)) continue;
    const ang = PANEL_ANGLE_EN[p.key] ?? p.key;
    if (seen.has(ang)) continue;
    seen.add(ang);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/** 생성 화면이 처음 골라두는 배치 각도 — 45° 가 있으면 그것, 없으면 첫 칸 */
export function defaultPanelKey(sheet: Pick<AiProductSheet, 'panels'>): string {
  for (const k of ['d45', 'fl34', 'front', 'side']) if (sheet.panels.some((p) => p.key === k)) return k;
  return sheet.panels[0]?.key ?? '';
}
