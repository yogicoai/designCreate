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
      prompt =
        'The FIRST image is a photograph. The SECOND image is the same photograph with a translucent RED RECTANGLE ' +
        'marking an area. REMOVE the object(s) inside that marked area completely and reconstruct what is behind them — ' +
        'floor, wall, furniture surfaces, lighting and shadows all continuous with the surroundings. ' +
        'Output the FIRST image, unchanged everywhere else, with the marked object gone and NO red rectangle. ' +
        'Same framing, photorealistic, no added text.' + (body.note ? ` Additional direction: ${body.note}` : '');
    } else {
      // outpaint — 원본을 참조로, 캔버스 비율로 장면을 연장
      const r1 = await loadReference(`data:image/jpeg;base64,${raw.toString('base64')}`, 1600);
      if (r1) refs.push(r1);
      prompt =
        `Extend this photograph naturally to a ${aspect} frame (outpainting). Keep everything in the original exactly ` +
        'as it is — same subject, same perspective, same lighting — and continue the scene seamlessly beyond its ' +
        'original edges: walls, floor, ceiling, furniture and background flow outward without repetition artifacts. ' +
        'FILL THE ENTIRE FRAME edge to edge; no blank bars, no borders. Photorealistic, no added text or watermark.' +
        (body.note ? ` Additional direction: ${body.note}` : '');
    }

    if (!refs.length) return NextResponse.json({ ok: false, error: '참조 이미지를 준비하지 못했습니다.' }, { status: 500 });

    const gen = await generateImage({ prompt, references: refs, aspect, tier: 'pro' });
    const cropped = await cropToSize(gen.buffer, W, H);
    const out = cropped.buffer;

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
