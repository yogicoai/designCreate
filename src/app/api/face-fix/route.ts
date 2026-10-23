import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { ObjectId } from 'mongodb';
import { getDb, COLLECTIONS } from '@/lib/db';
import { generateImage, loadReference, shrinkReference, costFromUsage, GeminiError, type InlineImage, type TokenUsage } from '@/lib/gemini';
import { checkFaces, type FaceVerdict } from '@/lib/face-guard';
import { visionModel } from '@/lib/logo-guard';
import { uploadBuffer, dailySubpath, ftpConfigured, sanitizeFilename } from '@/lib/ftp';

/**
 * POST /api/face-fix { cutId, codes? } — 「얼굴 다시 그리기」 (사용자 결정 2026-10-21).
 *
 * 2인 컷·와이드 컷에서 전속 모델 얼굴이 딴사람으로 흐르는 건 프롬프트로 못 막는다(10/13~10/20 109장 실측: 2인 컷 20%, 1인 3%).
 * 그래서 다 만든 컷에서 얼굴만 고친다:
 *   ① 생성 때 남긴 머리 위치(qc.face.verdicts[].headBox, 0~1000)로 머리 주변을 정사각형으로 잘라 1024px 로 키우고
 *   ② 비전으로 그 안의 얼굴 피부(눈썹~턱) 자리를 찾아 그 부분만 흐린 뒤
 *   ③ 그 모델의 대표컷·얼굴 각도 조각·표정컷과 함께 나노바나나에 "흐린 자리에 이 사람 얼굴을" 맡기고
 *   ④ 결과를 원래 크기로 줄여 바깥 띠의 색을 원본에 맞춘 뒤, 얼굴 부분만 부드럽게 원본 위에 얹는다
 *      — 머리카락 윤곽·옆 사람·제품·배경은 원본 픽셀 그대로라 머리 크기가 바뀔 수 없다.
 * 원본은 건드리지 않고 새 컷으로 저장한다(editedFrom 로 계보만 남김). 모델 한 명당 나노바나나 1회 + 얼굴 찾기 1회 + 결과 얼굴 대조 1회.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const USAGE_KEY = 'gemini-image';
const KR: Record<string, string> = { W: '여성', M: '남성', K: '아동' };
/** 생성 때 참조 제목에 쓰는 이름 — 「대표컷 1 · 여성 B」 */
const labelOf = (code: string) => `${KR[code[0]] ?? ''} ${code.slice(2)}`.trim();

interface Body { cutId: string; codes?: string[] }
interface TalentDoc { code: string; rep?: string; identityEn?: string; sheets?: { face?: string }; faceCrops?: Record<string, string> }
interface RefEntry { kind?: string; title?: string; url?: string }
type Box = [number, number, number, number];

/*
 * 2026-10-21 첫 실제 실행(10/20 2인 컷, ₩477)에서 배운 두 가지:
 *   ① 여성 B 가 웃던 얼굴에서 무표정으로 바뀌었다 — 대표컷이 무표정이라 표정까지 베꼈다. 표정은 FIRST 의 것이라고 못박는다.
 *   ② 머리색(붉은색)은 그대로였다 — 긴 머리는 붙이는 타원 밖까지 내려와서 색을 바꾸면 위아래가 갈린다.
 *      그래서 머리색과 머리 모양은 FIRST 그대로 두게 한다. 머리색까지 흐른 컷은 이 기능이 아니라 다시 생성으로 고친다.
 *   ③ 남성 A 는 붕 뜬 머리가 차분한 웨이브로 바뀌며 머리 윤곽이 줄어 몸에 비해 머리가 작아 보였다(사용자: "머리가 크게 나오거나
 *      작게 나오거나 하는 부분이 발생해 버린다"). 그림 전체를 키우거나 민 것은 아니었다(타원 안 배경·어깨가 배율 1.00·이동 0 으로 맞음).
 *      그래서 머리 크기와 머리숱 윤곽은 FIRST 그대로 못박고, 그 윤곽 안의 얼굴만 바꾼다 — 머리 비율은 원본에서 바뀌지 않는다.
 */
/*
 *   ④ 2차(11:03, ₩456)는 "다 지켜라" 를 세게 걸어 머리 크기·표정은 지켰지만 남성 A 얼굴이 거의 안 바뀌었다
 *      (사용자: "남자 모델이 변형이 안 되었네"). 원본 얼굴이 FIRST 에 또렷이 보이면 모델은 그 얼굴을 지킨다.
 *      그래서 얼굴 안쪽(눈썹~턱)만 흐려서 보내 이목구비를 참조로 새로 짓게 한다 — 흐린 얼굴에도 고개 방향·시선·얼굴 크기·
 *      조명·입 모양 같은 큰 모양은 남는다. 붙일 때도 얼굴 부분만 붙여 머리카락 윤곽은 원본 픽셀 그대로다(머리 크기 불변).
 *      표정은 생성 때 쓴 표정컷(같은 사람)을 마지막 참조로 준다 — 흐린 얼굴만으로는 미소가 흐려질 수 있다.
 */
const promptFor = (identityEn: string, hasExpression: boolean) =>
  'FIRST image: a close crop of a finished lifestyle photo. The FACE of the person in the centre has been deliberately BLURRED. ' +
  `The next images are identity references of ONE registered model (${identityEn})` +
  (hasExpression ? '; the LAST image is the same model showing the expression to use.\n' : '.\n') +
  'Task: paint a sharp, photographic face into the blurred area — unmistakably the person in the identity references: ' +
  'face shape, jawline, eye shape and colour, eyebrows, nose, lips, skin tone and skin marks. ' +
  'Use the blurred face only for the head angle, the gaze direction, the size and position of the face and the lighting; ' +
  'the new face must fill exactly the blurred area at the same size, so the head does not get bigger or smaller.\n' +
  (hasExpression
    ? 'Expression: the expression of the LAST image (same mouth shape and smile), turned to the head angle of the FIRST image.\n'
    : 'Expression: keep the expression the blurred face suggests (smile or neutral mouth).\n') +
  'Everything outside the blurred face — the hair (outline, volume, colour), ears, neck, clothing, other people, furniture and background — ' +
  'must stay exactly as it is, pixel for pixel. Do not move, zoom, crop or reframe. ' +
  'Output one photo with the same framing as the FIRST image. ABSOLUTELY NO added text, letters, logos or watermarks.';

/**
 * 판(1024) 안에서 가운데 사람의 얼굴 피부(눈썹~턱) 상자 — 0~1000. 못 찾으면 null(머리 상자로 어림한다).
 * 옆을 보는 얼굴(10/20 남성 A)은 머리 상자 가운데가 귀·뒷머리라 머리 상자로 흐리면 얼굴이 아니라 머리카락이 흐려진다.
 */
async function findFace(board: Buffer): Promise<Box | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${visionModel()}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: board.toString('base64') } },
            {
              text: 'Find the FACE of the person whose head is closest to the centre of this image. ' +
                'Return the tight box of the face skin only — from the eyebrows to the chin, and from the far visible edge of the face to the tip of the nose — ' +
                'excluding hair, ears and neck. Coordinates are [ymin, xmin, ymax, xmax] normalised to 0-1000. ' +
                'Return JSON only: {"face_box":[0,0,0,0]}, or {"face_box":null} if no face is visible.',
            },
          ],
        }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const raw = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    const b = (JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as { face_box?: unknown }).face_box;
    if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => Number.isFinite(Number(v)))) return null;
    const box = b.map((v) => Math.max(0, Math.min(1000, Math.round(Number(v))))) as Box;
    // 너무 작거나 뒤집힌 상자는 믿지 않는다
    if (box[2] - box[0] < 60 || box[3] - box[1] < 40) return null;
    return box;
  } catch {
    return null;
  }
}

/** 시험용 가짜 생성 — 개발 서버에서 머리글 x-fake-ai: 1 일 때만. 붙인 자리가 눈에 띄게 색을 돌린다(비용 0) */
async function fakeGenerate(board: Buffer) {
  return { buffer: await sharp(board).modulate({ hue: 120, saturation: 1.5 }).jpeg({ quality: 92 }).toBuffer(), usage: undefined, model: 'fake' };
}

/** 머리 상자(0~1000) → 원본 위 정사각형 자르기 창. 머리가 창 위쪽에 오도록 아래로 조금 내린다(턱·목까지 들어가게) */
function cropWindow(box: Box, W: number, H: number) {
  const [y0, x0, y1, x1] = box;
  const hy = ((y1 - y0) / 1000) * H;
  const hx = ((x1 - x0) / 1000) * W;
  const head = Math.max(hy, hx);
  const side = Math.round(Math.min(Math.min(W, H), Math.max(256, head * 2.2)));
  const cx = ((x0 + x1) / 2000) * W;
  const cy = ((y0 + y1) / 2000) * H + hy * 0.12;
  const left = Math.round(Math.min(Math.max(0, cx - side / 2), W - side));
  const top = Math.round(Math.min(Math.max(0, cy - side / 2), H - side));
  // 창 안에서 머리 타원 — 머리카락 옆과 귀 아래 머리카락까지 덮도록 상자보다 넉넉하게, 아래로 조금 내린다
  // (머리색까지 흐른 컷을 고칠 때 윗머리만 바뀌면 아랫머리와 색이 갈린다 — 10/20 여성 B 붉은 머리 컷)
  const ex = ((x0 + x1) / 2000) * W - left;
  const ey = ((y0 + y1) / 2000) * H - top;
  // head = 창 안 머리 상자 가운데·크기. 얼굴 위치를 못 찾았을 때 어림하는 데 쓴다
  return { left, top, side, head: { cx: ex, cy: ey, hx, hy } };
}

type Ellipse = { cx: number; cy: number; rx: number; ry: number };

/** 타원 알파(한 채널, 가장자리 흐림 sigma) — 창 테두리는 반드시 0 이라 원본과 이음매가 안 생긴다 */
async function ellipseMask(side: number, e: Ellipse, sigma = Math.max(2, side * 0.035)): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}"><rect width="${side}" height="${side}" fill="#000"/>` +
    `<ellipse cx="${e.cx.toFixed(1)}" cy="${e.cy.toFixed(1)}" rx="${e.rx.toFixed(1)}" ry="${e.ry.toFixed(1)}" fill="#fff"/></svg>`;
  // sharp: 흐림 뒤 채널이 3개가 된다 — 한 채널만 뽑는다 (2026-10-14 포토샵 AI 에서 겪은 함정)
  const a = await sharp(Buffer.from(svg)).blur(sigma).extractChannel(0).raw().toBuffer();
  // 타원이 창 끝에 닿아도 테두리에서는 0 으로 — 창 가장자리 6% 에서 서서히 줄인다
  const ramp = Math.max(4, Math.round(side * 0.06));
  for (let y = 0; y < side; y++) {
    const fy = Math.min(1, Math.min(y, side - 1 - y) / ramp);
    for (let x = 0; x < side; x++) {
      const f = Math.min(fy, Math.min(1, Math.min(x, side - 1 - x) / ramp));
      if (f < 1) a[y * side + x] = Math.round(a[y * side + x] * f);
    }
  }
  return a;
}

/** 생성 결과의 색을 원본에 맞춘다 — 얼굴 밖(알파가 낮은 곳)은 원래 같아야 하는 자리라 그곳 평균 차이만큼 옮긴다 */
function matchTone(gen: Buffer, orig: Buffer, alpha: Buffer) {
  const sum = [0, 0, 0, 0, 0, 0];
  let n = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] > 12) continue;
    for (let c = 0; c < 3; c++) { sum[c] += gen[i * 3 + c]; sum[3 + c] += orig[i * 3 + c]; }
    n++;
  }
  if (n < 100) return gen;
  const d = [0, 1, 2].map((c) => Math.max(-25, Math.min(25, (sum[3 + c] - sum[c]) / n)));
  const out = Buffer.from(gen);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(out[i] + d[i % 3])));
  return out;
}

const addUsage = (a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined =>
  !b ? a : !a ? b : {
    promptTokens: a.promptTokens + b.promptTokens, imageTokens: a.imageTokens + b.imageTokens,
    thoughtTokens: a.thoughtTokens + b.thoughtTokens, totalTokens: a.totalTokens + b.totalTokens,
  };

export async function POST(req: Request) {
  try {
    const fake = process.env.NODE_ENV === 'development' && req.headers.get('x-fake-ai') === '1';
    if (!ftpConfigured()) return NextResponse.json({ ok: false, error: 'FTP 설정이 없습니다 (.env.local).' }, { status: 500 });
    const body = (await req.json()) as Body;
    if (!body.cutId || !ObjectId.isValid(body.cutId)) return NextResponse.json({ ok: false, error: '컷을 지정하세요.' }, { status: 400 });

    const db = await getDb();
    const cuts = db.collection(COLLECTIONS.cuts);
    const src = await cuts.findOne({ _id: new ObjectId(body.cutId) });
    if (!src?.url) return NextResponse.json({ ok: false, error: '컷을 찾을 수 없습니다.' }, { status: 404 });

    const codesInCut: string[] = src.recipe?.talentCodes ?? [];
    const talents = (await db.collection('talents').find({ code: { $in: codesInCut } }).toArray()) as unknown as TalentDoc[];
    const faceRefsFor = (codes: string[]) => codes
      .map((code) => talents.find((t) => t.code === code))
      .filter((t): t is TalentDoc => !!t && !!(t.sheets?.face || t.rep))
      .map((t) => ({ code: t.code, faceUrl: String(t.sheets?.face || t.rep), who: (t.identityEn ?? '').slice(0, 220) }));

    // cafe24 는 가끔 연결 단계에서 끊긴다(2026-10-21 실측: 10초 만에 "fetch failed") — 세 번까지 다시 받는다
    let raw: Buffer | null = null;
    let why = '';
    for (let i = 0; i < 3 && !raw; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1500 * i));
      try {
        const res = await fetch(src.url, { cache: 'no-store' });
        if (res.ok) raw = Buffer.from(await res.arrayBuffer());
        else why = `HTTP ${res.status}`;
      } catch (e) {
        why = (e as Error).message;
      }
    }
    if (!raw) return NextResponse.json({ ok: false, error: `원본 그림을 회사 서버에서 받지 못했습니다 (${why}) — 잠시 뒤 다시 눌러 주세요.` }, { status: 502 });
    let image: Buffer = await sharp(raw).rotate().jpeg({ quality: 97 }).toBuffer();
    const meta = await sharp(image).metadata();
    const W = meta.width ?? 0, H = meta.height ?? 0;
    if (!W || !H) return NextResponse.json({ ok: false, error: '원본 그림을 읽지 못했습니다.' }, { status: 500 });

    // 머리 위치 — 생성 때 남긴 기록. 10/2 이전 컷처럼 기록이 없으면 얼굴 대조를 한 번 돌려 찾는다(비전 1회)
    let verdicts: FaceVerdict[] = src.qc?.face?.verdicts ?? [];
    if (!verdicts.some((v) => v.headBox) && codesInCut.length) {
      verdicts = (await checkFaces(image, faceRefsFor(codesInCut), codesInCut.length)).verdicts;
    }
    const want = body.codes?.length ? body.codes : codesInCut;
    const targets = verdicts.filter((v) => want.includes(v.code) && v.headBox && v.verdict !== 'noFace');
    if (!targets.length) {
      return NextResponse.json({ ok: false, error: '다시 그릴 얼굴을 찾지 못했습니다 — 전속 모델 얼굴이 보이는 컷에서만 쓸 수 있습니다(뒷모습·가린 얼굴 제외).' }, { status: 400 });
    }

    // 앱 월 한도 — 생성과 같은 카운터를 쓴다 (모델 한 명 = 1회)
    const usageCol = db.collection(COLLECTIONS.apiUsage);
    const usageDoc = await usageCol.findOne({ _id: USAGE_KEY as never });
    const cap = usageDoc?.limit ?? (Number(process.env.GEMINI_USAGE_LIMIT) || 300);
    if (!fake && (usageDoc?.count ?? 0) + targets.length > cap) {
      return NextResponse.json({ ok: false, error: `생성 한도 초과 — ${usageDoc?.count ?? 0}/${cap} 장 사용됨. 관리자가 한도를 늘려야 합니다.` }, { status: 429 });
    }

    let usage: TokenUsage | undefined;
    let model = '';
    const done: { code: string; box: Box; window: { left: number; top: number; side: number }; face: Box | null }[] = [];
    for (const v of targets) {
      const t = talents.find((x) => x.code === v.code);
      if (!t) continue;
      const win = cropWindow(v.headBox as Box, W, H);
      const { left, top, side } = win;
      const origRgb = await sharp(image).extract({ left, top, width: side, height: side }).removeAlpha().raw().toBuffer();
      const board = await sharp(origRgb, { raw: { width: side, height: side, channels: 3 } })
        .resize(1024, 1024, { kernel: 'lanczos3' }).jpeg({ quality: 94 }).toBuffer();

      // 얼굴 피부 상자(판 0~1000) — 가짜 시험에서도 찾는다(비전 텍스트 응답 1회, 사실상 0원 — 옆얼굴 위치를 봐야 해서)
      const fb = await findFace(board);
      const k = side / 1000;
      const face: Ellipse = fb
        ? { cx: ((fb[1] + fb[3]) / 2) * k, cy: ((fb[0] + fb[2]) / 2) * k, rx: ((fb[3] - fb[1]) / 2) * k, ry: ((fb[2] - fb[0]) / 2) * k }
        : { cx: win.head.cx, cy: win.head.cy + win.head.hy * 0.08, rx: win.head.hx * 0.3, ry: win.head.hy * 0.33 };

      // 보내는 판: 얼굴 안쪽만 흐린다 — 이목구비 디테일은 지우고 방향·크기·조명·입 모양 같은 큰 모양만 남긴다
      const bk = 1024 / side;
      const blurSigma = Math.max(6, Math.min(face.rx, face.ry) * bk * 0.14);
      const boardRaw = await sharp(board).removeAlpha().raw().toBuffer();
      const blurRaw = await sharp(board).blur(blurSigma).removeAlpha().raw().toBuffer();
      const blurA = await ellipseMask(1024, { cx: face.cx * bk, cy: face.cy * bk, rx: face.rx * bk * 1.12, ry: face.ry * bk * 1.12 }, 1024 * 0.012);
      const mixed = Buffer.alloc(boardRaw.length);
      for (let i = 0; i < blurA.length; i++) {
        const a = blurA[i] / 255;
        for (let c = 0; c < 3; c++) mixed[i * 3 + c] = Math.round(boardRaw[i * 3 + c] * (1 - a) + blurRaw[i * 3 + c] * a);
      }
      const blurredBoard = await sharp(mixed, { raw: { width: 1024, height: 1024, channels: 3 } }).jpeg({ quality: 94 }).toBuffer();

      // 참조 — 생성 때 이 사람에게 쓴 대표컷·얼굴 각도 조각 + 표정컷(마지막, 같은 사람의 그 표정)
      const mine = ((src.inputImages ?? []) as RefEntry[])
        .filter((r) => r.kind === 'talent' && r.url && (r.title ?? '').includes(labelOf(v.code)));
      const used = mine.filter((r) => /^(대표컷|얼굴 각도)/.test(r.title ?? '')).map((r) => r.url as string);
      const exprUrl = mine.find((r) => /^표정컷/.test(r.title ?? ''))?.url;
      const urls = [...new Set(used.length ? used : [t.rep, t.faceCrops?.front].filter((u): u is string => !!u))].slice(0, 3);
      const refs: InlineImage[] = [await shrinkReference(blurredBoard, 1024, 92)];
      for (const u of urls) { const r = await loadReference(u, 1024); if (r) refs.push(r); }
      if (refs.length < 2) return NextResponse.json({ ok: false, error: `${labelOf(v.code)} 의 얼굴 참조를 불러오지 못했습니다.` }, { status: 500 });
      const expr = exprUrl ? await loadReference(exprUrl, 1024) : null;
      if (expr) refs.push(expr);

      const gen = fake
        ? await fakeGenerate(blurredBoard)
        : await generateImage({ prompt: promptFor(t.identityEn ?? '', !!expr), references: refs, aspect: '1:1', size: '1K', tier: 'pro' });
      usage = addUsage(usage, gen.usage);
      model = gen.model;

      // 붙이는 자리: 얼굴 부분만(흐린 자리보다 조금 넓게) — 머리카락 윤곽은 원본 픽셀 그대로라 머리 크기가 바뀔 수 없다
      const alpha = await ellipseMask(side, { cx: face.cx, cy: face.cy, rx: face.rx * 1.3, ry: face.ry * 1.25 }, Math.max(2, side * 0.02));
      const genRgb = matchTone(await sharp(gen.buffer).resize(side, side, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().raw().toBuffer(), origRgb, alpha);
      // RGB 를 먼저 만들고 알파를 붙인다 — removeAlpha 와 joinChannel 을 한 줄에 쓰면 붙인 알파가 빠진다
      const patch = await sharp(genRgb, { raw: { width: side, height: side, channels: 3 } })
        .joinChannel(alpha, { raw: { width: side, height: side, channels: 1 } }).png().toBuffer();
      image = await sharp(image).composite([{ input: patch, left, top }]).jpeg({ quality: 97 }).toBuffer();
      done.push({ code: v.code, box: v.headBox as Box, window: { left, top, side }, face: fb });
    }
    if (!done.length) return NextResponse.json({ ok: false, error: '다시 그릴 모델 정보를 찾지 못했습니다.' }, { status: 400 });

    const out = await sharp(image).jpeg({ quality: 94 }).toBuffer();
    // 가짜 시험은 대조를 건너뛴다(비용 0) — 판정은 원본 것을 그대로 둔다.
    // 대조가 한 번 실패하면(2026-10-21 2차 시험: 결과가 비어 옴 — 참조를 cafe24 에서 받다 끊긴 것으로 보임) 한 번 더 한다
    const people = Math.max(codesInCut.length, verdicts.length);
    let face = fake ? { checked: false, verdicts, usage: undefined } : await checkFaces(out, faceRefsFor(codesInCut), people);
    if (!fake && !face.checked) face = await checkFaces(out, faceRefsFor(codesInCut), people);

    const iso = new Date().toISOString();
    const stamp = iso.replace(/[-:T]/g, '').slice(0, 14);
    const base = sanitizeFilename(String(src.url).split('/').pop()!.replace(/\.[a-z]+$/i, '')).slice(0, 80);
    const url = await uploadBuffer(dailySubpath(iso), `${base}_facefix_${stamp}_${Math.random().toString(36).slice(2, 7)}.jpg`, out);

    const cost = costFromUsage(usage);
    const now = new Date(iso);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, url: _u, createdAt: _c, updatedAt: _up, cost: _co, tokenUsage: _t, elapsedMs: _e, requestBytes: _r, ...keep } = src;
    const ins = await cuts.insertOne({
      ...keep,
      url,
      title: [src.title, '얼굴 다시 그리기'].filter(Boolean).join(' · '),
      provider: 'gemini',
      aiModel: `${model || 'gemini'} · face-fix`,
      origin: 'face-fix',
      // 원본은 그대로 두고 계보만 남긴다 (inputImages 에 넣으면 원본 삭제를 막는 "쓰임" 으로 센다)
      editedFrom: String(src._id),
      editedFromUrl: src.url,
      faceFix: { codes: done.map((d) => d.code), windows: done, at: now },
      qc: { ...(src.qc ?? {}), face: { checked: face.checked, verdicts: face.verdicts, ...(face.usage ? { usage: face.usage } : {}) } },
      ...(usage ? { tokenUsage: usage, cost } : {}),
      width: W,
      height: H,
      // 가짜 시험 결과는 갤러리에 안 보이게 숨겨 둔다
      hidden: fake,
      createdAt: now,
      updatedAt: now,
    });
    if (!fake) await usageCol.updateOne({ _id: USAGE_KEY as never }, { $inc: { count: done.length } }, { upsert: true });

    return NextResponse.json({
      ok: true,
      id: String(ins.insertedId),
      url,
      width: W,
      height: H,
      codes: done.map((d) => d.code),
      cost,
      before: verdicts.filter((v) => done.some((d) => d.code === v.code)).map((v) => ({ code: v.code, verdict: v.verdict, score: v.score })),
      qc: { face: { checked: face.checked, verdicts: face.verdicts } },
      fake,
    });
  } catch (e) {
    const err = e as GeminiError;
    return NextResponse.json({ ok: false, error: err.message || String(e) }, { status: err.status && err.status >= 400 ? err.status : 500 });
  }
}
