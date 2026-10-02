import 'server-only';
import sharp from 'sharp';
import { recolorPanelBuffer, normalizeHex } from './sheet-recolor';

/**
 * 스튜디오 제품 컷의 색을 컬러칩 hex 로 맞춘다 (점검 2026-10-02 4번).
 *
 * 왜: 생성 모델에 색을 말로·스와치로 시켜도 계속 틀렸다 (올리브 ΔE 16~21, 코랄 16). 반면 시트 칸을 먼저 Lab 으로
 * 옮겨 넣는 방법은 ΔE 0.4~2 로 맞았다(sheet-recolor.ts). 같은 계산을 완성된 컷에도 건다 —
 * 형태·주름·명암 픽셀은 그대로 두고 천의 색만 옮긴다. 실측(기존 컷): 드롭 코랄 19→3.1, 팟 다크그레이 8.7→1.5, 피라미드 6.7→0.9.
 *
 * 걸면 안 되는 컷이 있다 — 시험에서 확인한 것만 막는다:
 *   · 사람이 있는 컷: 피부·옷까지 목표색으로 물든다 (올리브 맥스 + 여성 B 컷에서 피부가 초록이 됨)
 *   · 방·가구가 있는 컷: 색을 옮길 "천" 을 가려낼 수 없다. 입력 목록으로는 못 가른다(글로 장면을 지시한 컷이 스튜디오로 읽힘) —
 *     그림의 네 모서리가 같은 단색인지로 판정한다.
 *   · 제품이 여러 색인 컷: 전부 한 색으로 끌려간다 → 배경 아닌 픽셀이 한 색 계열인지 확인한다.
 * 조건을 못 넘으면 null — 원본을 그대로 쓴다. 보정한 경우 호출부가 보정 전 원본을 따로 남긴다.
 */

type Lab = [number, number, number];
const lin = (v: number) => { v /= 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; };
const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
function toLab(r: number, g: number, b: number): Lab {
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, Y = R * 0.2126 + G * 0.7152 + B * 0.0722, Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
const dE = (a: Lab, b: Lab) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export interface StudioRead {
  /** 네 모서리가 같은 단색 — 스튜디오 배경으로 본다 */
  plain: boolean;
  /** 배경이 아닌 픽셀(=제품)의 평균색. 못 찾으면 null */
  fabric: Lab | null;
  /** 배경 아닌 픽셀 중 평균색과 같은 색 계열(a*b* 거리 28 이내)인 비율 — 낮으면 사람·소품·다른 색 제품이 섞였다 */
  purity: number;
}

/** 컷을 작게 줄여 배경·제품 색을 읽는다 */
export async function readStudio(buf: Buffer): Promise<StudioRead> {
  const { data, info } = await sharp(buf).removeAlpha().resize(320, 320, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const at = (x: number, y: number): Lab => { const k = (y * W + x) * 3; return toLab(data[k], data[k + 1], data[k + 2]); };
  const S = 10;
  const corners: Lab[] = [];
  let spread = 0;
  for (const [cx, cy] of [[0, 0], [W - S, 0], [0, H - S], [W - S, H - S]]) {
    const px: Lab[] = [];
    for (let y = cy; y < cy + S; y++) for (let x = cx; x < cx + S; x++) px.push(at(x, y));
    const m: Lab = [0, 0, 0];
    for (const p of px) { m[0] += p[0]; m[1] += p[1]; m[2] += p[2]; }
    m.forEach((v, i) => { m[i] = v / px.length; });
    spread = Math.max(spread, ...px.map((p) => dE(p, m)));
    corners.push(m);
  }
  let between = 0;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) between = Math.max(between, dE(corners[i], corners[j]));
  // 스튜디오 배경은 위아래로 살짝 밝기 차가 있다(바닥 그라데이션) — 모서리끼리 ΔE 14, 모서리 안 편차 9 까지는 단색으로 본다
  const plain = between < 14 && spread < 9;
  const bg: Lab = [0, 1, 2].map((i) => corners.reduce((s, c) => s + c[i], 0) / 4) as Lab;

  const fab: Lab = [0, 0, 0];
  const far: Lab[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const l = at(x, y);
    if (dE(l, bg) < 25) continue;
    far.push(l); fab[0] += l[0]; fab[1] += l[1]; fab[2] += l[2];
  }
  if (far.length < 200) return { plain, fabric: null, purity: 0 };
  fab.forEach((v, i) => { fab[i] = v / far.length; });
  // 명암(L)은 주름·그림자로 크게 흔들리므로 색 계열은 a*b* 로만 본다
  const same = far.filter((l) => Math.hypot(l[1] - fab[1], l[2] - fab[2]) < 28).length;
  return { plain, fabric: fab, purity: same / far.length };
}

export interface ColorFix {
  buffer: Buffer;
  /** 제품 평균색과 목표 hex 의 ΔE — 보정 전·후 */
  before: number;
  after: number;
}

/** 스튜디오 제품 컷이면 색을 hex 로 옮긴다. 조건을 못 넘거나 나아지지 않으면 null (원본 그대로 쓴다). */
export async function fixStudioColor(buf: Buffer, hexRaw: string): Promise<ColorFix | null> {
  const hex = normalizeHex(hexRaw);
  if (!hex) return null;
  try {
    const target = toLab(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
    const read = await readStudio(buf);
    if (!read.plain || !read.fabric || read.purity < 0.85) return null;
    const before = dE(read.fabric, target);
    if (before < 4) return null;                  // 이미 맞는다 — 괜히 다시 압축하지 않는다
    const fixed = await recolorPanelBuffer(buf, hex);
    if (!fixed) return null;
    const after = (await readStudio(fixed)).fabric;
    if (!after) return null;
    const afterDE = dE(after, target);
    if (afterDE > before - 2) return null;        // 나아지지 않았으면 원본을 쓴다
    return { buffer: fixed, before: Number(before.toFixed(1)), after: Number(afterDE.toFixed(1)) };
  } catch (e) {
    console.warn('[color-fix] 색 보정 실패 — 원본을 씁니다:', (e as Error).message);
    return null;
  }
}
