import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { generateImage, loadReference, GeminiError, type GenAspect } from '@/lib/gemini';
import { uploadBuffer, dailySubpath, ftpConfigured } from '@/lib/ftp';
import { cropToSize } from '@/lib/image-post';
import { planAspect } from '@/lib/aspect';
import { fitToSize, applyPatches, type FitSpec } from '@/lib/design-fit';
import type { DesignLayer } from '@/lib/design-render';

/**
 * 포토샵 방식 편집기의 AI 도구 — 나노바나나(gemini) 호출.
 *
 *   merge     이미지 레이어를 배경에 "찍은 것처럼" 자연 합성 (조명·그림자·가장자리)
 *   erase     표시한 사각 영역의 개체를 지우고 배경 복원
 *   outpaint  장면을 캔버스 규격까지 자연스럽게 연장 (여백 채우기)
 *
 * 셋 다 결과가 새 배경 이미지가 된다: 생성 → 규격으로 크롭 → FTP 업로드 → URL 반환.
 * 편집기는 그 URL 로 배경을 갈아끼우고 (변형은 초기화), 쓰인 레이어를 지운다.
 * 비용: 나노바나나 1장 — 앱의 기존 생성과 같은 실측 단가(₩230~314 수준)가 든다.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * 원본 픽셀 보존 합성 (paste-back).
 *
 * 생성 모델은 "나머지는 그대로 둬"라고 해도 전체를 다시 그려서, 아웃페인트 한 번에
 * 모델 얼굴까지 미묘하게 바뀐다 (사용자 실측). 그래서 AI 결과를 통째로 쓰지 않고 —
 * AI 손이 필요한 영역만 부드러운 경계(feather)로 떼어 원본 위에 얹는다.
 * 영역 밖(얼굴 포함)은 원본 픽셀이 그대로라 구조적으로 변할 수 없다.
 *
 * base 위에 top 을 rect 영역만(가장자리 feather px 만큼 서서히) 올린다.
 */
async function pasteRegion(
  base: Buffer, top: Buffer, W: number, H: number,
  rect: { left: number; top: number; width: number; height: number },
  feather: number,
): Promise<Buffer> {
  const l = Math.max(0, Math.round(rect.left));
  const t = Math.max(0, Math.round(rect.top));
  const w = Math.min(W - l, Math.round(rect.width));
  const h = Math.min(H - t, Math.round(rect.height));
  if (w <= 2 || h <= 2) return base;
  const f = Math.max(1, Math.round(feather));
  // 흰 사각형(안쪽으로 feather 만큼 물러난)을 블러 → 알파 마스크
  const inner = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
    + `<rect x="${l + f}" y="${t + f}" width="${Math.max(1, w - 2 * f)}" height="${Math.max(1, h - 2 * f)}" fill="#fff"/></svg>`;
  const mask = await sharp(Buffer.from(inner)).blur(f / 2).ensureAlpha().toColourspace('b-w').png().toBuffer();
  const cut = await sharp(top).ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png().toBuffer();
  return sharp(base).composite([{ input: cut, left: 0, top: 0 }]).jpeg({ quality: 95 }).toBuffer();
}

interface Body {
  op: 'merge' | 'erase' | 'outpaint';
  imageUrl: string;
  size: { w: number; h: number };
  fit: FitSpec;
  layers?: DesignLayer[];                    // blurpatch 를 미리 굽기 위해
  /** merge: 얹을 이미지, erase: 지울 영역 (0~1 비율, 중심 기준) */
  overlay?: { src?: string; x: number; y: number; w: number; h: number; srcAspect?: number };
  /** 추가 지시 (선택) */
  note?: string;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    if (!ftpConfigured()) {
      return NextResponse.json({ ok: false, error: 'FTP 설정이 없습니다 (.env.local).' }, { status: 500 });
    }
    const W = Math.round(body.size?.w || 0), H = Math.round(body.size?.h || 0);
    if (!body.imageUrl || W < 64 || H < 64) {
      return NextResponse.json({ ok: false, error: '배경과 규격이 필요합니다.' }, { status: 400 });
    }

    // 지금 화면에 보이는 상태(변형·보정·블러패치까지)를 기준으로 작업한다 — WYSIWYG
    const srcRes = await fetch(body.imageUrl, { cache: 'no-store' });
    if (!srcRes.ok) return NextResponse.json({ ok: false, error: `배경을 못 불러왔습니다 (${srcRes.status})` }, { status: 400 });
    const raw = Buffer.from(await srcRes.arrayBuffer());
    let canvas = await fitToSize(raw, W, H, body.fit ?? { mode: 'cover', fx: 0.5, fy: 0.5 });
    canvas = await applyPatches(canvas, W, H, body.layers ?? []);

    const aspect = planAspect(W, H).genAspect as GenAspect;
    const refs = [] as NonNullable<Awaited<ReturnType<typeof loadReference>>>[];
    let prompt = '';
    /** 원본 보존 합성 계획 — mode 'region': AI 결과에서 rect 만 취함 / 'keep': rect 의 원본을 AI 결과 위에 되붙임 */
    let paste: { mode: 'region' | 'keep'; rect: { left: number; top: number; width: number; height: number } } | null = null;
    const featherPx = Math.max(8, Math.round(Math.min(W, H) * 0.025));
    const padPx = Math.max(12, Math.round(Math.min(W, H) * 0.06));

    if (body.op === 'merge') {
      const o = body.overlay;
      if (!o?.src) return NextResponse.json({ ok: false, error: '얹을 이미지 레이어가 필요합니다.' }, { status: 400 });
      // 편집기에서 놓인 위치·크기 그대로 임시 합성본을 만든다 — 모델이 "여기에 이걸" 을 눈으로 보게
      const ow = Math.max(8, Math.round(o.w * W));
      const oh = Math.max(8, Math.round(o.srcAspect ? (o.w * W) / o.srcAspect : o.h * H));
      const oRes = await fetch(o.src, { cache: 'no-store' });
      if (!oRes.ok) return NextResponse.json({ ok: false, error: '이미지 레이어를 못 불러왔습니다.' }, { status: 400 });
      const oBuf = await sharp(Buffer.from(await oRes.arrayBuffer())).resize(ow, oh, { fit: 'fill' }).png().toBuffer();
      const left = Math.round(o.x * W - ow / 2), top = Math.round(o.y * H - oh / 2);
      const pasted = await sharp(canvas).composite([{ input: oBuf, left, top }]).jpeg({ quality: 95 }).toBuffer();

      const r1 = await loadReference(`data:image/jpeg;base64,${pasted.toString('base64')}`, 1600);
      if (r1) refs.push(r1);
      // 기준점 고정: 오버레이 주변(여유 padPx)만 AI 결과를 쓰고, 나머지는 원본 픽셀 그대로
      paste = { mode: 'region', rect: { left: left - padPx, top: top - padPx, width: ow + padPx * 2, height: oh + padPx * 2 } };
      prompt =
        'The image is a photograph with an object roughly PASTED on top (hard edges, mismatched lighting). ' +
        'Re-render it as ONE naturally taken photograph: keep the pasted object exactly where it is and what it is, ' +
        'but integrate it — match the scene\'s lighting direction, colour temperature and grain; add correct contact ' +
        'shadows and soft edges; bend/settle it naturally against surfaces it touches. Do not move, resize or restyle ' +
        'anything else in the scene. Same framing, same background, photorealistic. ' +
        'ABSOLUTELY NO added text or watermarks.' + (body.note ? ` Additional direction: ${body.note}` : '');
    } else if (body.op === 'erase') {
      const o = body.overlay;
      if (!o) return NextResponse.json({ ok: false, error: '지울 영역이 필요합니다.' }, { status: 400 });
      const ow = Math.max(8, Math.round(o.w * W)), oh = Math.max(8, Math.round(o.h * H));
      const left = Math.round(o.x * W - ow / 2), top = Math.round(o.y * H - oh / 2);
      // 반투명 빨간 박스로 영역을 표시한 사본을 두 번째 참조로
      const marker = await sharp({
        create: { width: ow, height: oh, channels: 4, background: { r: 255, g: 0, b: 60, alpha: 0.45 } },
      }).png().toBuffer();
      const marked = await sharp(canvas).composite([{ input: marker, left, top }]).jpeg({ quality: 95 }).toBuffer();
      const r1 = await loadReference(`data:image/jpeg;base64,${canvas.toString('base64')}`, 1600);
      const r2 = await loadReference(`data:image/jpeg;base64,${marked.toString('base64')}`, 1600);
      if (r1) refs.push(r1);
      if (r2) refs.push(r2);
      paste = { mode: 'region', rect: { left: left - padPx, top: top - padPx, width: ow + padPx * 2, height: oh + padPx * 2 } };
      prompt =
        'The FIRST image is a photograph. The SECOND image is the same photograph with a translucent RED RECTANGLE ' +
        'marking an area. REMOVE the object(s) inside that marked area completely and reconstruct what is behind them — ' +
        'floor, wall, furniture surfaces, lighting and shadows all continuous with the surroundings. ' +
        'Output the FIRST image, unchanged everywhere else, with the marked object gone and NO red rectangle. ' +
        'Same framing, photorealistic, no added text.' + (body.note ? ` Additional direction: ${body.note}` : '');
    } else {
      /*
       * outpaint — 결정론적 가이드 방식.
       * 원본을 현재 fit 위치 그대로 두고 가장자리를 흐린 사본으로 채운 가이드를 보낸다.
       * 모델은 "흐린 띠만 다시 그려라"를 눈으로 보고, 우리는 원본이 앉은 자리를 정확히
       * 알기 때문에 결과 위에 그 자리(기준점)를 원본 픽셀로 되붙일 수 있다.
       */
      const meta = await sharp(raw).metadata();
      const sw = meta.width ?? W, sh = meta.height ?? H;
      const zoomRaw = body.fit?.zoom ?? 1;
      const mode = body.fit?.mode ?? 'cover';
      const zoom = mode === 'cover' ? Math.max(1, zoomRaw) : Math.max(0.15, Math.min(4, zoomRaw));
      const baseK = mode === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
      const zx = Math.max(0.15, Math.min(4, body.fit?.zoomX ?? 1));
      const zy = Math.max(0.15, Math.min(4, body.fit?.zoomY ?? 1));
      const fgW = Math.round(sw * baseK * zoom * zx);
      const fgH = Math.round(sh * baseK * zoom * zy);
      const ofx = Math.max(0, Math.min(1, body.fit?.fx ?? 0.5));
      const ofy = Math.max(0, Math.min(1, body.fit?.fy ?? 0.5));
      const oLeft = Math.round(ofx * (W - fgW));
      const oTop = Math.round(ofy * (H - fgH));

      const guide = await applyPatches(
        await fitToSize(raw, W, H, { ...(body.fit ?? { fx: 0.5, fy: 0.5 }), mode: 'blur' }),
        W, H, body.layers ?? [],
      );
      const r1 = await loadReference(`data:image/jpeg;base64,${guide.toString('base64')}`, 1600);
      if (r1) refs.push(r1);
      // 원본이 앉은 자리는 되붙인다 — 얼굴·제품이 있는 기준점은 픽셀 그대로 보존
      paste = { mode: 'keep', rect: { left: oLeft, top: oTop, width: fgW, height: fgH } };
      prompt =
        'The image is a photograph whose BLURRED BORDER BANDS are placeholders. The sharp central photograph is the ' +
        'ANCHOR — keep it EXACTLY as it is, pixel for pixel: same people, faces, products, lighting and framing. ' +
        'Repaint ONLY the blurred bands, continuing the scene naturally beyond the sharp photo\'s edges — walls, ' +
        'floor, ceiling, furniture and light flowing outward with correct perspective, no repetition artifacts. ' +
        'FILL THE ENTIRE FRAME edge to edge; no blur left, no borders. Photorealistic, no added text or watermark.' +
        (body.note ? ` Additional direction: ${body.note}` : '');
    }

    if (!refs.length) return NextResponse.json({ ok: false, error: '참조 이미지를 준비하지 못했습니다.' }, { status: 500 });

    const gen = await generateImage({ prompt, references: refs, aspect, tier: 'pro' });
    const cropped = await cropToSize(gen.buffer, W, H);
    let out = cropped.buffer;

    /*
     * 기준점 고정 합성 — AI 재추첨으로부터 원본을 지킨다.
     *   region: AI 결과에서 작업 영역만 떼어 원본(canvas) 위에 얹는다 (지우개·합성)
     *   keep  : AI 결과 위에 원본이 앉은 자리를 되붙인다 (아웃페인트)
     * 어느 쪽이든 영역 밖 얼굴·제품은 원본 픽셀 그대로다.
     */
    if (paste) {
      out = paste.mode === 'region'
        ? await pasteRegion(canvas, out, W, H, paste.rect, featherPx)
        : await pasteRegion(out, canvas, W, H, {
            left: paste.rect.left + 2, top: paste.rect.top + 2,
            width: paste.rect.width - 4, height: paste.rect.height - 4,
          }, featherPx);
    }

    const iso = new Date().toISOString();
    const fn = `aibg_${iso.replace(/[-:T]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 7)}.jpg`;
    const url = await uploadBuffer(dailySubpath(iso), fn, out);

    return NextResponse.json({ ok: true, url, width: W, height: H });
  } catch (e) {
    const err = e as GeminiError;
    return NextResponse.json(
      { ok: false, error: err.message, blockReason: err.blockReason ?? null },
      { status: err.status && err.status >= 400 ? 502 : 500 },
    );
  }
}
