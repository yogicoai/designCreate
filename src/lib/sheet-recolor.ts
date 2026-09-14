import 'server-only';
import sharp from 'sharp';
import { uploadBuffer, publicUrl, ftpConfigured, sanitizeFilename } from './ftp';

/**
 * AI 생성 제품 칸을 컬러칩 색으로 바꿔 공개 URL 로 만든다.
 *
 * 왜 생성 전에 로컬로 바꾸나: 생성 모델에 "이 색으로" 라고 말로 시키면 색이 자주 틀린다
 * (2026-09-14 실측 — 올리브 → 카키 ΔE 48, 올리브 → 세이지 ΔE 46). 칸 픽셀을 먼저 목표 hex 로
 * 옮겨 넣으면 ΔE 0.4~2 로 들어간다. 모양 픽셀은 그대로라 형태는 안 흔들린다.
 *
 * 왜 URL 인가: 힉스필드·대화 넘기기는 이미지를 URL 로만 받는다. 제미나이·GPT 는 그 URL 을
 * 다시 받아 쓰면 된다. 같은 칸·같은 색이면 결과가 항상 같으므로 이름으로 캐시한다 —
 * cafe24 는 7일 캐시라 알고리즘을 바꾸면 VERSION 을 올려 새 이름을 써야 한다.
 */

// rc2 — 실패 시 원본을 올리던 버그 수정 + 밝기를 비율로 옮겨 그림자·명암 보존 (rc1 캐시는 쓰지 않는다)
const VERSION = 'rc2';
const SUBPATH = 'ai-products-rc';

/** 같은 프로세스 안에서 같은 요청을 두 번 올리지 않는다 (동시 요청 포함) */
const memo = new Map<string, Promise<string>>();

const lin = (v: number) => { v /= 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; };
const gam = (v: number) => { const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(c * 255))); };
const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const fi = (t: number) => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; };
type Lab = [number, number, number];
function toLab(r: number, g: number, b: number): Lab {
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, Y = R * 0.2126 + G * 0.7152 + B * 0.0722, Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
function toRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = fi(fx) * 0.95047, Y = fi(fy), Z = fi(fz) * 1.08883;
  return [gam(X * 3.2406 + Y * -1.5372 + Z * -0.4986), gam(X * -0.9689 + Y * 1.8758 + Z * 0.0415), gam(X * 0.0557 + Y * -0.204 + Z * 1.057)];
}
const hexLab = (hex: string): Lab => toLab(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
const dE = (a: Lab, b: Lab) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function normalizeHex(hex: string | undefined | null): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  return m ? `#${m[1].toUpperCase()}` : '';
}

/**
 * 칸 이미지 버퍼의 제품 색을 목표 hex 로 옮긴다.
 *
 * 칸은 밝은 단색 배경 위 제품 하나라, 모서리에서 배경색 B 를, 배경과 확실히 다른 픽셀에서
 * 천 평균색 F 를 잰다. 픽셀마다 "천이 섞인 비율" α = (p−B)·(F−B)/|F−B|² 를 구해
 * 그만큼만 목표색 쪽으로 옮긴다. 전 픽셀을 똑같이 옮기면 가장자리(천+배경 섞인 픽셀)가
 * 엉뚱한 색 테두리로, 바닥 그림자의 반사색이 원래 색 빛으로 남는다 (서포트 시트 실측).
 */
export async function recolorPanelBuffer(raw: Buffer, hex: string): Promise<Buffer | null> {
  const target = hexLab(hex);
  const { data, info } = await sharp(raw).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const at = (x: number, y: number): Lab => { const k = (y * W + x) * 3; return toLab(data[k], data[k + 1], data[k + 2]); };

  // 배경 — 네 모서리 12×12 평균
  const bg: Lab = [0, 0, 0]; let bn = 0;
  for (const [cx, cy] of [[0, 0], [W - 12, 0], [0, H - 12], [W - 12, H - 12]]) {
    for (let y = cy; y < cy + 12; y++) for (let x = cx; x < cx + 12; x++) { const l = at(Math.max(0, x), Math.max(0, y)); bg[0] += l[0]; bg[1] += l[1]; bg[2] += l[2]; bn++; }
  }
  bg.forEach((v, i) => { bg[i] = v / bn; });

  // 천 평균 — 배경과 ΔE 25 이상 떨어진 픽셀 (그림자·가장자리는 이 문턱에 잘 안 걸린다)
  const fab: Lab = [0, 0, 0]; let fn = 0;
  for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) {
    const l = at(x, y); if (dE(l, bg) < 25) continue;
    fab[0] += l[0]; fab[1] += l[1]; fab[2] += l[2]; fn++;
  }
  if (fn < 50) return null; // 제품을 못 찾으면 실패 — 원본을 "보정됨" 으로 올리면 안 된다
  fab.forEach((v, i) => { fab[i] = v / fn; });

  const dir: Lab = [fab[0] - bg[0], fab[1] - bg[1], fab[2] - bg[2]];
  const len2 = dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2;
  if (len2 < 100) return null;
  /*
   * 목표색이 배경과 거의 같으면(밝은 칩 × 밝은 스튜디오 배경) 실루엣이 배경에 녹는다 — 형태 참조로 못 쓴다.
   * 그럴 땐 보정하지 않고 원본 색 칸 + "다른 색이니 형태만" 문구로 간다.
   */
  if (dE(target, bg) < 12) return null;

  const out = Buffer.from(data);
  for (let k = 0; k < data.length; k += 3) {
    const p = toLab(data[k], data[k + 1], data[k + 2]);
    const alpha = Math.max(0, Math.min(1, ((p[0] - bg[0]) * dir[0] + (p[1] - bg[1]) * dir[1] + (p[2] - bg[2]) * dir[2]) / len2));
    if (alpha < 0.03) continue;
    /*
     * 밝기 — 천 픽셀은 천 평균 대비 "비율" 로 옮긴다: 주름·음영의 명암비가 목표색에서도 남는다
     * (예전엔 같은 값을 더해 어두운 네이비 → 밝은 칩에서 그림자가 날아갔다 — 검토 확인).
     * 섞인 비율이 낮은 픽셀(바닥 그림자·가장자리)은 밝기를 거의 안 건드린다.
     */
    const ratioL = fab[0] > 1 ? Math.max(0, Math.min(100, p[0] * (target[0] / fab[0]))) : target[0];
    const wL = Math.max(0, Math.min(1, (alpha - 0.3) / 0.4));
    const L = p[0] + wL * (ratioL - p[0]);
    const mixA = (1 - alpha) * bg[1] + alpha * fab[1], mixB = (1 - alpha) * bg[2] + alpha * fab[2];
    const A = (1 - alpha) * bg[1] + alpha * target[1] + (p[1] - mixA) * 0.5;
    const B = (1 - alpha) * bg[2] + alpha * target[2] + (p[2] - mixB) * 0.5;
    const [r, g, b] = toRgb(Math.max(0, Math.min(100, L)), A, B);
    out[k] = r; out[k + 1] = g; out[k + 2] = b;
  }
  return sharp(out, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

/** 캐시 파일 이름 — 원본 칸 파일 이름 + 목표 hex + 알고리즘 버전 */
function cacheName(srcUrl: string, hex: string): string {
  // uploadBuffer 의 sanitizeFilename 과 같은 규칙으로 만들어야 캐시 확인(HEAD) 주소가 실제 업로드 주소와 맞는다
  // (밑줄 연속은 하나로 합쳐진다 — "__" 로 만들었더니 매번 캐시를 못 찾고 다시 올렸다)
  const base = (srcUrl.split('?')[0].split('/').pop() || 'panel').replace(/\.[a-z0-9]+$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return sanitizeFilename(`${base}_${hex.slice(1).toLowerCase()}_${VERSION}.jpg`);
}

/**
 * 칸 URL + 목표 hex → 색을 바꾼 칸의 공개 URL.
 * 이미 올라가 있으면 그대로 돌려준다. 실패하면 원본 URL 을 돌려주고 recolored=false —
 * 생성을 멈추기보다 원본 색 칸 + "색은 글·스와치를 따르라" 문구로 가는 편이 낫다.
 */
export async function recoloredPanelUrl(srcUrl: string, hexRaw: string): Promise<{ url: string; recolored: boolean }> {
  const hex = normalizeHex(hexRaw);
  if (!hex || !ftpConfigured()) return { url: srcUrl, recolored: false };
  const name = cacheName(srcUrl, hex);
  const url = publicUrl(SUBPATH, name);
  const key = `${srcUrl}|${hex}`;
  if (!memo.has(key)) {
    memo.set(key, (async () => {
      const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (head?.ok) return url;
      const res = await fetch(srcUrl, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`칸 이미지를 받지 못했습니다 (${res.status})`);
      const buf = await recolorPanelBuffer(Buffer.from(await res.arrayBuffer()), hex);
      if (!buf) return '';           // 보정 불가 — 올리지 않고 원본 칸으로
      return uploadBuffer(SUBPATH, name, buf);
    })());
  }
  try {
    const got = await memo.get(key)!;
    return got ? { url: got, recolored: true } : { url: srcUrl, recolored: false };
  } catch (e) {
    memo.delete(key);
    console.warn('[sheet-recolor] 색 보정 실패 — 원본 칸을 씁니다:', srcUrl, (e as Error).message);
    return { url: srcUrl, recolored: false };
  }
}
