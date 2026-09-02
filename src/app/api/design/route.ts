import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { getDb, COLLECTIONS } from '@/lib/db';
import { uploadBuffer, dailySubpath, ftpConfigured } from '@/lib/ftp';
import { renderLayersToSvg, textEm, type DesignDoc, type DesignLayer } from '@/lib/design-render';
import { shapeOf, findSize, type BannerShape } from '@/lib/banner-sizes';

/**
 * 배너 디자인 생성 — 이미지 위에 텍스트를 얹어 완성본을 만든다.
 *
 * 왜 필요한가:
 *   생성 모델은 글자를 그림으로 그려서 반드시 뭉갠다 (로고 태그에서 확인).
 *   글자는 실제 폰트로 찍어야 한다. 그래서 이미지 생성과 텍스트 합성을 나눈다.
 *
 * 순서가 중요하다: **규격 → 배경 맞추기 → 배치**.
 * 배너는 걸릴 자리가 먼저 정해지는 물건이라, 1920x600 웹 배너와 1080x1920
 * 스토리는 같은 문구라도 배치가 달라야 한다.
 *
 * 화면에서는 같은 SVG 를 미리 그리고, 저장할 때 여기서 다시 그린다.
 * 두 렌더러가 같은 숫자(0~1 비율)를 읽기 때문에 화면에서 본 그대로 저장된다.
 *
 * GET                        저장된 내 템플릿 목록
 * POST { auto }              규격을 보고 1차 배치를 잡아준다
 * POST { design, save }      렌더 → 미리보기(base64) 또는 FTP 저장 + 갤러리 등록
 * PUT  { name, design }      템플릿으로 저장
 * DELETE { id }              템플릿 삭제
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 배경 컷을 배너 규격에 맞춘다.
 *
 * 컷은 대개 1:1 로 생성되는데 배너는 1920x600 처럼 납작하거나 1080x1920 처럼
 * 길쭉하다. 그냥 늘리면 사람이 찌그러지므로 둘 중 하나를 골라야 한다.
 *
 *   cover  꽉 채우고 넘치는 부분을 잘라낸다. fx/fy 로 어디를 남길지 정한다.
 *          (0.5/0.5 = 가운데. 인물이 아래쪽이면 fy 를 올린다)
 *   blur   자기 자신을 흐리게 깐 위에 통째로 얹는다. 하나도 잘리지 않지만
 *          좌우에 흐린 띠가 생긴다 — 세로 컷을 가로 배너에 쓸 때 쓸 만하다.
 *
 * 화면 미리보기는 CSS object-fit/object-position 으로 같은 계산을 한다.
 */
async function fitToSize(
  buf: Buffer, W: number, H: number,
  fit: { mode: 'cover' | 'blur'; fx: number; fy: number },
): Promise<Buffer> {
  const meta = await sharp(buf).metadata();
  const sw = meta.width ?? W;
  const sh = meta.height ?? H;

  if (fit.mode === 'blur') {
    // 흐린 배경은 잘라서 채우고, 그 위에 원본을 통째로 얹는다
    const bg = await sharp(buf).resize(W, H, { fit: 'cover' })
      .blur(Math.max(8, Math.round(Math.min(W, H) / 22)))
      .modulate({ brightness: 0.82 }).toBuffer();
    const fg = await sharp(buf).resize(W, H, { fit: 'inside' }).toBuffer();
    const fm = await sharp(fg).metadata();
    return sharp(bg).composite([{
      input: fg,
      left: Math.round((W - (fm.width ?? W)) / 2),
      top: Math.round((H - (fm.height ?? H)) / 2),
    }]).jpeg({ quality: 95 }).toBuffer();
  }

  // cover — 배율을 맞춘 뒤 fx/fy 위치에서 잘라낸다
  const k = Math.max(W / sw, H / sh);
  const rw = Math.max(W, Math.round(sw * k));
  const rh = Math.max(H, Math.round(sh * k));
  const resized = await sharp(buf).resize(rw, rh).toBuffer();
  return sharp(resized).extract({
    left: Math.round((rw - W) * Math.max(0, Math.min(1, fit.fx))),
    top: Math.round((rh - H) * Math.max(0, Math.min(1, fit.fy))),
    width: W, height: H,
  }).jpeg({ quality: 95 }).toBuffer();
}

/**
 * 배경의 '어디가 비었나'를 잰다.
 *
 * 32x32 로 줄여서 후보 영역의 밝기(mean)와 복잡도(sd)를 본다.
 * 복잡도는 표준편차 — 하늘·벽처럼 고른 면은 낮고, 인물·소품이 있으면 높다.
 * 낮은 곳에 글자를 놓아야 인물 위에 안 겹친다.
 */
async function analyzeRegions(buf: Buffer) {
  const { data, info } = await sharp(buf).removeAlpha().resize(32, 32, { fit: 'fill' })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => data[y * info.width + x];
  const stat = (x0: number, y0: number, x1: number, y1: number) => {
    const v: number[] = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) v.push(at(x, y));
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
    return { mean, sd };
  };
  return {
    top: stat(0, 0, 32, 11),
    bottom: stat(0, 21, 32, 32),
    left: stat(0, 4, 14, 28),
    right: stat(18, 4, 32, 28),
  };
}

/**
 * 1차 배치를 잡는다.
 *
 * 규격의 비율에 따라 완전히 다른 배치를 쓴다:
 *   wide   가로로 길다 → 문구를 한쪽 옆에 세운다. 위아래로 쌓으면 눌린다.
 *   tall   세로로 길다 → 위나 아래에 크게 쌓고 반대쪽 끝에 버튼을 둔다.
 *   square 정사각     → 비어 있는 위/아래에 쌓는다.
 *
 * 글자 크기는 '원하는 비율'과 '캔버스를 안 뚫는 최대치' 중 작은 쪽을 쓴다.
 * 긴 제목이 알아서 줄어들기 때문에 쓰는 사람이 크기를 만질 일이 줄어든다.
 *
 * 글자 외곽 그림자는 기본으로 끈다. 자사몰 배너는 판판한 글씨가 깔끔하고,
 * 읽히게 만드는 일은 그늘(scrim)이 맡는다 — 배경이 복잡할수록 그늘이 짙어진다.
 * 그래도 묻히면 4단계에서 레이어별로 켤 수 있다.
 */
function buildAuto(
  shape: BannerShape,
  reg: Awaited<ReturnType<typeof analyzeRegions>>,
  W: number, H: number,
  txt: { eyebrow: string; title: string; subtitle: string; cta: string },
  content?: number,
) {
  const S = Math.min(W, H);
  /** 원하는 크기와 폭 제한 중 작은 쪽. 반환값은 짧은 변 대비 비율 */
  const fitText = (str: string, want: number, availFrac: number) =>
    Math.min(want, (availFrac * W) / (textEm(str) * S));

  const layers: DesignLayer[] = [];
  let where: string;
  let light: boolean;
  let sd: number;

  if (shape === 'wide') {
    // 비어 있는 쪽에 문구를 세운다
    const side = reg.left.sd <= reg.right.sd ? 'left' : 'right';
    const r = side === 'left' ? reg.left : reg.right;
    where = side === 'left' ? '왼쪽' : '오른쪽';
    light = r.mean > 140;
    sd = r.sd;
    /*
     * 글자가 시작하는 자리. 본문 폭이 정해진 규격(1910 안의 1300)이면
     * 캔버스 끝이 아니라 본문 왼쪽 모서리에 맞춘다 — 그래야 페이지의
     * 다른 요소와 줄이 맞는다. 본문 폭이 없으면 캔버스 기준 6%.
     */
    const marginX = content && content < W ? (W - content) / 2 / W : 0.06;
    const colFrac = content && content < W ? (content * 0.55) / W : 0.42;
    const x = side === 'left' ? marginX : 1 - marginX;
    const align = side === 'left' ? ('start' as const) : ('end' as const);
    const strong = light ? '#1b1d21' : '#ffffff';
    const soft = light ? '#4a4f57' : '#e9e6e1';

    layers.push({
      id: 'auto-scrim', kind: 'scrim', x: 0.5, y: 0.5, w: 1, h: 1,
      color: light ? '#ffffff' : '#000000',
      opacity: Math.max(0.22, Math.min(0.66, r.sd / 80)),
      direction: side,
    });

    // 눈썹 문구가 있으면 제목을 아래로 내려 네 줄로 쌓는다
    const hasEye = !!txt.eyebrow;
    const ty = hasEye ? 0.43 : 0.36;
    if (hasEye) layers.push({
      id: 'auto-eyebrow', kind: 'text', x, y: 0.26, text: txt.eyebrow,
      size: fitText(txt.eyebrow, 0.055, colFrac), weight: 600, tracking: 0.01,
      lineHeight: 1.25, align, color: strong, opacity: 1, shadow: false, curve: 0,
    });
    if (txt.title) layers.push({
      id: 'auto-title', kind: 'text', x, y: ty, text: txt.title,
      size: fitText(txt.title, hasEye ? 0.135 : 0.155, colFrac), weight: 800, tracking: -0.015,
      lineHeight: 1.15, align, color: strong,
      opacity: 1, shadow: false, curve: 0,
    });
    if (txt.subtitle) layers.push({
      id: 'auto-sub', kind: 'text', x, y: hasEye ? 0.60 : 0.56, text: txt.subtitle,
      size: fitText(txt.subtitle, hasEye ? 0.048 : 0.058, colFrac), weight: 500, tracking: 0.03,
      lineHeight: 1.3, align, color: soft,
      opacity: 1, shadow: false, curve: 0,
    });
    if (txt.cta) {
      const cs = fitText(txt.cta, hasEye ? 0.046 : 0.055, colFrac * 0.8);
      // 화살표 자리까지 세어서 알약 폭을 잡는다
      const pw = ((textEm(txt.cta) + 3.2) * cs * S) / W;
      const px = side === 'left' ? marginX + pw / 2 : 1 - marginX - pw / 2;
      const cy = 0.78;
      const on = light ? '#ffffff' : '#1b1d21';
      layers.push({
        id: 'auto-pill', kind: 'rect', x: px, y: cy, w: pw, h: (cs * S * 2.4) / H,
        color: light ? '#2f3a5c' : '#ffffff', opacity: 0.95, radius: 0.06,
      });
      layers.push({
        id: 'auto-cta', kind: 'text', x: px - (cs * S * 0.6) / W, y: cy, text: txt.cta, size: cs,
        weight: 600, tracking: 0.01, align: 'middle',
        color: on, opacity: 1, shadow: false, curve: 0,
      });
      layers.push({
        id: 'auto-cta-arrow', kind: 'icon', x: px + pw / 2 - (cs * S * 0.9) / W, y: cy,
        icon: 'arrow', size: cs * 0.95, stroke: 0.13, color: on, opacity: 1,
      });
    }
  } else {
    // 정사각·세로형 — 비어 있는 위/아래에 쌓는다
    const topSide = reg.top.sd <= reg.bottom.sd;
    const r = topSide ? reg.top : reg.bottom;
    where = topSide ? '위쪽' : '아래쪽';
    light = r.mean > 140;
    sd = r.sd;
    const big = shape === 'tall';                       // 세로형은 더 크게 — 멀리서 본다
    const gap = big ? 0.055 : 0.085;
    const hasEye = !!txt.eyebrow;
    // 눈썹 문구가 붙으면 한 줄이 더 늘어나므로 제목을 그만큼 아래로 민다
    const base = topSide ? (big ? 0.14 : 0.16) : (big ? 0.80 : 0.84);
    const y0 = hasEye ? base + gap * 0.7 : base;
    const strong = light ? '#1b1d21' : '#ffffff';
    const soft = light ? '#4a4f57' : '#e9e6e1';

    layers.push({
      id: 'auto-scrim', kind: 'scrim', x: 0.5, y: topSide ? base + 0.02 : base - 0.02,
      w: 1, h: big ? 0.30 : 0.40, color: light ? '#ffffff' : '#000000',
      opacity: Math.max(0.18, Math.min(0.62, r.sd / 90)),
      direction: topSide ? 'top' : 'bottom',
    });
    if (hasEye) layers.push({
      id: 'auto-eyebrow', kind: 'text', x: 0.5, y: y0 - gap * 0.72, text: txt.eyebrow,
      size: fitText(txt.eyebrow, big ? 0.036 : 0.030, 0.82), weight: 600, tracking: 0.02,
      lineHeight: 1.25, align: 'middle', color: strong, opacity: 1, shadow: false, curve: 0,
    });
    if (txt.title) layers.push({
      id: 'auto-title', kind: 'text', x: 0.5, y: y0, text: txt.title,
      size: fitText(txt.title, big ? 0.105 : 0.085, 0.86), weight: 800, tracking: -0.01,
      lineHeight: 1.2, align: 'middle', color: strong,
      opacity: 1, shadow: false, curve: 0,
    });
    if (txt.subtitle) layers.push({
      id: 'auto-sub', kind: 'text', x: 0.5, y: y0 + gap, text: txt.subtitle,
      size: fitText(txt.subtitle, big ? 0.038 : 0.032, 0.82), weight: 500, tracking: 0.04,
      lineHeight: 1.3, align: 'middle', color: soft,
      opacity: 1, shadow: false, curve: 0,
    });
    if (txt.cta) {
      const cs = fitText(txt.cta, big ? 0.036 : 0.032, 0.7);
      // 화살표 자리까지 세어서 알약 폭을 잡는다 (가로형과 같은 규칙)
      const pw = Math.min(0.9, ((textEm(txt.cta) + 3.2) * cs * S) / W);
      const cy = topSide ? (big ? 0.9 : 0.88) : (big ? 0.10 : 0.12);
      const on = light ? '#ffffff' : '#1b1d21';
      layers.push({
        id: 'auto-pill', kind: 'rect', x: 0.5, y: cy, w: pw,
        h: (cs * S * 2.4) / H, color: light ? '#2f3a5c' : '#ffffff', opacity: 0.95, radius: 0.06,
      });
      layers.push({
        id: 'auto-cta', kind: 'text', x: 0.5 - (cs * S * 0.6) / W, y: cy, text: txt.cta, size: cs,
        weight: 600, tracking: 0.01, align: 'middle',
        color: on, opacity: 1, shadow: false, curve: 0,
      });
      layers.push({
        id: 'auto-cta-arrow', kind: 'icon', x: 0.5 + pw / 2 - (cs * S * 0.9) / W, y: cy,
        icon: 'arrow', size: cs * 0.95, stroke: 0.13, color: on, opacity: 1,
      });
    }
  }

  return { layers, picked: { where, light, sd: Math.round(sd), shape } };
}

/** 배경 컷을 받아 규격에 맞춘 버퍼와 최종 크기를 돌려준다 */
async function prepareBase(design: Pick<DesignDoc, 'imageUrl' | 'size' | 'fit'>) {
  const res = await fetch(design.imageUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`배경 이미지를 못 받았습니다 (HTTP ${res.status})`);
  // Buffer<ArrayBufferLike> — sharp 가 돌려주는 것을 다시 담아야 해서 기본 제네릭으로 둔다
  let buf: Buffer = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(buf).metadata();
  const srcW = meta.width ?? 1000;
  const srcH = meta.height ?? 1000;

  const W = design.size?.w ?? srcW;
  const H = design.size?.h ?? srcH;
  if (W !== srcW || H !== srcH) {
    buf = await fitToSize(buf, W, H, design.fit ?? { mode: 'cover', fx: 0.5, fy: 0.5 });
  }
  return { buf, W, H, srcW, srcH };
}

export async function GET() {
  try {
    const db = await getDb();
    const docs = await db.collection(COLLECTIONS.designTemplates)
      .find({}).sort({ updatedAt: -1 }).limit(100).toArray();
    return NextResponse.json({
      ok: true,
      templates: docs.map((d) => ({
        id: String(d._id), name: d.name, design: d.design,
        updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      design?: DesignDoc; save?: boolean; title?: string;
      auto?: {
        imageUrl: string; eyebrow?: string; title: string; subtitle?: string; cta?: string;
        size?: { id?: string; w: number; h: number };
        fit?: { mode: 'cover' | 'blur'; fx: number; fy: number };
      };
    };

    // ── 1차 배치 ──
    if (body.auto?.imageUrl) {
      const { buf, W, H, srcW, srcH } = await prepareBase(body.auto);
      const reg = await analyzeRegions(buf);            // 규격에 맞춘 뒤의 그림을 본다
      // 본문 폭은 규격표에서 가져온다 — 글자 왼쪽 줄을 페이지 본문에 맞추기 위해서다
      const content = body.auto.size?.id ? findSize(body.auto.size.id).content : undefined;
      const out = buildAuto(shapeOf(W, H), reg, W, H, {
        eyebrow: (body.auto.eyebrow ?? '').trim(),
        title: (body.auto.title ?? '').trim(),
        subtitle: (body.auto.subtitle ?? '').trim(),
        cta: (body.auto.cta ?? '').trim(),
      }, content);
      return NextResponse.json({
        ok: true, ...out, size: { w: W, h: H }, source: { w: srcW, h: srcH },
      });
    }

    const design = body.design;
    if (!design?.imageUrl) {
      return NextResponse.json({ ok: false, error: '배경 이미지가 필요합니다.' }, { status: 400 });
    }

    const { buf, W, H } = await prepareBase(design);
    // 화면과 같은 숫자로 SVG 를 만들어 겹친다
    const svg = renderLayersToSvg(design, W, H);
    const out = await sharp(buf)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 94 })
      .toBuffer();

    if (!body.save) {
      return NextResponse.json({
        ok: true, preview: `data:image/jpeg;base64,${out.toString('base64')}`, width: W, height: H,
      });
    }

    if (!ftpConfigured()) {
      return NextResponse.json({ ok: false, error: 'FTP 설정이 없습니다 (.env.local).' }, { status: 500 });
    }
    const iso = new Date().toISOString();
    const stamp = iso.replace(/[-:T]/g, '').slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 7);
    const url = await uploadBuffer(dailySubpath(iso), `design_${stamp}_${rand}.jpg`, out);

    const db = await getDb();
    const now = new Date(iso);
    const title = String(body.title || design.layers.find((l) => l.text)?.text || '디자인').slice(0, 120);
    const ins = await db.collection(COLLECTIONS.cuts).insertOne({
      line: '', colorKey: '', colorName: '', hex: '',
      url, title,
      spec: `배너 · ${design.size?.id ?? '원본 크기'} · ${W}×${H}`,
      recipe: { talentCodes: [] },
      source: 'imgcreate' as const,
      promptMode: 'manual',
      aiModel: 'design-composer',
      provider: 'design',
      sizeValue: `${W}x${H}`, sizeLabel: '배너 디자인', aspect: `${W}:${H}`,
      // 어떤 컷 위에 얹었는지 남긴다 — 나중에 원본을 되찾을 수 있어야 한다
      inputImages: [{ kind: 'base' as const, title: '배경 컷', url: design.imageUrl, role: 'base' }],
      direction: '', width: W, height: H,
      deltaE: null, measuredHex: null, note: '',
      design,                                   // 그대로 다시 열어 편집할 수 있게 통째로 남긴다
      hidden: false, createdAt: now, updatedAt: now,
    });

    return NextResponse.json({ ok: true, url, id: String(ins.insertedId), width: W, height: H });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as { id?: string; name?: string; design?: DesignDoc };
    const name = String(body.name || '').trim();
    if (!name || !body.design) {
      return NextResponse.json({ ok: false, error: '이름과 디자인이 필요합니다.' }, { status: 400 });
    }
    const db = await getDb();
    const col = db.collection(COLLECTIONS.designTemplates);
    const now = new Date();
    // 템플릿은 배경 없이 배치만 저장한다 — 다른 컷에도 얹을 수 있어야 한다
    const design = { ...body.design, imageUrl: '' };
    if (body.id) {
      const { ObjectId } = await import('mongodb');
      await col.updateOne({ _id: new ObjectId(body.id) as never }, { $set: { name, design, updatedAt: now } });
      return NextResponse.json({ ok: true, id: body.id });
    }
    const ins = await col.insertOne({ name, design, createdAt: now, updatedAt: now });
    return NextResponse.json({ ok: true, id: String(ins.insertedId) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { id } = (await req.json()) as { id?: string };
    if (!id) return NextResponse.json({ ok: false, error: 'id 가 필요합니다.' }, { status: 400 });
    const { ObjectId } = await import('mongodb');
    const db = await getDb();
    await db.collection(COLLECTIONS.designTemplates).deleteOne({ _id: new ObjectId(id) as never });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
