import 'server-only';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { getDb } from './db';
import { uploadBuffer, publicUrl, ftpConfigured } from './ftp';

/**
 * 로고·태그를 "글"이 아니라 "픽셀"로 막는다 (사용자 지시 2026-09-15: "로고 막는 건 한 번 더 가보자").
 *
 * 왜 글만으로는 안 됐나 — 실측 컷 Drop_navy_W_B_20260915080722:
 *   프롬프트 끝에 NO LOGO — MANDATORY 가 들어가 있었는데도 태그가 나왔다. 포즈 소스로 넣은 9/11 컷
 *   (로고 규칙 이전)에 태그가 붙어 있었고, 제미나이는 그 컷의 빈백을 태그째 옮겨 그렸다.
 *   13,000자 프롬프트 끝의 한 문장은 눈에 보이는 참조 사진을 못 이긴다.
 *
 * 그래서 두 겹으로 막는다.
 *   ① 보내기 전 — 사진 참조(포즈 소스·베이스·배경·공식 제품 사진 등)에서 태그를 찾아 지운 사본을 보낸다.
 *      같은 사진은 결과가 같으므로 logo_scans 에 기록해 두고 다시 검사하지 않는다.
 *   ② 받은 뒤 — 결과물에서 한 번 더 찾아, 남아 있으면 그 자리를 주변 원단으로 메운다.
 *
 * 찾기는 제미나이 비전(텍스트 응답, 이미지 생성보다 훨씬 가벼운 호출)이, 지우기는 로컬 픽셀 연산이 한다 —
 * 이미지를 다시 생성하지 않으므로 얼굴·구도는 한 픽셀도 안 바뀐다.
 * 찾기가 실패하면(키 없음·한도·네트워크) 생성을 막지 않고 원본으로 진행한다.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// lg1 — 첫 버전. 지우는 방식이 바뀌면 올려서 새 이름으로 올린다 (cafe24 7일 캐시)
const VERSION = 'lg1';
const SUBPATH = 'ai-refclean';
const SCANS = 'logo_scans';

export const visionModel = () => process.env.GEMINI_VISION_MODEL || 'gemini-3.5-flash';

export interface PxBox { x0: number; y0: number; x1: number; y1: number; label?: string }
export interface VisionUsage { promptTokens: number; outputTokens: number; thoughtTokens: number; totalTokens: number }
export interface TopFold { suspected: boolean; note: string }
export interface Inspection { tags: PxBox[]; topFold: TopFold | null; usage?: VisionUsage; model: string }

const TAG_PROMPT =
  'Find every brand tag, sewn fabric label, loop tab, patch, logo or printed wordmark that is attached to a bean bag, ' +
  'cushion or soft seat in this photo — for example a small white rectangular tag with "yogibo" lettering sewn onto the fabric. ' +
  'Do NOT include books, papers, pictures, screens, packaging, clothing prints or anything that is not attached to a bean bag or cushion.';

/*
 * 윗부분 말림 판정. 기대 형태를 안 주면 "꽉 찬 물방울 모양이라 정상" 이라고 넘긴다
 * (실측 2026-09-15: 사용자가 짚은 Drop 컷을 suspected=false 로 판정). 그래서 제품별 정답 형태를 같이 준다.
 */
const foldPrompt = (expected: string[], exempt: string[]) =>
  'Also judge the SHAPE of the bean bag(s). ' +
  (expected.length ? `The correct shapes are: ${expected.join(' | ')}. ` : '') +
  `Set top_fold.suspected to true if the upper part of any bean bag${exempt.length ? ` (other than ${exempt.join(' and ')}, which you must not judge)` : ''} ` +
  'is narrower or more tapered than its correct shape, rises into a pointed, teardrop-like or horn-like top, leans or bends over, ' +
  'folds over, flops backwards, curls or rolls over — instead of staying a full, rounded top as its correct shape describes. ' +
  'Judge against the correct shape, not against whether it looks plausible. Describe what you see in top_fold.note (one short sentence).';

/** 제미나이 비전으로 태그 위치(와 선택적으로 윗부분 말림)를 찾는다. 실패하면 null */
/**
 * 윗부분 말림 판정에서 빼는 제품.
 *  Pyramid — 끝이 짧게 뾰족한 게 정상 (사용자: "피라미드 제품이 아니면")
 *  Lounger — 등받이가 높게 솟은 게 정상인데 "물방울처럼 솟았다" 로 오판 (실측 2026-09-15 초코브라운 컷)
 */
export const FOLD_EXEMPT_LINES = new Set(['Pyramid', 'Lounger']);

export async function inspectImage(buf: Buffer, opts: { topFold?: boolean; expectedShapes?: string[]; exemptProducts?: string[] } = {}): Promise<Inspection | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = visionModel();
  try {
    const meta = await sharp(buf).metadata();
    const W = meta.width ?? 0, H = meta.height ?? 0;
    if (!W || !H) return null;
    // 1024 면 작은 태그도 보인다 (실측: 2048 컷의 60×75px 태그를 찾음)
    const small = await sharp(buf).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    const text =
      `${TAG_PROMPT}\n${opts.topFold ? `${foldPrompt(opts.expectedShapes ?? [], opts.exemptProducts ?? [])}\n` : ''}` +
      'Return JSON only, in this exact form: {"tags":[{"box_2d":[ymin,xmin,ymax,xmax],"label":"..."}]' +
      `${opts.topFold ? ',"top_fold":{"suspected":false,"note":"..."}' : ''}} ` +
      'with box coordinates normalised to 0-1000. Use an empty tags array when there are none.';
    const res = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ inlineData: { mimeType: 'image/jpeg', data: small.toString('base64') } }, { text }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      console.warn('[logo-guard] 비전 호출 실패', res.status, (await res.text().catch(() => '')).slice(0, 200));
      return null;
    }
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
    };
    const raw = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as {
      tags?: { box_2d?: number[]; label?: string }[];
      top_fold?: { suspected?: boolean; note?: string };
    };
    const tags: PxBox[] = [];
    for (const t of parsed.tags ?? []) {
      const b = t.box_2d;
      if (!Array.isArray(b) || b.length !== 4 || b.some((v) => !Number.isFinite(v))) continue;
      const [ymin, xmin, ymax, xmax] = b.map((v) => Math.max(0, Math.min(1000, v)));
      const box = {
        x0: Math.floor((Math.min(xmin, xmax) / 1000) * W), y0: Math.floor((Math.min(ymin, ymax) / 1000) * H),
        x1: Math.ceil((Math.max(xmin, xmax) / 1000) * W), y1: Math.ceil((Math.max(ymin, ymax) / 1000) * H),
        label: String(t.label ?? '').slice(0, 60),
      };
      const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
      // 태그는 작다 — 화면의 6% 를 넘는 상자는 오검출로 보고 건드리지 않는다 (빈백 통째로 지우는 사고 방지)
      if (bw < 3 || bh < 3 || (bw * bh) / (W * H) > 0.06) continue;
      tags.push(box);
    }
    const um = json.usageMetadata;
    return {
      tags,
      topFold: opts.topFold && parsed.top_fold
        ? { suspected: !!parsed.top_fold.suspected, note: String(parsed.top_fold.note ?? '').slice(0, 200) }
        : null,
      ...(um ? {
        usage: {
          promptTokens: um.promptTokenCount ?? 0,
          outputTokens: um.candidatesTokenCount ?? 0,
          thoughtTokens: um.thoughtsTokenCount ?? 0,
          totalTokens: um.totalTokenCount ?? 0,
        },
      } : {}),
      model,
    };
  } catch (e) {
    console.warn('[logo-guard] 비전 검사 실패 — 원본으로 진행:', (e as Error).message);
    return null;
  }
}

/**
 * 상자 자리를 주변 원단으로 메운다.
 *  1) 상자 바깥 고리의 중앙값 = 원단 색. 상자 + 여유 안에서 그 색과 먼 픽셀(태그 흰 바탕·글자·그림자)만 마스크.
 *  2) 마스크를 가로·세로 선형 보간으로 채운 뒤 조화 확산으로 매끈하게 — 명암(주름 음영)이 이어진다.
 *  3) 옆 칸의 원단 결(고주파)을 옮겨 붙여 뭉개진 티를 없앤다.
 * 실측: Drop 네이비 컷 태그(60×75px) — 지운 자리를 확대해도 구분 안 됨.
 */
export async function eraseBoxes(buf: Buffer, boxes: PxBox[]): Promise<Buffer> {
  const img = sharp(buf).removeAlpha();
  const meta = await img.metadata();
  const W = meta.width ?? 0, H = meta.height ?? 0;
  if (!W || !H || !boxes.length) return buf;
  const src = await img.raw().toBuffer();
  const out = Buffer.from(src);
  const px = (x: number, y: number, c: number) => out[(y * W + x) * 3 + c];

  for (const b of boxes) {
    const x0 = Math.max(0, b.x0), y0 = Math.max(0, b.y0), x1 = Math.min(W, b.x1), y1 = Math.min(H, b.y1);
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    const pad = Math.max(6, Math.round(Math.max(x1 - x0, y1 - y0) * 0.35));
    const X0 = Math.max(0, x0 - pad), Y0 = Math.max(0, y0 - pad), X1 = Math.min(W, x1 + pad), Y1 = Math.min(H, y1 + pad);
    const R = Math.max(pad * 2, 16);
    const RX0 = Math.max(0, X0 - R), RY0 = Math.max(0, Y0 - R), RX1 = Math.min(W, X1 + R), RY1 = Math.min(H, Y1 + R);
    const w = RX1 - RX0, h = RY1 - RY0;

    // 1) 원단 색 = 고리 중앙값
    const ring: number[][] = [[], [], []];
    for (let y = RY0; y < RY1; y++) for (let x = RX0; x < RX1; x++) {
      if (x >= X0 && x < X1 && y >= Y0 && y < Y1) continue;
      for (let c = 0; c < 3; c++) ring[c].push(px(x, y, c));
    }
    if (!ring[0].length) continue;
    const med = ring.map((a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; });

    const M = new Uint8Array(w * h);
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      const d = Math.hypot(px(x, y, 0) - med[0], px(x, y, 1) - med[1], px(x, y, 2) - med[2]);
      const core = x >= x0 && x < x1 && y >= y0 && y < y1;
      if (core || d > 40) M[(y - RY0) * w + (x - RX0)] = 1;
    }
    // 태그 가장자리 반쪽 픽셀까지 — 3px 팽창 (여유 상자 밖으로는 안 번진다)
    for (let it = 0; it < 3; it++) {
      const N = M.slice();
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (M[i] || !(M[i - 1] || M[i + 1] || M[i - w] || M[i + w])) continue;
        const gx = x + RX0, gy = y + RY0;
        if (gx >= X0 - 3 && gx < X1 + 3 && gy >= Y0 - 3 && gy < Y1 + 3) N[i] = 1;
      }
      M.set(N);
    }

    // 2) 채움 — 선형 보간으로 초기값, 조화 확산으로 다듬기
    const F = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
    for (let c = 0; c < 3; c++) {
      const f = F[c];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[y * w + x] = px(x + RX0, y + RY0, c);
      const rowFill = new Float32Array(w * h), colFill = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        let x = 0;
        while (x < w) {
          if (!M[y * w + x]) { x++; continue; }
          const s = x; while (x < w && M[y * w + x]) x++;
          const L = s > 0 ? f[y * w + s - 1] : med[c], Rv = x < w ? f[y * w + x] : med[c];
          for (let k = s; k < x; k++) rowFill[y * w + k] = L + ((Rv - L) * (k - s + 1)) / (x - s + 1);
        }
      }
      for (let x = 0; x < w; x++) {
        let y = 0;
        while (y < h) {
          if (!M[y * w + x]) { y++; continue; }
          const s = y; while (y < h && M[y * w + x]) y++;
          const T = s > 0 ? f[(s - 1) * w + x] : med[c], Bv = y < h ? f[y * w + x] : med[c];
          for (let k = s; k < y; k++) colFill[k * w + x] = T + ((Bv - T) * (k - s + 1)) / (y - s + 1);
        }
      }
      for (let i = 0; i < w * h; i++) if (M[i]) f[i] = (rowFill[i] + colFill[i]) / 2;
      for (let it = 0; it < 250; it++) {
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (M[i]) f[i] = (f[i - 1] + f[i + 1] + f[i - w] + f[i + w]) / 4;
        }
      }
    }

    // 3) 결 옮기기 — 위·아래·왼·오른 이웃 칸 중 원단색에 가장 가까운 곳의 고주파
    const mw = X1 - X0, mh = Y1 - Y0;
    const lum = (x: number, y: number) => 0.299 * src[(y * W + x) * 3] + 0.587 * src[(y * W + x) * 3 + 1] + 0.114 * src[(y * W + x) * 3 + 2];
    let best: [number, number] | null = null, bestScore = Infinity;
    for (const [dx, dy] of [[0, -mh], [0, mh], [-mw, 0], [mw, 0]]) {
      const sx = X0 + dx, sy = Y0 + dy;
      if (sx < 1 || sy < 1 || sx + mw >= W - 1 || sy + mh >= H - 1) continue;
      let s = 0, n = 0;
      for (let y = 0; y < mh; y += 2) for (let x = 0; x < mw; x += 2) {
        const o = ((sy + y) * W + sx + x) * 3;
        s += Math.hypot(src[o] - med[0], src[o + 1] - med[1], src[o + 2] - med[2]); n++;
      }
      if (n && s / n < bestScore) { bestScore = s / n; best = [sx, sy]; }
    }
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      const i = (y - RY0) * w + (x - RX0);
      if (!M[i]) continue;
      let g = 0;
      if (best) {
        const sx = best[0] + (x - X0), sy = best[1] + (y - Y0);
        g = lum(sx, sy) - (lum(sx - 1, sy) + lum(sx + 1, sy) + lum(sx, sy - 1) + lum(sx, sy + 1)) / 4;
      }
      // 마스크 가장자리 2px 는 원본과 섞어 경계선이 안 보이게
      let edge = false;
      for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
        const gx = x - RX0 + dx, gy = y - RY0 + dy;
        if (gx < 0 || gy < 0 || gx >= w || gy >= h || !M[gy * w + gx]) { edge = true; break; }
      }
      const a = edge ? 0.6 : 1;
      for (let c = 0; c < 3; c++) {
        const o = (y * W + x) * 3 + c;
        out[o] = Math.max(0, Math.min(255, Math.round(a * (F[c][i] + g) + (1 - a) * out[o])));
      }
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

/** 생성 결과 검사 — 태그는 지우고, 윗부분 말림은 표시만 한다(다시 생성은 비용이라 사람이 판단) */
export async function guardOutput(buf: Buffer, opts: { topFold?: boolean; expectedShapes?: string[]; exemptProducts?: string[] } = {}): Promise<{
  buffer: Buffer; erased: PxBox[]; topFold: TopFold | null; usage?: VisionUsage; model: string; checked: boolean;
}> {
  const found = await inspectImage(buf, opts);
  if (!found) return { buffer: buf, erased: [], topFold: null, model: visionModel(), checked: false };
  const buffer = found.tags.length ? await eraseBoxes(buf, found.tags) : buf;
  return { buffer, erased: found.tags, topFold: found.topFold, ...(found.usage ? { usage: found.usage } : {}), model: found.model, checked: true };
}

/** 같은 프로세스 안에서 같은 사진을 두 번 검사하지 않는다 (동시 요청 포함) */
const memo = new Map<string, Promise<string>>();

/**
 * 참조 사진 URL → 태그를 지운 사본 URL (없으면 원래 URL).
 * 결과는 logo_scans 에 남긴다 — 태그가 없던 사진도 "검사함"으로 기록해 다음부터 비전 호출을 안 한다.
 * 검사가 실패하면 기록하지 않고 원래 URL 로 진행한다 (다음 요청에서 다시 시도).
 */
export async function scrubReferenceUrl(url: string): Promise<{ url: string; cleaned: boolean }> {
  if (!/^https?:\/\//i.test(url) || !ftpConfigured() || !process.env.GEMINI_API_KEY) return { url, cleaned: false };
  const id = `${createHash('sha1').update(url).digest('hex').slice(0, 20)}_${VERSION}`;
  if (!memo.has(id)) {
    memo.set(id, (async () => {
      const db = await getDb();
      const col = db.collection(SCANS);
      const hit = await col.findOne({ _id: id as never });
      if (hit) return String(hit.cleanUrl || '');
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`참조를 받지 못했습니다 (${res.status})`);
      const raw = Buffer.from(await res.arrayBuffer());
      const found = await inspectImage(raw);
      if (!found) throw new Error('비전 검사 실패');
      let cleanUrl = '';
      if (found.tags.length) {
        const name = `${id}.jpg`;
        // 이미 올라가 있으면(다른 프로세스가 먼저 지움) 다시 올리지 않는다
        const head = await fetch(publicUrl(SUBPATH, name), { method: 'HEAD', signal: AbortSignal.timeout(8000) }).catch(() => null);
        cleanUrl = head?.ok ? publicUrl(SUBPATH, name) : await uploadBuffer(SUBPATH, name, await eraseBoxes(raw, found.tags));
      }
      await col.updateOne(
        { _id: id as never },
        { $set: { url, cleanUrl, tags: found.tags, model: found.model, ...(found.usage ? { usage: found.usage } : {}), checkedAt: new Date() } },
        { upsert: true },
      );
      return cleanUrl;
    })());
  }
  try {
    const got = await memo.get(id)!;
    return got ? { url: got, cleaned: true } : { url, cleaned: false };
  } catch (e) {
    memo.delete(id);
    console.warn('[logo-guard] 참조 검사 실패 — 원본을 씁니다:', url, (e as Error).message);
    return { url, cleaned: false };
  }
}
