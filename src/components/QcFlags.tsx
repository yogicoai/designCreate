import type { CutDoc } from '@/lib/types';

/**
 * 컷 하나의 자동 검사 결과를 "왜 실패했나" 한 줄로 (사용자 요청 2026-09-23).
 *
 * 어제까지는 실패한 컷을 사람이 하나씩 열어 봐야 원인을 알 수 있었다. 이제 생성할 때 남긴 검사 결과를
 * 갤러리와 생성 화면이 같은 문구로 보여 준다 — 제품 불일치 · 크기 · 합성 티(조명) · 얼굴 변형 · 윗부분 말림.
 * 정상인 항목은 칩을 만들지 않는다 (멀쩡한 컷에 경고가 뜨면 경고를 안 믿게 된다).
 */

export interface QcFlag {
  kind: 'product' | 'scale' | 'light' | 'face' | 'fold' | 'tag' | 'unchecked';
  label: string;
  /** 마우스를 올렸을 때 보이는 근거 — 검사가 적어 준 문장 */
  note: string;
  level: 'bad' | 'warn';
}

/** 조명 일치 점수 기준 — 60 미만이면 합성 티, 75 미만이면 주의 (scene-check.ts 의 설명과 같은 눈금) */
const LIGHT_BAD = 60;
const LIGHT_WARN = 75;

export function qcFlags(qc: CutDoc['qc']): QcFlag[] {
  if (!qc) return [];
  const out: QcFlag[] = [];
  const s = qc.scene;
  if (s?.checked) {
    if (!s.product.ok) {
      out.push({
        kind: 'product', level: 'bad',
        label: s.product.missing.length ? `제품 불일치 — ${s.product.missing.join(', ')}` : '제품 불일치',
        note: s.product.note,
      });
    }
    if (!s.scale.ok) out.push({ kind: 'scale', level: 'bad', label: '크기 어긋남', note: s.scale.note });
    if (s.light.score && s.light.score < LIGHT_BAD) out.push({ kind: 'light', level: 'bad', label: `합성 티 (조명 ${s.light.score}점)`, note: s.light.note });
    else if (s.light.score && s.light.score < LIGHT_WARN) out.push({ kind: 'light', level: 'warn', label: `조명 애매 (${s.light.score}점)`, note: s.light.note });
  }
  for (const v of qc.face?.verdicts ?? []) {
    if (v.verdict === 'drift') out.push({ kind: 'face', level: 'bad', label: `얼굴 변형 · ${v.code} (${v.score}점)`, note: v.note });
    else if (v.verdict === 'weak') out.push({ kind: 'face', level: 'warn', label: `얼굴 애매 · ${v.code} (${v.score}점)`, note: v.note });
  }
  if (qc.topFold?.suspected) out.push({ kind: 'fold', level: 'bad', label: '윗부분 말림 의심', note: qc.topFold.note });
  /*
   * 태그를 찾았는데 살리지도 지우지도 못한 경우 — 빈백 가장자리에 걸친 태그는 메우면 윤곽이 뭉개져서 건너뛴다.
   * 그러면 뭉개진 글자가 그대로 남으므로 사람에게 알린다 (실측 2026-09-23).
   */
  const stuck = (qc.logoFound ?? 0) - (qc.logoErased ?? 0) - (qc.logoKept ?? 0);
  if (stuck > 0) {
    out.push({
      kind: 'tag', level: 'bad', label: `태그 뭉개짐 ${stuck}개 남음`,
      note: '글자가 무너진 태그를 찾았지만 그 자리가 제품 가장자리라 지우지 못했습니다 — 다시 생성하거나 디자인 단계에서 덮으세요.',
    });
  }
  return out;
}

/** 여러 컷의 원인별 개수 — 갤러리 머리말의 "제품 불일치 3 · 크기 2 …" */
export function qcSummary(cuts: { qc?: CutDoc['qc'] }[]): { label: string; n: number }[] {
  const KR: Record<QcFlag['kind'], string> = {
    product: '제품 불일치', scale: '크기 어긋남', light: '합성 티(조명)', face: '얼굴 변형', fold: '윗부분 말림', tag: '태그 뭉개짐', unchecked: '검사 안 됨',
  };
  const n: Partial<Record<QcFlag['kind'], number>> = {};
  for (const c of cuts) for (const f of qcFlags(c.qc)) if (f.level === 'bad') n[f.kind] = (n[f.kind] ?? 0) + 1;
  return (Object.keys(KR) as QcFlag['kind'][]).filter((k) => n[k]).map((k) => ({ label: KR[k], n: n[k]! }));
}

export default function QcFlags({ qc, max = 3 }: { qc: CutDoc['qc']; max?: number }) {
  const flags = qcFlags(qc);
  if (!flags.length) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {flags.slice(0, max).map((f, i) => (
        <span key={i} title={f.note} className="text-[9.5px] px-1 py-[1px] rounded"
              style={{ color: f.level === 'bad' ? 'var(--danger)' : 'var(--warn)', background: 'var(--surface-2)' }}>
          {f.level === 'bad' ? '⚠ ' : ''}{f.label}
        </span>
      ))}
      {flags.length > max && <span className="text-[9.5px]" style={{ color: 'var(--text-mute)' }}>+{flags.length - max}</span>}
    </div>
  );
}
