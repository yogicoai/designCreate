import 'server-only';
import { collection, COLLECTIONS } from './db';
import type { CutDoc } from './types';
import { qcFlags, type QcFlag } from '@/components/QcFlags';
import { isStudioCut } from './cut-kind';
import { seriesTiles, lastSeries, type SeriesTile, type SeriesResult } from './series-check';

/**
 * 생성 품질 집계 — 컷마다 남긴 자동 검사 결과(qc)를 모아서 "지금 무엇이 가장 많이 틀리는가" 를 보여 준다.
 *
 * 왜 필요한가 (점검 2026-10-02): 얼굴 대조·로고·말림·장면 검사가 컷마다 기록은 되는데 모아 보는 곳이 없어서,
 * 얼굴 경고 43%·ΔE 중앙값 16 같은 수치를 아무도 몰랐다. 검사 결과는 사람에게 돌아와야 다음 생성이 달라진다.
 *
 * 세는 기준은 갤러리 칩(QcFlags.qcFlags)과 같다 — 화면마다 다른 눈금을 쓰면 수치를 못 믿는다.
 * ΔE 는 배경·편집 원본이 없는 스튜디오 컷에서만 센다: 방 조명으로 색이 바뀌는 게 정답인 씬 컷의 ΔE 는 숫자가 사람을 속인다.
 */

export type QcKind = QcFlag['kind'];

export interface QcBucket {
  /** 'YYYY-Www' 또는 라인·모델 코드 */
  key: string;
  /** 생성 컷 수 (검사 여부와 무관) */
  cuts: number;
  /** 검사(얼굴/장면/로고 중 하나라도)가 돈 컷 수 */
  checked: number;
  /** 경고(bad)가 하나라도 있는 컷 수 */
  flagged: number;
  /** 원인별 경고 컷 수 — 한 컷에 같은 원인이 둘이어도 1 */
  by: Partial<Record<QcKind, number>>;
  /** 얼굴 검사가 실제로 판정한 컷 수(ok·weak·drift — tooSmall·noFace 제외) 와 그중 drift+weak */
  faceJudged: number;
  faceOff: number;
  /** 스튜디오 컷 ΔE 중앙값 (없으면 null) */
  deltaE: number | null;
  deltaEN: number;
  /** 숨긴 컷 수와 사유별 */
  hidden: number;
  hideReasons: Record<string, number>;
  /** 자동 재생성으로 만들어진 컷 수 */
  retries: number;
}

export interface QcOverview {
  since: string;
  weeks: QcBucket[];
  byLine: QcBucket[];
  byTalent: QcBucket[];
  byEngine: QcBucket[];
  /**
   * 프롬프트 경로별 — app(앱 템플릿) · opus · talk-template(대화에서 앱 템플릿 위에 쓴 것, 검사도 탄다) · talk-free(대화에서 처음부터).
   * 대화로 뽑은 컷이 앱 규칙을 안 타던 문제(점검 2026-10-02 5번)가 실제로 줄었는지 숨김 비율로 본다.
   */
  byPath: QcBucket[];
  /** 시리즈 일관성 — 모델별 최근 컷의 얼굴 위치(2장 이상인 모델만)와 마지막 대조 결과 */
  series: { code: string; tiles: SeriesTile[]; last: SeriesResult | null }[];
  total: QcBucket;
  /** 최근 경고 컷 — 갤러리로 바로 가서 보게 */
  recentFlagged: { id: string; url: string; createdAt: string; line: string; colorName: string; talents: string[]; flags: QcFlag[]; retryOf?: string }[];
}

type Doc = CutDoc & { _id: unknown; hideReason?: string; retryOf?: string; retryReason?: string };

/** 프롬프트가 어디서 쓰였나 — 예전 대화 컷에는 promptBase 가 없다(전부 대화에서 처음부터 쓴 것) */
function promptPath(c: Doc): string {
  if (c.promptMode === 'manual') return c.promptBase === 'template' ? 'talk-template' : 'talk-free';
  return c.promptMode === 'opus' ? 'opus' : 'app';
}


function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

function empty(key: string): QcBucket {
  return { key, cuts: 0, checked: 0, flagged: 0, by: {}, faceJudged: 0, faceOff: 0, deltaE: null, deltaEN: 0, hidden: 0, hideReasons: {}, retries: 0 };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Number(s[Math.floor(s.length / 2)].toFixed(1));
}

/** 컷 하나를 버킷에 더한다 — ΔE 는 나중에 중앙값을 내야 해서 따로 모은다 */
function add(b: QcBucket, c: Doc, flags: QcFlag[], dEs: Map<string, number[]>) {
  b.cuts++;
  const qc = c.qc;
  if (qc?.checked || qc?.face?.checked || qc?.scene?.checked) b.checked++;
  const bad = flags.filter((f) => f.level === 'bad');
  if (bad.length) b.flagged++;
  for (const k of new Set(bad.map((f) => f.kind))) b.by[k] = (b.by[k] ?? 0) + 1;
  for (const v of qc?.face?.verdicts ?? []) {
    if (v.verdict === 'ok' || v.verdict === 'weak' || v.verdict === 'drift') {
      b.faceJudged++;
      if (v.verdict !== 'ok') b.faceOff++;
    }
  }
  if (typeof c.deltaE === 'number' && isStudioCut(c)) {
    if (!dEs.has(b.key)) dEs.set(b.key, []);
    dEs.get(b.key)!.push(c.deltaE);
  }
  if (c.hidden) {
    b.hidden++;
    const r = c.hideReason || '사유 없음';
    b.hideReasons[r] = (b.hideReasons[r] ?? 0) + 1;
  }
  if (c.retryOf) b.retries++;
}

function finish(buckets: Map<string, QcBucket>, dEs: Map<string, number[]>): QcBucket[] {
  return [...buckets.values()].map((b) => {
    const xs = dEs.get(b.key) ?? [];
    return { ...b, deltaE: median(xs), deltaEN: xs.length };
  });
}

export async function getQcOverview(days = 56): Promise<QcOverview> {
  const col = await collection<Doc>(COLLECTIONS.cuts);
  const since = new Date(Date.now() - days * 86400000);
  // 숨긴 컷도 센다 — 숨김은 곧 "실패" 라서 사유가 품질 지표다. 배너 디자인(provider=design)은 생성이 아니라 뺀다.
  const docs = await col
    .find({ source: 'imgcreate', provider: { $ne: 'design' }, createdAt: { $gte: since } })
    .project<Doc>({ prompt: 0, design: 0 })
    .sort({ createdAt: -1 })
    .toArray();

  const weeks = new Map<string, QcBucket>();
  const byLine = new Map<string, QcBucket>();
  const byTalent = new Map<string, QcBucket>();
  const byEngine = new Map<string, QcBucket>();
  const byPath = new Map<string, QcBucket>();
  const total = empty('전체');
  const dE = { weeks: new Map<string, number[]>(), line: new Map<string, number[]>(), talent: new Map<string, number[]>(), engine: new Map<string, number[]>(), path: new Map<string, number[]>(), total: new Map<string, number[]>() };
  const recentFlagged: QcOverview['recentFlagged'] = [];

  const get = (m: Map<string, QcBucket>, k: string) => {
    if (!m.has(k)) m.set(k, empty(k));
    return m.get(k)!;
  };

  for (const c of docs) {
    const flags = qcFlags(c.qc);
    const created = new Date(c.createdAt);
    add(total, c, flags, dE.total);
    add(get(weeks, isoWeek(created)), c, flags, dE.weeks);
    add(get(byLine, c.line || '(제품 없음)'), c, flags, dE.line);
    for (const t of c.recipe?.talentCodes ?? []) add(get(byTalent, t), c, flags, dE.talent);
    // higgs/higgsfield 표기가 섞여 있다 — 하나로
    add(get(byEngine, (c.provider || '?').replace(/^higgsfield$/, 'higgs')), c, flags, dE.engine);
    add(get(byPath, promptPath(c)), c, flags, dE.path);
    if (!c.hidden && flags.some((f) => f.level === 'bad') && recentFlagged.length < 24) {
      recentFlagged.push({
        id: String(c._id), url: c.url, createdAt: created.toISOString(), line: c.line, colorName: c.colorName,
        talents: c.recipe?.talentCodes ?? [], flags: flags.filter((f) => f.level === 'bad'),
        ...(c.retryOf ? { retryOf: c.retryOf } : {}),
      });
    }
  }

  const sortByCuts = (xs: QcBucket[]) => xs.sort((a, b) => b.cuts - a.cuts);
  // 시리즈 줄 — 얼굴이 판정된 모델만 (컷 수 많은 순)
  const seriesCodes = [...byTalent.values()].filter((b) => b.faceJudged >= 2).sort((a, b) => b.cuts - a.cuts).map((b) => b.key);
  const series = (await Promise.all(seriesCodes.map(async (code) => ({ code, tiles: await seriesTiles(code), last: await lastSeries(code) }))))
    .filter((s) => s.tiles.length >= 2);
  return {
    since: since.toISOString(),
    weeks: finish(weeks, dE.weeks).sort((a, b) => a.key.localeCompare(b.key)),
    byLine: sortByCuts(finish(byLine, dE.line)),
    byTalent: sortByCuts(finish(byTalent, dE.talent)),
    byEngine: sortByCuts(finish(byEngine, dE.engine)),
    byPath: sortByCuts(finish(byPath, dE.path)),
    series,
    total: finish(new Map([[total.key, total]]), dE.total)[0],
    recentFlagged,
  };
}
