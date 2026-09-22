import 'server-only';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { getDb } from './db';
import { uploadBuffer, ftpConfigured } from './ftp';

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
 * 찾기가 실패하면(키 없음·한도·네트워크·엉뚱한 응답) 생성을 막지 않고 원본으로 진행하고, 기록도 남기지 않는다.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
/*
 * 버전 — 지우는 방식이 바뀌면 올린다. 이전 버전으로 지운 사본은 다시 쓰지 않는다 (logo_scans id 에 붙는다).
 * lg2 (2026-09-15 검토 반영): 마스크가 태그에 붙은 픽셀로만 번지게, 여백 상한, 원단 아닌 자리는 안 지움.
 *   lg1 은 여백 안의 "원단색 아닌 픽셀" 전부를 칠해 옆의 손·빈백 윤곽까지 뭉갤 수 있었다.
 */
const VERSION = 'lg2';
const SUBPATH = 'ai-refclean';
const SCANS = 'logo_scans';

export const visionModel = () => process.env.GEMINI_VISION_MODEL || 'gemini-3.5-flash';

export interface PxBox {
  x0: number; y0: number; x1: number; y1: number; label?: string;
  /** judgeTags 일 때만 — 진짜 봉제 태그처럼 "yogibo" 글자가 또렷한가 */
  legible?: boolean;
}
export interface VisionUsage { promptTokens: number; outputTokens: number; thoughtTokens: number; totalTokens: number }
export interface TopFold { suspected: boolean; note: string }
export interface Inspection { tags: PxBox[]; topFold: TopFold | null; usage?: VisionUsage; model: string }

/*
 * 실촬영 태그 판정 — 드롭박스 실촬영본을 원본으로 쓰면 진짜 태그는 살린다 (사용자 결정 2026-09-22).
 * 제미나이가 다시 그린 태그는 글자가 뭉개지기 쉽다("qo ㅕo").
 *
 * "또렷한가" 를 비전에게 직접 물으면 흔들린다 (실측 2026-09-22, 4장):
 *   전체를 1024 로 줄여 물으면 세로로 돌아간 작은 진짜 태그를 "애매" 로 버리고,
 *   "기울거나 가려져도 괜찮다" 로 풀면 「13715」 같은 뭉개진 AI 태그까지 진짜라고 한다.
 * 그래서 찾은 태그 자리를 원본 해상도로 잘라 크게 보여 주고 "보이는 글자를 그대로 받아 적게" 한 뒤, 판정은 코드가 한다 —
 *   정확히 yogibo 면 진짜, 일부가 가려졌으면 보이는 글자가 yogibo 의 순서대로 된 일부(3글자 이상)일 때만 진짜.
 *   읽히지 않는 글자(?)가 하나라도 섞이면 가짜 (AI 가 yogibo 밑에 붙이는 뭉개진 작은 글씨).
 * 같은 4장 시험: 진짜 태그 「yogibo」 살림 · AI 태그 「13715」「yogibo ????」「springees」 지움.
 */
const READ_PROMPT = (n: number) =>
  `Each of the ${n} images is a close-up crop of one fabric tag (crop 1 first). Transcribe EXACTLY the letters you can actually see ` +
  'on each tag, character by character, in reading order — do not correct, guess or complete the word; write "?" for any character ' +
  'that is present but not clearly a letter. Also say whether part of the tag is hidden by a fold or cut off by the crop. ' +
  `Return JSON only: {"tags":[{"text":"...","hidden":false}]} with exactly ${n} entries in crop order.`;

/** 받아 적은 글자가 진짜 yogibo 태그인가 — 위 설명의 규칙 */
function isGenuineTagText(text: unknown, hidden: unknown): boolean {
  const raw = String(text ?? '').toLowerCase();
  if (raw.includes('?')) return false;
  const s = raw.replace(/[^a-z]/g, '');
  if (s === 'yogibo') return true;
  if (hidden !== true || s.length < 3) return false;
  let i = 0;
  for (const c of 'yogibo') if (c === s[i]) i++;
  return i === s.length;
}

/**
 * 찾은 태그마다 진짜인지 판정한다 — 원본 해상도로 잘라(여백 40%) 한 번의 비전 호출로 받아 적게 한다.
 * 실패하면 전부 false(지움) — 모르는 태그를 살리는 것보다 비우는 게 낫다.
 */
async function judgeTagsGenuine(
  upright: Buffer, W: number, H: number, boxes: PxBox[], key: string, model: string,
): Promise<{ genuine: boolean[]; usage?: VisionUsage }> {
  const list = boxes.slice(0, 8); // 비용 상한 — 한 컷에 태그가 8개를 넘을 일은 없다
  try {
    const crops: Buffer[] = [];
    for (const b of list) {
      const mx = (b.x1 - b.x0) * 0.4, my = (b.y1 - b.y0) * 0.4;
      const L = Math.max(0, Math.floor(b.x0 - mx)), T = Math.max(0, Math.floor(b.y0 - my));
      const R = Math.min(W, Math.ceil(b.x1 + mx)), B = Math.min(H, Math.ceil(b.y1 + my));
      crops.push(await sharp(upright).extract({ left: L, top: T, width: R - L, height: B - T })
        .resize({ width: 384, height: 384, fit: 'inside' }).jpeg({ quality: 92 }).toBuffer());
    }
    const res = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [...crops.map((c) => ({ inlineData: { mimeType: 'image/jpeg', data: c.toString('base64') } })), { text: READ_PROMPT(crops.length) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`태그 읽기 호출 실패 ${res.status}`);
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
    };
    const raw = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as { tags?: { text?: unknown; hidden?: unknown }[] };
    const read = Array.isArray(parsed?.tags) ? parsed.tags : [];
    const um = json.usageMetadata;
    return {
      genuine: boxes.map((_, i) => (i < read.length ? isGenuineTagText(read[i]?.text, read[i]?.hidden) : false)),
      ...(um ? { usage: { promptTokens: um.promptTokenCount ?? 0, outputTokens: um.candidatesTokenCount ?? 0, thoughtTokens: um.thoughtsTokenCount ?? 0, totalTokens: um.totalTokenCount ?? 0 } } : {}),
    };
  } catch (e) {
    console.warn('[logo-guard] 태그 읽기 실패 — 전부 지움으로 둔다:', (e as Error).message);
    return { genuine: boxes.map(() => false) };
  }
}

const TAG_PROMPT =
  'Find every brand tag, sewn fabric label, loop tab, patch, logo or printed wordmark that is attached to a bean bag, ' +
  'cushion or soft seat in this photo — for example a small white rectangular tag with "yogibo" lettering sewn onto the fabric. ' +
  'Do NOT include books, papers, pictures, screens, packaging, clothing prints or anything that is not attached to a bean bag or cushion. ' +
  'Draw each box tightly around the tag itself.';

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

/** 제미나이 비전으로 태그 위치(와 선택적으로 윗부분 말림)를 찾는다. 실패하거나 응답 모양이 이상하면 null */
export async function inspectImage(
  buf: Buffer,
  opts: { topFold?: boolean; expectedShapes?: string[]; exemptProducts?: string[]; judgeTags?: boolean } = {},
): Promise<Inspection | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = visionModel();
  try {
    // 방향 태그(EXIF)를 먼저 픽셀에 굽는다 — 비전이 본 좌표와 지울 픽셀 좌표가 같은 방향이어야 한다
    const upright = await sharp(buf).rotate().toBuffer();
    const meta = await sharp(upright).metadata();
    const W = meta.width ?? 0, H = meta.height ?? 0;
    if (!W || !H) return null;
    // 1024 면 작은 태그도 보인다 (실측: 2048 컷의 60×75px 태그를 찾음)
    const small = await sharp(upright).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
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
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as unknown;
    /*
     * 응답 모양 검사 — tags 배열이 없으면 "검사함, 태그 없음" 이 아니라 "검사 실패" 다.
     * 이걸 태그 없음으로 받으면 태그가 있는 참조가 logo_scans 에 "깨끗함" 으로 영구 기록된다.
     * 제미나이가 가끔 쓰는 [{box_2d,...}] 최상위 배열 형식은 태그 목록으로 받아준다.
     */
    const obj = (Array.isArray(parsed) ? null : parsed) as { tags?: unknown; top_fold?: { suspected?: unknown; note?: unknown } } | null;
    const tagList: unknown = Array.isArray(parsed) ? parsed : obj?.tags;
    if (!Array.isArray(tagList)) throw new Error(`비전 응답 모양이 다릅니다: ${raw.slice(0, 120)}`);
    if (opts.topFold && (!obj?.top_fold || typeof obj.top_fold !== 'object')) throw new Error('비전 응답에 top_fold 가 없습니다');

    const tags: PxBox[] = [];
    for (const t of tagList as { box_2d?: number[]; label?: string }[]) {
      const b = t?.box_2d;
      if (!Array.isArray(b) || b.length !== 4 || b.some((v) => !Number.isFinite(v))) continue;
      const [ymin, xmin, ymax, xmax] = b.map((v) => Math.max(0, Math.min(1000, v)));
      const box = {
        x0: Math.floor((Math.min(xmin, xmax) / 1000) * W), y0: Math.floor((Math.min(ymin, ymax) / 1000) * H),
        x1: Math.ceil((Math.max(xmin, xmax) / 1000) * W), y1: Math.ceil((Math.max(ymin, ymax) / 1000) * H),
        label: String(t.label ?? '').slice(0, 60),
      };
      const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
      /*
       * 태그는 작고 대체로 네모다 (실측 2K 컷에서 60~150px). 아래는 오검출로 보고 건드리지 않는다 —
       * 너무 작음 · 긴 막대(가로세로 6배 초과) · 긴 변이 이미지 긴 변의 12% 초과 · 면적 3% 초과.
       */
      if (bw < 3 || bh < 3) continue;
      if (Math.max(bw, bh) / Math.min(bw, bh) > 6) continue;
      if (Math.max(bw, bh) > 0.12 * Math.max(W, H) || (bw * bh) / (W * H) > 0.03) continue;
      tags.push(box);
    }
    const um = json.usageMetadata;
    let usage: VisionUsage | undefined = um ? {
      promptTokens: um.promptTokenCount ?? 0,
      outputTokens: um.candidatesTokenCount ?? 0,
      thoughtTokens: um.thoughtsTokenCount ?? 0,
      totalTokens: um.totalTokenCount ?? 0,
    } : undefined;
    // 실촬영 원본 모드 — 찾은 태그마다 진짜인지 원본 해상도로 다시 읽어 판정한다 (위 READ_PROMPT 설명)
    if (opts.judgeTags && tags.length) {
      const jd = await judgeTagsGenuine(upright, W, H, tags, key, model);
      tags.forEach((t, i) => { t.legible = jd.genuine[i] === true; });
      if (jd.usage) {
        const u = jd.usage;
        usage = usage
          ? { promptTokens: usage.promptTokens + u.promptTokens, outputTokens: usage.outputTokens + u.outputTokens, thoughtTokens: usage.thoughtTokens + u.thoughtTokens, totalTokens: usage.totalTokens + u.totalTokens }
          : u;
      }
    }
    return {
      tags,
      topFold: opts.topFold && obj?.top_fold
        ? { suspected: obj.top_fold.suspected === true, note: String(obj.top_fold.note ?? '').slice(0, 200) }
        : null,
      ...(usage ? { usage } : {}),
      model,
    };
  } catch (e) {
    console.warn('[logo-guard] 비전 검사 실패 — 원본으로 진행:', (e as Error).message);
    return null;
  }
}

/** 256칸 히스토그램으로 중앙값 — 수백만 개 숫자를 배열에 담아 정렬하지 않는다 */
function histMedian(hist: Uint32Array, count: number): number {
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc * 2 >= count) return v; }
  return 255;
}

/**
 * 상자 자리를 주변 원단으로 메운다. 지운 상자 목록과 결과 버퍼를 돌려준다.
 *  1) 상자 바깥 고리의 중앙값 = 원단 색. 고리의 대부분이 원단색이 아니면(태그가 빈백 가장자리에 걸림) 그 상자는 안 지운다.
 *  2) 마스크는 상자(태그 자체)에서 시작해, 원단색과 먼 픽셀이 "이어져 있을 때만" 작은 여백 안으로 번진다 —
 *     태그 옆에 있어도 떨어져 있는 손·팔·벽·빈백 윤곽은 건드리지 않는다.
 *  3) 가로·세로 선형 보간으로 채운 뒤 마스크 픽셀만 조화 확산으로 다듬어 명암(주름 음영)을 잇는다.
 *  4) 옆 칸의 원단 결(고주파)을 옮겨 붙여 뭉개진 티를 없앤다.
 * 실측: Drop 네이비 컷 태그(60×75px) — 지운 자리를 확대해도 구분 안 됨.
 */
export async function eraseBoxes(buf: Buffer, boxes: PxBox[]): Promise<{ buffer: Buffer; erased: PxBox[] }> {
  const img = sharp(buf).rotate().removeAlpha().toColourspace('srgb');
  const { data: src, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, CH = info.channels;
  if (!W || !H || !boxes.length || CH < 3) return { buffer: buf, erased: [] };
  const out = Buffer.from(src);
  const px = (x: number, y: number, c: number) => out[(y * W + x) * CH + c];
  const erased: PxBox[] = [];

  for (const b of boxes) {
    const x0 = Math.max(0, b.x0), y0 = Math.max(0, b.y0), x1 = Math.min(W, b.x1), y1 = Math.min(H, b.y1);
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    // 번질 수 있는 여백 — 태그 가장자리 반쪽 픽셀·그림자 정도만 (상한 12px)
    const pad = Math.min(12, Math.max(4, Math.round(Math.max(x1 - x0, y1 - y0) * 0.2)));
    const X0 = Math.max(0, x0 - pad), Y0 = Math.max(0, y0 - pad), X1 = Math.min(W, x1 + pad), Y1 = Math.min(H, y1 + pad);
    // 원단 색·결을 보는 고리 — 여백 바깥 24px
    const R = 24;
    const RX0 = Math.max(0, X0 - R), RY0 = Math.max(0, Y0 - R), RX1 = Math.min(W, X1 + R), RY1 = Math.min(H, Y1 + R);
    const w = RX1 - RX0, h = RY1 - RY0;

    // 1) 원단 색 = 고리 중앙값 (히스토그램)
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    let ringN = 0;
    for (let y = RY0; y < RY1; y++) for (let x = RX0; x < RX1; x++) {
      if (x >= X0 && x < X1 && y >= Y0 && y < Y1) continue;
      for (let c = 0; c < 3; c++) hist[c][px(x, y, c)]++;
      ringN++;
    }
    if (!ringN) continue;
    const med = [histMedian(hist[0], ringN), histMedian(hist[1], ringN), histMedian(hist[2], ringN)];
    const dist = (x: number, y: number) => Math.hypot(px(x, y, 0) - med[0], px(x, y, 1) - med[1], px(x, y, 2) - med[2]);
    let fabricLike = 0;
    for (let y = RY0; y < RY1; y += 2) for (let x = RX0; x < RX1; x += 2) {
      if (x >= X0 && x < X1 && y >= Y0 && y < Y1) continue;
      if (dist(x, y) <= 40) fabricLike++;
    }
    // 고리가 원단으로 둘러싸여 있지 않다 = 가장자리·다른 물체에 걸침 — 메우면 윤곽이 뭉개지므로 이 상자는 건너뛴다
    if (fabricLike / Math.max(1, Math.ceil(ringN / 4)) < 0.6) continue;

    // 2) 마스크 — 코어 상자 전체 + 여백 안에서 코어와 이어진 "원단색 아닌" 픽셀 (BFS)
    const M = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let qh = 0, qt = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y - RY0) * w + (x - RX0);
      M[i] = 1; queue[qt++] = i;
    }
    while (qh < qt) {
      const i = queue[qh++];
      const lx = i % w, ly = (i / w) | 0;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = lx + dx, ny = ly + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const gx = nx + RX0, gy = ny + RY0;
        if (gx < X0 || gx >= X1 || gy < Y0 || gy >= Y1) continue;
        const j = ny * w + nx;
        if (M[j] || dist(gx, gy) <= 40) continue;
        M[j] = 1; queue[qt++] = j;
      }
    }
    // 반쪽 픽셀 테두리 — 2px 팽창 (여백 상자 밖으로는 안 번진다)
    for (let it = 0; it < 2; it++) {
      const N = M.slice();
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (M[i] || !(M[i - 1] || M[i + 1] || M[i - w] || M[i + w])) continue;
        const gx = x + RX0, gy = y + RY0;
        if (gx >= X0 && gx < X1 && gy >= Y0 && gy < Y1) N[i] = 1;
      }
      M.set(N);
    }
    const idx: number[] = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (M[y * w + x]) idx.push(y * w + x);

    // 3) 채움 — 선형 보간 초기값 + 마스크 픽셀만 조화 확산
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
      for (let it = 0; it < 250; it++) for (const i of idx) f[i] = (f[i - 1] + f[i + 1] + f[i - w] + f[i + w]) / 4;
    }

    // 4) 결 옮기기 — 위·아래·왼·오른 이웃 칸 중 원단색에 가장 가까운 곳의 고주파
    const mw = X1 - X0, mh = Y1 - Y0;
    const lum = (x: number, y: number) => 0.299 * src[(y * W + x) * CH] + 0.587 * src[(y * W + x) * CH + 1] + 0.114 * src[(y * W + x) * CH + 2];
    let best: [number, number] | null = null, bestScore = Infinity;
    for (const [dx, dy] of [[0, -mh], [0, mh], [-mw, 0], [mw, 0]]) {
      const sx = X0 + dx, sy = Y0 + dy;
      if (sx < 1 || sy < 1 || sx + mw >= W - 1 || sy + mh >= H - 1) continue;
      let s = 0, n = 0;
      for (let y = 0; y < mh; y += 2) for (let x = 0; x < mw; x += 2) {
        const o = ((sy + y) * W + sx + x) * CH;
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
      // 마스크 가장자리 2px 는 원본과 섞어 경계선이 안 보이게. 이미지 테두리에 잘린 쪽은 경계가 아니다
      let edge = false;
      for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
        const gx = x - RX0 + dx, gy = y - RY0 + dy;
        if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
        if (!M[gy * w + gx]) { edge = true; break; }
      }
      const a = edge ? 0.6 : 1;
      for (let c = 0; c < 3; c++) {
        const o = (y * W + x) * CH + c;
        out[o] = Math.max(0, Math.min(255, Math.round(a * (F[c][i] + g) + (1 - a) * out[o])));
      }
    }
    erased.push(b);
  }
  if (!erased.length) return { buffer: buf, erased };
  const buffer = await sharp(out, { raw: { width: W, height: H, channels: CH as 3 | 4 } }).jpeg({ quality: 92 }).toBuffer();
  return { buffer, erased };
}

/** 생성 결과 검사 — 태그는 지우고, 윗부분 말림은 표시만 한다(다시 생성은 비용이라 사람이 판단) */
export async function guardOutput(
  buf: Buffer,
  opts: {
    topFold?: boolean; expectedShapes?: string[]; exemptProducts?: string[];
    /**
     * 드롭박스 실촬영본이 원본일 때 — 또렷한 "yogibo" 태그는 살리고, 뭉개진 것과 원본보다 늘어난 것만 지운다.
     * max = 원본 사진에 있던 태그 수 (모르면 null — 그때는 뭉개진 것만 지운다).
     */
    keepReal?: { max: number | null };
  } = {},
): Promise<{ buffer: Buffer; found: number; erased: PxBox[]; kept: number; topFold: TopFold | null; usage?: VisionUsage; model: string; checked: boolean }> {
  try {
    const { keepReal, ...inspectOpts } = opts;
    const found = await inspectImage(buf, { ...inspectOpts, judgeTags: !!keepReal });
    if (!found) return { buffer: buf, found: 0, erased: [], kept: 0, topFold: null, model: visionModel(), checked: false };
    let targets = found.tags;
    if (keepReal) {
      // 또렷한 태그는 큰 것부터 원본 개수만큼 살리고, 나머지(뭉개진 것·늘어난 것)를 지운다
      const area = (b: PxBox) => (b.x1 - b.x0) * (b.y1 - b.y0);
      const good = found.tags.filter((t) => t.legible).sort((a, b) => area(b) - area(a));
      const keep = new Set(keepReal.max == null ? good : good.slice(0, keepReal.max));
      targets = found.tags.filter((t) => !keep.has(t));
    }
    const er = targets.length ? await eraseBoxes(buf, targets) : { buffer: buf, erased: [] as PxBox[] };
    return {
      buffer: er.buffer, found: found.tags.length, erased: er.erased, kept: found.tags.length - targets.length, topFold: found.topFold,
      ...(found.usage ? { usage: found.usage } : {}), model: found.model, checked: true,
    };
  } catch (e) {
    // 검사·지우기 실패로 생성물을 버리지 않는다
    console.warn('[logo-guard] 결과 검사 실패 — 원본 저장:', (e as Error).message);
    return { buffer: buf, found: 0, erased: [], kept: 0, topFold: null, model: visionModel(), checked: false };
  }
}

/** 같은 프로세스 안에서 같은 사진을 두 번 검사하지 않는다 (동시 요청 포함) */
const memo = new Map<string, Promise<string>>();

/**
 * 참조 사진 URL → 태그를 지운 사본 URL (없으면 원래 URL).
 * 결과는 logo_scans 에 남긴다 — 태그가 없던 사진도 "검사함"으로 기록해 다음부터 비전 호출을 안 한다.
 * 검사가 실패하면 기록하지 않고 원래 URL 로 진행한다 (다음 요청에서 다시 시도).
 * 지운 사본은 매번 새 이름으로 올린다 — 같은 이름을 HEAD 로 확인해 재사용하면 올리다 만 파일을 집을 수 있다.
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
      let erased: PxBox[] = [];
      if (found.tags.length) {
        const er = await eraseBoxes(raw, found.tags);
        erased = er.erased;
        if (erased.length) cleanUrl = await uploadBuffer(SUBPATH, `${id}_${Date.now().toString(36)}.jpg`, er.buffer);
      }
      await col.updateOne(
        { _id: id as never },
        {
          $set: {
            url, cleanUrl, tags: found.tags, erased, skipped: found.tags.length - erased.length,
            model: found.model, ...(found.usage ? { usage: found.usage } : {}), checkedAt: new Date(),
          },
        },
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

/**
 * 참조 사진에 태그가 몇 개 있었는가 — 드롭박스 실촬영본의 진짜 태그 수 (결과물에서 "늘어난 태그" 를 가르는 기준).
 * scrubReferenceUrl 과 같은 logo_scans 기록을 쓴다. 기록이 없으면 한 번 검사해 남긴다
 * (지운 사본도 같이 생기지만, 같은 사진을 다른 역할로 쓸 때 재사용된다). 모르면 null.
 */
export async function referenceTagCount(url: string): Promise<number | null> {
  const id = `${createHash('sha1').update(url).digest('hex').slice(0, 20)}_${VERSION}`;
  try {
    const col = (await getDb()).collection(SCANS);
    let hit = await col.findOne({ _id: id as never });
    if (!hit) {
      await scrubReferenceUrl(url);
      hit = await col.findOne({ _id: id as never });
    }
    return hit && Array.isArray(hit.tags) ? hit.tags.length : null;
  } catch {
    return null;
  }
}
