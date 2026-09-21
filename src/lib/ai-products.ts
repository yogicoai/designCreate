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
  /**
   * 사람이 "이 칸은 쓰지 말자" 로 꺼둔 칸. 생성에 안 들어간다.
   *
   * 왜 필요한가 (사용자 지시 2026-09-16): 한 시트 안에서도 칸마다 품질이 다르다.
   * 맥스+서포트 시트의 측면·크기비교 칸은 서포트를 U 가 아니라 통짜 볼스터로 그려 놓았고,
   * 그 칸들이 참조로 들어가는 바람에 프롬프트에 "U 자 팔 두 개" 라고 아무리 써도 소용이 없었다.
   * 시트 전체를 버리기엔 멀쩡한 칸이 아깝다 — 그래서 칸 단위로 끈다.
   */
  off?: boolean;
}

/** 생성에 실제로 쓰는 칸만 (사람이 끈 칸 제외) */
export function livePanels(sheet: Pick<AiProductSheet, 'panels'>): SheetPanel[] {
  return sheet.panels.filter((p) => !p.off);
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
  /**
   * 조합 시트 — 두 제품을 함께 찍은 시트 (예: ['Max','Support']).
   * 생성 화면의 제품 목록에 「맥스 + 서포트」 처럼 한 줄로 뜨고, 고르면 두 제품이 같이 들어간다.
   * 조합은 상대 크기·접촉·방향 셋을 동시에 맞춰야 해서 숫자만으로는 안 잡힌다 (2026-09-16 실측).
   */
  comboLines?: string[];
  /** 그 조합의 공식 실사 — 연출컷 생성에 크기·자세 기준으로 같이 넣는다 */
  realRef?: string;
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
      ? (r.panels as SheetPanel[]).filter((p) => p && p.url).map((p) => ({
        key: String(p.key ?? ''), label: String(p.label ?? ''), url: String(p.url), ...(p.off ? { off: true } : {}),
      }))
      : [],
    status,
    ...(Array.isArray(r.comboLines) && r.comboLines.length ? { comboLines: (r.comboLines as string[]).map(String) } : {}),
    ...(r.realRef ? { realRef: String(r.realRef) } : {}),
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

/**
 * 윗부분이 "둥글게 꽉 찬 채로 끝나야" 하는 빈백 — 프롬프트의 TOP FORM 줄과 결과물 말림 검사가 같은 목록을 쓴다.
 * 빠진 것: Pyramid(짧게 뾰족한 끝이 정상) · Lounger(높게 솟은 등받이가 정상 — 검사가 물방울로 오판)
 *          · Support·메이트 인형·소품(빈백 윗면 개념이 없다).
 * 사용자 지시 2026-09-15: "피라미드 제품이 아니면 뒤쪽 저런 식으로 말리는 것도 막아줘".
 */
export const TOP_FORM_LINES = new Set(['Max', 'Slim', 'Midi', 'Mini', 'Double', 'Drop', 'Pod']);

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
  /*
   * 조합 사용컷 — 사람이 앉은 실사다. "어느 각도" 가 아니라 "어떤 상태" 라
   * POSTURE_KEYS(prompt-writer) 에도 같이 넣어 문장이 "seen from the ~" 로 안 붙게 한다.
   * 사람이 찍혀 있으므로 인물을 가져오지 말라는 경고를 문구 안에 함께 넣는다.
   */
  real: 'as it is actually used, with a person sitting in it — copy only how the products fit together around a body, never the person, the room or the lighting',
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
  for (const p of [...livePanels(sheet)].sort((a, b) => rank(a.key) - rank(b.key))) {
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
  const live = livePanels(sheet);
  for (const k of ['d45', 'fl34', 'front', 'side']) if (live.some((p) => p.key === k)) return k;
  return live[0]?.key ?? '';
}

/*
 * ── 제품 조합 ────────────────────────────────────────────────
 * 맥스에 서포트를 얹는 식의 "두 제품을 겹쳐 쓰는" 연출은 제품을 따로 지시하면 반드시 틀어진다.
 * 실측(2026-09-16): 서포트를 "맥스 폭의 1.1배" 로 쓰면 2.5배로 커지고, 크기만 맞춰도 팔이 허공에 뜬다.
 * 그래서 ①두 제품이 함께 찍힌 조합 시트 칸 ②공식 실사 ③아래 숫자 세 겹으로 못박는다.
 */

/** 조합 시트인지 — 두 제품 이상이 한 칸에 같이 있다 */
export function isComboSheet(s: Pick<AiProductSheet, 'comboLines'>): boolean {
  return (s.comboLines?.length ?? 0) >= 2;
}

/** 조합 키 — 'Max+Support' */
export function comboKey(lines: string[]): string {
  return lines.join('+');
}

/**
 * 제품 라인 한글 이름 — 화면에 보이는 곳은 전부 이걸 쓴다.
 * 사용자 지시 2026-09-16: "Max 이렇게 된것들 다 한글로 변경해서 넣어줄래 다 한국사람이 사용하는건데".
 * DB 의 line 은 영문 그대로 둔다 — 시트·포즈·컷이 전부 이 키로 묶여 있어 바꾸면 연결이 끊긴다.
 */
export const LINE_KR: Record<string, string> = {
  Max: '맥스', Slim: '슬림', Midi: '미디', Mini: '미니', Double: '더블',
  Drop: '드롭', Pod: '팟', Lounger: '라운저', Pyramid: '피라미드', Support: '서포트',
  Etc: '기타',
};
/** 라인의 표시 이름 — 표에 없으면(이미 한글인 소품들) 그대로 */
export function lineKr(line: string): string {
  return LINE_KR[line] ?? line;
}

/** 화면에 뜨는 조합 이름 */
export function comboLabelKr(lines: string[]): string {
  return lines.map(lineKr).join(' + ');
}

/**
 * 조합 배치 지시 (영문) — 프롬프트에 그대로 들어간다.
 * 숫자는 공식 실사와 로컬 실측 합성에서 잰 값이다. 바꾸려면 근거 컷을 먼저 만들 것.
 */
export const COMBO_STAGING: Record<string, string[]> = {
  'Max+Support': [
    'The Yogibo Max lies FLAT on the floor along its 170cm length, like a low floor mattress — never stood upright, never folded.',
    'The Yogibo Support sits ON TOP of the Max at its far (back) edge and becomes the backrest. Its underside presses into the Max and visibly dents it; it is never on the floor beside, behind or in front of the Max, and never merges into it — it reads as a separate cushion resting on the Max.',
    'The U-shaped opening of the Support faces the camera and the sitter. Its two thick arms curve FORWARD past the sitter on either side, so the round cut end of each arm points toward the camera, hanging over the front of the Max. The arms never float in the air — their undersides rest on the Max or on the sitter.',
    'SIZE — measured from the official photograph, not guessed: seen square-on from the front, the Support spans about 0.45x the visible width of the flat Max (the Max shows its 170cm length across frame; the Support is only 76cm wide). In an angled three-quarter view it reads larger, about 0.7x. Front-to-back the Support is about 1.34x the Max\'s 70cm width, so its arm tips overhang the front edge. The Support adds roughly 30cm of height above the Max\'s top surface.',
    'The Support is a thick, densely filled cushion — each arm is a plump tube whose diameter is about 0.4x the Support\'s overall width, and the gap between the arms is only about 0.21x that width. It must never look thin, flat, deflated or like a folded towel.',
  ],
  /*
   * 2026-09-16 실측으로 전면 수정. 이전 문구는 "서포트가 팟 윗면에 올라타 걸터앉는다" 였는데,
   * 그대로 네 번 생성해 네 번 다 실패했다 — 팟은 둥근 공이라 올라탈 평평한 면이 없다.
   * 결과는 매번 둘 중 하나였다: 서포트가 옆·뒤로 미끄러지거나, 팟 윗면에 홈을 파고 그 안에 들어앉는다
   * (등록돼 있던 팟 조합 시트가 바로 그 상태였고, 그게 참조로 들어가 생성마다 눌림이 따라왔다).
   * 사람이 앉으면 서포트가 등과 옆구리를 감싸며 제자리를 잡는다 — 그게 이 제품의 실제 사용법이다.
   */
  'Pod+Support': [
    'The Yogibo Pod stands upright on the floor as the seat — a big soft egg-shaped bean bag, taller than it is wide, spreading where it meets the floor.',
    'THE SUPPORT IS NOT BALANCED ON TOP OF THE POD. The Pod is round, so there is no flat top to perch anything on. The Support is a thick horseshoe that leans INTO the upper front of the Pod: its curved spine rests back against the high part of the Pod, and its two fat arms come forward and down across the shoulders of the Pod on the left and right, so between them the front face of the Pod shows as an open seat. The pair reads at a glance as one armchair — the Pod is the seat, the Support is the backrest and armrests.',
    'IF A PERSON IS IN THE SHOT this is easy and natural: they sit down into the Pod, which takes their weight and deforms deeply around them, and the Support settles around their body — spine behind their lower back where the Pod rises up, one arm along each side passing under their forearms. Draw that compression; it is correct and expected.',
    'IF NOBODY IS IN THE SHOT the Support still leans into the upper front of the Pod with its arms reaching down the front sides. It never sits in a pressed-in hollow on the crown of the Pod, never drapes over the back like a scarf, and never tips off to one side.',
    'SIZE — measured from the official photograph: the Support spans about 0.89x the visible width of the Pod, so the shoulders of the Pod show on both sides beyond it, and the Pod plus Support together stand roughly 115-125cm tall.',
    'The Support is thick and densely filled — each arm is a plump round tube roughly as thick as the cushion is tall, holding that fullness almost to its rounded end, with an open channel running between the two arms. It must never look thin, flat, deflated, or like a flat ring pressed into the Pod.',
  ],
};

/** 이 조합의 배치 지시 — 없으면 빈 배열 (생성은 막지 않는다) */
export function comboStaging(lines: string[]): string[] {
  return COMBO_STAGING[comboKey(lines)] ?? [];
}
