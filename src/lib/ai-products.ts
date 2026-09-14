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
