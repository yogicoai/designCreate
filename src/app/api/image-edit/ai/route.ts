import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { generateImage, loadReference, shrinkReference, GeminiError, type GenAspect } from '@/lib/gemini';
import { uploadBuffer, dailySubpath, ftpConfigured } from '@/lib/ftp';
import { planAspect } from '@/lib/aspect';

/**
 * POST /api/image-edit/ai — 「포토샵」 화면의 AI 기능. 포토샵(Firefly) 기능을 같은 이름·같은 쓰임으로 옮겼다
 * (사용자 요청 2026-10-14: "포토샵에서 제공하는 AI 합성 관련된 기능들을 최대한 비슷하게").
 *
 *   fill        생성형 채우기 — 칠한 선택 영역 안에 프롬프트대로 그린다(프롬프트가 없으면 지운다). 참조 이미지를 줄 수 있다
 *   remove      제거 도구    — 칠한 곳의 물건을 지우고 뒤를 채운다
 *   harmonize   조화(합성)   — 얹은 이미지(화면에서 미리 합쳐 보냄)의 조명·색·그림자·가장자리를 장면에 맞춘다
 *   expand      생성형 확장  — 고른 비율의 새 캔버스에서 원본은 고른 자리에 두고 바깥을 이어 그린다
 *   background  배경 생성    — 칠한 피사체는 남기고 나머지 배경을 프롬프트대로 새로 그린다
 *   cutout      배경 제거    — 배경을 투명하게 만든 PNG (AI 가 배경을 한 가지 색으로 칠하게 하고, 그 색을 빼서 투명도를 얻는다)
 *
 * 공통: 결과에서 바꿀 자리만 떼어 원본 위에 얹는다 — 선택 밖(얼굴·제품 포함)은 원본 픽셀 그대로라 바뀔 수 없다
 * (배너 편집기 AI 도구와 같은 원칙). 변형은 1~3장(포토샵처럼 여러 장 중에 고른다) — 장마다 나노바나나 1회.
 * 그림 비율이 생성 비율과 다르면 원본을 생성 비율의 판 가운데에 두고(남는 띠는 흐리게 늘려 채움) 보낸 뒤 원래 자리만 잘라 온다
 * — 생성 결과를 그림 비율로 억지로 자르면 위치가 어긋나 붙인 자리가 밀린다.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

type Op = 'fill' | 'remove' | 'harmonize' | 'expand' | 'background' | 'cutout';
interface Body {
  op: Op;
  /** 지금 그림 — 화면이 2048px 안으로 줄여 /api/upload 로 올린 것 */
  imageUrl: string;
  /** 선택 영역 — data:image/png, 흰색 = 선택(배경 생성은 남길 피사체). 그림과 같은 비율 */
  mask?: string;
  prompt?: string;
  /** 생성형 채우기의 참조 이미지(이 물건을 그려 넣어라) */
  refUrl?: string;
  /** 생성형 확장 — 새 캔버스 비율, 원본을 둘 자리(0~1) */
  ratio?: [number, number];
  anchor?: [number, number];
  /** 변형 장수 1~3 */
  count?: number;
}

const NO_TEXT = ' ABSOLUTELY NO added text, letters, logos, labels or watermarks.';

type Raw = { data: Buffer; W: number; H: number };

// 참조로 보낼 땐 1600px 로 줄인다(요청이 가볍게) — 결과는 판 크기로 다시 키워 맞춘다
const asInline = (buf: Buffer) => shrinkReference(buf, 1600, 88);

async function maskFrom(dataUrl: string, W: number, H: number): Promise<Raw> {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('선택 영역 형식이 올바르지 않습니다.');
  // 화면이 보낸 PNG 는 투명도 채널이 붙어 있다 — 그대로 흑백으로 읽으면 채널이 2개가 되어 선택이 엉뚱하게 거의 전체로 잡혔다(2026-10-14 시험).
  // 한 채널만 뽑아 읽는다.
  const { data, info } = await sharp(Buffer.from(m[1], 'base64')).flatten({ background: '#000000' }).resize(W, H, { fit: 'fill' })
    .extractChannel(0).threshold(128).raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 1 || data.length !== W * H) throw new Error('선택 영역을 읽지 못했습니다.');
  return { data, W, H };
}

// 1채널 raw 를 흐리거나 문턱을 걸면 sharp 가 3채널(sRGB)로 내놓는다 — 결과마다 extractChannel(0) 으로 한 채널만 뽑는다(2026-10-14 시험에서 선택이 엉킨 원인)
const rawSharp = (r: Raw) => sharp(r.data, { raw: { width: r.W, height: r.H, channels: 1 } });

/** 선택을 px 만큼 넓힌다(흐린 뒤 낮은 문턱 — 대략 px 만큼 번진다) */
async function grow(r: Raw, px: number): Promise<Raw> {
  if (px <= 0) return r;
  return { ...r, data: await rawSharp(r).blur(Math.max(0.3, px / 2)).threshold(10).extractChannel(0).raw().toBuffer() };
}
function invert(r: Raw): Raw { return { ...r, data: Buffer.from(r.data.map((v) => 255 - v)) }; }
async function shrink(r: Raw, px: number): Promise<Raw> { return invert(await grow(invert(r), px)); }
async function soften(r: Raw, px: number): Promise<Buffer> {
  return rawSharp(r).blur(Math.max(0.3, px / 2)).extractChannel(0).raw().toBuffer();
}
function anyOn(r: Raw): boolean { for (let i = 0; i < r.data.length; i += 7) if (r.data[i]) return true; return false; }

/** 선택 자리를 반투명 색으로 칠한 사본 — AI 에게 "여기" 를 눈으로 보여 준다 */
async function tinted(base: Buffer, r: Raw, rgb: [number, number, number]): Promise<Buffer> {
  const rgba = Buffer.alloc(r.W * r.H * 4);
  for (let i = 0; i < r.W * r.H; i++) {
    if (!r.data[i]) continue;
    rgba[i * 4] = rgb[0]; rgba[i * 4 + 1] = rgb[1]; rgba[i * 4 + 2] = rgb[2]; rgba[i * 4 + 3] = 120;
  }
  const over = await sharp(rgba, { raw: { width: r.W, height: r.H, channels: 4 } }).png().toBuffer();
  return sharp(base).composite([{ input: over }]).jpeg({ quality: 92 }).toBuffer();
}

/** top 을 alpha(1채널) 모양으로 떼어 base 위에 얹는다 */
async function pasteAlpha(base: Buffer, top: Buffer, alpha: Buffer, W: number, H: number): Promise<Buffer> {
  // removeAlpha() 와 joinChannel() 을 한 줄에 쓰면 sharp 가 투명도 빼기를 나중에 해서 붙인 투명도가 사라진다 — 먼저 3채널로 굳힌다
  const rgb = await sharp(top).resize(W, H, { fit: 'fill' }).flatten({ background: '#ffffff' }).jpeg({ quality: 97 }).toBuffer();
  const cut = await sharp(rgb).joinChannel(alpha, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  return sharp(base).composite([{ input: cut }]).jpeg({ quality: 95 }).toBuffer();
}

/**
 * 생성 비율의 판 — 원본(W×H)을 판(PW×PH)의 anchor 자리에 두고 남는 곳은 원본을 흐리게 늘려 채운다.
 * scale < 1 이면 원본을 그만큼 줄여 둔다(판이 2048px 를 넘지 않게).
 */
async function onBoard(img: Buffer, W: number, H: number, PW: number, PH: number, anchor: [number, number], scale = 1) {
  const w = Math.round(W * scale), h = Math.round(H * scale);
  const left = Math.round(anchor[0] * (PW - w)), top = Math.round(anchor[1] * (PH - h));
  const bg = await sharp(img).resize(PW, PH, { fit: 'fill' }).blur(28).modulate({ brightness: 1.02 }).toBuffer();
  const fg = scale === 1 ? img : await sharp(img).resize(w, h).toBuffer();
  const board = await sharp(bg).composite([{ input: fg, left, top }]).jpeg({ quality: 94 }).toBuffer();
  return { board, left, top, w, h };
}

/** 그림 비율에 가장 가까운 생성 비율과, 그림을 품는 가장 작은 판 */
function boardFor(W: number, H: number) {
  const aspect = planAspect(W, H).genAspect as GenAspect;
  const [aw, ah] = aspect.split(':').map(Number);
  let PW = W, PH = Math.round((W * ah) / aw);
  if (PH < H) { PH = H; PW = Math.round((H * aw) / ah); }
  return { aspect, PW, PH };
}

/** 이미지에 가장 적게 든 색을 배경 제거용 칠 색으로 고른다 — 초록 제품(올리브 맥스 등)을 초록 배경으로 지우면 제품이 같이 빠진다 */
async function pickKey(img: Buffer): Promise<{ rgb: [number, number, number]; name: string }> {
  const keys: { rgb: [number, number, number]; name: string }[] = [
    { rgb: [0, 255, 0], name: 'pure chroma-key green (#00FF00)' },
    { rgb: [255, 0, 255], name: 'pure magenta (#FF00FF)' },
    { rgb: [0, 0, 255], name: 'pure blue (#0000FF)' },
  ];
  const { data, info } = await sharp(img).resize(160, 160, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let best = keys[0], bestHits = Infinity;
  for (const k of keys) {
    let hits = 0;
    for (let i = 0; i < n; i++) {
      const dr = data[i * 3] - k.rgb[0], dg = data[i * 3 + 1] - k.rgb[1], db = data[i * 3 + 2] - k.rgb[2];
      if (dr * dr + dg * dg + db * db < 150 * 150) hits++;
    }
    if (hits < bestHits) { best = k; bestHits = hits; }
  }
  return best;
}

/**
 * 시험용 가짜 생성 — 개발 서버(next dev)에서 머리글 x-fake-ai: 1 을 줄 때만. 비용 없이 선택 처리·되붙이기·투명 PNG·여러 장 흐름을 본다.
 * 받은 판을 흐리고 색을 돌린 그림(배경 제거는 가운데 타원만 남기고 나머지를 칠 색으로)을 돌려준다 — 바뀐 자리가 눈에 띄게.
 */
async function fakeGenerate(board: Buffer, op: Op, key: { rgb: [number, number, number] } | null): Promise<{ buffer: Buffer }> {
  const m = await sharp(board).metadata();
  const w = m.width ?? 64, h = m.height ?? 64;
  if (op === 'cutout' && key) {
    const ell = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><ellipse cx="${w / 2}" cy="${h / 2}" rx="${w * 0.3}" ry="${h * 0.38}" fill="#fff"/></svg>`);
    const inner = await sharp(board).ensureAlpha().composite([{ input: ell, blend: 'dest-in' }]).png().toBuffer();
    const bg = await sharp({ create: { width: w, height: h, channels: 3, background: { r: key.rgb[0], g: key.rgb[1], b: key.rgb[2] } } }).png().toBuffer();
    return { buffer: await sharp(bg).composite([{ input: inner }]).jpeg({ quality: 92 }).toBuffer() };
  }
  return { buffer: await sharp(board).blur(12).modulate({ hue: 140, saturation: 1.6 }).jpeg({ quality: 92 }).toBuffer() };
}

export async function POST(req: Request) {
  try {
    const fake = process.env.NODE_ENV === 'development' && req.headers.get('x-fake-ai') === '1';
    if (!ftpConfigured()) return NextResponse.json({ ok: false, error: 'FTP 설정이 없습니다 (.env.local).' }, { status: 500 });
    const body = (await req.json()) as Body;
    const op = body.op;
    if (!['fill', 'remove', 'harmonize', 'expand', 'background', 'cutout'].includes(op)) {
      return NextResponse.json({ ok: false, error: '알 수 없는 기능입니다.' }, { status: 400 });
    }
    const srcRes = await fetch(body.imageUrl, { cache: 'no-store' });
    if (!srcRes.ok) return NextResponse.json({ ok: false, error: `그림을 못 불러왔습니다 (${srcRes.status})` }, { status: 400 });
    const base = await sharp(Buffer.from(await srcRes.arrayBuffer())).rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 95 }).toBuffer();
    const meta = await sharp(base).metadata();
    const W = meta.width ?? 0, H = meta.height ?? 0;
    if (W < 64 || H < 64) return NextResponse.json({ ok: false, error: '그림이 너무 작습니다.' }, { status: 400 });

    const prompt = String(body.prompt || '').trim().slice(0, 600);
    const count = Math.max(1, Math.min(3, Math.round(Number(body.count) || 1)));
    const minSide = Math.min(W, H);
    const pad = Math.max(10, Math.round(minSide * 0.03));
    const feather = Math.max(6, Math.round(minSide * 0.018));

    let mask: Raw | null = null;
    if (['fill', 'remove', 'harmonize', 'background'].includes(op)) {
      if (!body.mask) return NextResponse.json({ ok: false, error: '선택 영역을 칠해 주세요.' }, { status: 400 });
      mask = await maskFrom(body.mask, W, H);
      if (!anyOn(mask)) return NextResponse.json({ ok: false, error: '선택 영역이 비어 있습니다.' }, { status: 400 });
    }
    if (op === 'background' && !prompt) return NextResponse.json({ ok: false, error: '어떤 배경으로 바꿀지 적어 주세요.' }, { status: 400 });
    if (op === 'expand' && !(Array.isArray(body.ratio) && body.ratio[0] > 0 && body.ratio[1] > 0)) {
      return NextResponse.json({ ok: false, error: '새 비율을 골라 주세요.' }, { status: 400 });
    }

    // ── 판·참조·지시 만들기 ──
    let refs: NonNullable<Awaited<ReturnType<typeof asInline>>>[] = [];
    let text = '';
    let aspect: GenAspect;
    let PW: number, PH: number, left = 0, top = 0, w = W, h = H;
    let key: Awaited<ReturnType<typeof pickKey>> | null = null;

    if (op === 'expand') {
      const [rw, rh] = body.ratio!;
      const anchor: [number, number] = [Math.min(1, Math.max(0, body.anchor?.[0] ?? 0.5)), Math.min(1, Math.max(0, body.anchor?.[1] ?? 0.5))];
      let cw = W, ch = Math.round((W * rh) / rw);
      if (ch < H) { ch = H; cw = Math.round((H * rw) / rh); }
      const s = Math.min(1, 2048 / Math.max(cw, ch));
      PW = Math.round(cw * s); PH = Math.round(ch * s);
      aspect = planAspect(PW, PH).genAspect as GenAspect;
      const b = await onBoard(base, W, H, PW, PH, anchor, s);
      ({ left, top, w, h } = b);
      const r1 = await asInline(b.board);
      if (r1) refs = [r1];
      text = 'The image is a photograph whose BLURRED BORDER BANDS are placeholders. The sharp photograph inside is the ANCHOR — keep it exactly: ' +
        'same people, faces, products, lighting and framing. Repaint ONLY the blurred bands, continuing the scene naturally beyond the sharp photo\'s edges — ' +
        'walls, floor, ceiling, furniture and light flowing outward with correct perspective and no repeated patterns. Fill the entire frame edge to edge; no blur and no borders left.' +
        (prompt ? ` In the new areas: ${prompt}.` : '') + NO_TEXT;
    } else {
      ({ aspect, PW, PH } = boardFor(W, H));
      const b = await onBoard(base, W, H, PW, PH, [0.5, 0.5]);
      ({ left, top } = b);
      const board = b.board;
      const place = async (img: Buffer) => (await onBoard(img, W, H, PW, PH, [0.5, 0.5])).board;
      if (op === 'cutout') {
        key = await pickKey(base);
        const r1 = await asInline(board);
        if (r1) refs = [r1];
        text = `Replace EVERYTHING that is not the main subject (person/people and the product they use or hold) with a perfectly flat, uniform ${key.name} background — ` +
          'no gradient, no texture, no floor, no shadows on the background. Keep the subject exactly as it is, pixel for pixel, including fine edges like hair and fabric. ' +
          'Do not tint the subject with the background colour. Same framing and size.' + NO_TEXT;
      } else {
        const color: Record<string, [number, number, number]> = { fill: [40, 140, 255], remove: [255, 0, 60], harmonize: [0, 220, 230], background: [40, 220, 90] };
        const marked = await place(await tinted(base, mask!, color[op]));
        const r1 = await asInline(board), r2 = await asInline(marked);
        if (r1) refs.push(r1);
        if (r2) refs.push(r2);
        if (op === 'remove' || (op === 'fill' && !prompt)) {
          text = 'The FIRST image is a photograph. The SECOND image is the same photograph with an area painted in translucent colour. ' +
            'REMOVE everything inside the painted area completely and reconstruct what is behind it — floor, wall, furniture surfaces, lighting and shadows all continuous with the surroundings. ' +
            'Output the FIRST image, unchanged everywhere else, with the painted object gone and NO paint left. Same framing, photorealistic.' + NO_TEXT;
        } else if (op === 'fill') {
          let refLine = '';
          if (body.refUrl) {
            const r3 = await loadReference(body.refUrl, 1400);
            if (r3) { refs.push(r3); refLine = ' The THIRD image shows exactly what to place — reproduce that object faithfully (same shape, proportions, colour and details), only adapted to this scene\'s angle and light.'; }
          }
          text = 'The FIRST image is a photograph. The SECOND image is the same photograph with an area painted in translucent BLUE. ' +
            `Inside the painted area only, paint: ${prompt}. Match the photograph's perspective, scale, lighting direction, colour temperature, shadows and grain so it looks naturally photographed together.` +
            refLine + ' Everything outside the painted area stays exactly the same. Output the FIRST image edited, with NO blue paint left. Photorealistic.' + NO_TEXT;
        } else if (op === 'harmonize') {
          text = 'The FIRST image is a photograph with an object PASTED on top; the SECOND image highlights the pasted object\'s area in translucent CYAN. ' +
            'Integrate the pasted object as if it had been photographed in this scene: match the lighting direction, colour temperature, exposure and grain; add correct contact shadows ' +
            'and soft cast shadows; soften hard cut-out edges. It is a real product — do NOT change its shape, proportions, design or colour identity, and do not move or resize it. ' +
            'Everything else stays exactly the same. Output the FIRST image edited with NO cyan left. Photorealistic.' + (prompt ? ` Additional direction: ${prompt}.` : '') + NO_TEXT;
        } else {
          text = 'The FIRST image is a photograph. The SECOND image marks the SUBJECT in translucent GREEN. Keep the subject exactly as it is — same person, face, pose, ' +
            'product shape and colour, same position and size. Replace EVERYTHING else (the background and surroundings) with: ' + prompt + '. ' +
            'Make the new background match the subject in perspective, horizon, lighting direction and colour temperature, with natural contact shadows where the subject meets the floor. ' +
            'Output the FIRST image edited with NO green paint left. Photorealistic.' + NO_TEXT;
        }
      }
    }
    if (!refs.length) return NextResponse.json({ ok: false, error: '참조 이미지를 준비하지 못했습니다.' }, { status: 500 });

    // 붙일 모양(알파) — 결과에서 바꿀 자리만 떼어 원본에 얹는다
    let alpha: Buffer | null = null;
    if (op === 'remove' || op === 'fill') alpha = await soften(await grow(mask!, pad), feather);
    if (op === 'harmonize') alpha = await soften(await grow(mask!, pad * 2), feather);            // 그림자가 번질 자리까지
    if (op === 'background') alpha = await soften(await shrink(mask!, 2), Math.max(3, feather / 2)); // 남길 피사체 — 원본을 얹는다

    const fakeBoard = fake ? Buffer.from(refs[0].data, 'base64') : null;
    const once = async (): Promise<{ url: string; width: number; height: number; type: string }> => {
      const gen = fakeBoard ? await fakeGenerate(fakeBoard, op, key) : await generateImage({ prompt: text, references: refs, aspect, tier: 'pro' });
      const full = await sharp(gen.buffer).resize(PW, PH, { fit: 'fill' }).jpeg({ quality: 95 }).toBuffer();
      const iso = new Date().toISOString();
      const stamp = iso.replace(/[-:T]/g, '').slice(0, 14);
      const name = (ext: string) => `psai_${op}_${stamp}_${Math.random().toString(36).slice(2, 7)}.${ext}`;

      if (op === 'expand') {
        // 원본 자리는 원본 픽셀로 되붙인다(가장자리는 부드럽게)
        const inner = Buffer.alloc(PW * PH);
        const f = Math.max(4, Math.round(feather / 2));
        for (let y = top + f; y < top + h - f; y++) inner.fill(255, y * PW + left + f, y * PW + left + w - f);
        const a = await sharp(inner, { raw: { width: PW, height: PH, channels: 1 } }).blur(Math.max(0.3, f / 2)).extractChannel(0).raw().toBuffer();
        const orig = await sharp({ create: { width: PW, height: PH, channels: 3, background: '#000000' } })
          .composite([{ input: await sharp(base).resize(w, h).toBuffer(), left, top }]).jpeg({ quality: 95 }).toBuffer();
        const out = await pasteAlpha(full, orig, a, PW, PH);
        return { url: await uploadBuffer(dailySubpath(iso), name('jpg'), out), width: PW, height: PH, type: 'image/jpeg' };
      }

      const crop = await sharp(full).extract({ left, top, width: W, height: H }).jpeg({ quality: 95 }).toBuffer();
      if (op === 'cutout') {
        // 칠한 색과 얼마나 먼지로 투명도를 정하고, 색은 원본 픽셀을 쓴다(피사체가 AI 손을 타지 않게)
        const k = key!;
        const ai = await sharp(crop).removeAlpha().raw().toBuffer();
        const a = Buffer.alloc(W * H);
        for (let i = 0; i < W * H; i++) {
          const dr = ai[i * 3] - k.rgb[0], dg = ai[i * 3 + 1] - k.rgb[1], db = ai[i * 3 + 2] - k.rgb[2];
          const d = Math.sqrt(dr * dr + dg * dg + db * db);
          a[i] = Math.max(0, Math.min(255, Math.round(((d - 70) / 110) * 255)));
        }
        const soft = await sharp(a, { raw: { width: W, height: H, channels: 1 } }).blur(0.8).extractChannel(0).raw().toBuffer();
        const png = await sharp(base).joinChannel(soft, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
        return { url: await uploadBuffer(dailySubpath(iso), name('png'), png), width: W, height: H, type: 'image/png' };
      }
      // 배경 생성 = AI 결과 위에 원본 피사체를 얹는다 / 나머지 = 원본 위에 AI 의 선택 자리만 얹는다
      const out = op === 'background' ? await pasteAlpha(crop, base, alpha!, W, H) : await pasteAlpha(base, crop, alpha!, W, H);
      return { url: await uploadBuffer(dailySubpath(iso), name('jpg'), out), width: W, height: H, type: 'image/jpeg' };
    };

    const settled = await Promise.allSettled(Array.from({ length: count }, () => once()));
    const results = settled.filter((s) => s.status === 'fulfilled').map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof once>>>).value);
    const failed = settled.filter((s) => s.status === 'rejected').map((s) => ((s as PromiseRejectedResult).reason as Error)?.message || '실패');
    if (!results.length) return NextResponse.json({ ok: false, error: failed[0] || 'AI 처리 실패' }, { status: 502 });
    return NextResponse.json({ ok: true, results, failed: failed.length });
  } catch (e) {
    const err = e as GeminiError;
    return NextResponse.json({ ok: false, error: err.message, blockReason: err.blockReason ?? null },
      { status: err.status && err.status >= 400 ? 502 : 500 });
  }
}
