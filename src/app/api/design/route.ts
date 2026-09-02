import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { getDb, COLLECTIONS } from '@/lib/db';
import { uploadBuffer, dailySubpath, ftpConfigured } from '@/lib/ftp';
import { renderLayersToSvg, type DesignDoc, type DesignLayer } from '@/lib/design-render';

/**
 * 디자인 생성 — 이미지 위에 텍스트를 얹어 완성본을 만든다.
 *
 * 왜 필요한가:
 *   생성 모델은 글자를 그림으로 그려서 반드시 뭉갠다 (로고 태그에서 확인).
 *   글자는 실제 폰트로 찍어야 한다. 그래서 이미지 생성과 텍스트 합성을 나눈다.
 *
 * 화면에서는 CSS 로 미리 보고, 저장할 때 여기서 SVG 로 다시 그린다.
 * 두 렌더러가 같은 숫자(0~1 비율)를 읽기 때문에 화면에서 본 그대로 저장된다.
 *
 * GET                        저장된 내 템플릿 목록
 * POST { design, save }      렌더 → 미리보기(base64) 또는 FTP 저장 + 갤러리 등록
 * PUT  { name, design }      템플릿으로 저장
 * DELETE { id }              템플릿 삭제
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


/*
 * 자동 배치 — 이 기능의 핵심.
 *
 * 쓰는 사람이 디자이너가 아니다. 슬라이더를 열 개 주는 것보다,
 * 문구만 넣으면 알아서 읽히게 놓아주는 편이 훨씬 쓸모 있다.
 *
 * 하는 일:
 *   1) 배경을 잘게 줄여 후보 영역(위/아래/왼/오른)의 밝기와 '복잡도'를 잰다.
 *   2) 복잡도가 낮은 = 비어 있는 영역을 고른다. 인물·제품 위에 글자를 얹지 않기 위해서다.
 *   3) 그 영역의 밝기로 글자색을 정한다. 밝으면 짙은 글씨, 어두우면 흰 글씨.
 *   4) 대비가 모자라면 같은 색 계열의 그늘(scrim)을 깔아 읽히게 만든다.
 *
 * 복잡도는 표준편차로 잰다 — 하늘·벽처럼 고른 면은 낮고, 인물·소품이 있으면 높다.
 */
async function analyzeRegions(buf: Buffer) {
  // 32x32 로 줄여서 본다. 세부는 필요 없고 '어디가 비었나'만 알면 된다
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
    top:    { ...stat(0, 0, 32, 10),   x: 0.5,  y: 0.15, align: 'middle' as const },
    bottom: { ...stat(0, 22, 32, 32),  x: 0.5,  y: 0.85, align: 'middle' as const },
    left:   { ...stat(0, 6, 13, 26),   x: 0.09, y: 0.45, align: 'start'  as const },
    right:  { ...stat(19, 6, 32, 26),  x: 0.91, y: 0.45, align: 'end'    as const },
  };
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
      auto?: { imageUrl: string; title: string; subtitle?: string; cta?: string };
    };

    // ── 자동 배치 ──
    if (body.auto?.imageUrl) {
      const r0 = await fetch(body.auto.imageUrl, { cache: 'no-store' });
      if (!r0.ok) return NextResponse.json({ ok: false, error: '배경 이미지를 못 받았습니다.' }, { status: 502 });
      const buf = Buffer.from(await r0.arrayBuffer());
      const reg = await analyzeRegions(buf);

      // 가장 비어 있는 곳 = 표준편차가 가장 낮은 곳
      const best = Object.values(reg).sort((a, b) => a.sd - b.sd)[0];
      const light = best.mean > 140;                       // 배경이 밝은가
      const strong = light ? '#1b1d21' : '#ffffff';
      const soft = light ? '#4a4f57' : '#e9e6e1';
      const scrim = light ? '#ffffff' : '#000000';
      // 면이 고르지 않을수록 그늘을 진하게 — 글자가 묻히지 않게
      const scrimOp = Math.max(0.18, Math.min(0.62, best.sd / 90));

      const vertical = best.y < 0.5 ? 'top' : 'bottom';
      const layers: DesignLayer[] = [{
        id: 'auto-scrim', kind: 'scrim',
        x: 0.5, y: vertical === 'top' ? 0.16 : 0.84, w: 1, h: 0.36,
        color: scrim, opacity: scrimOp, direction: vertical,
      }];
      const t = body.auto.title.trim();
      if (t) layers.push({
        id: 'auto-title', kind: 'text', x: best.x, y: best.y, text: t,
        size: t.length > 14 ? 0.055 : 0.082, weight: 800, tracking: -0.01,
        lineHeight: 1.2, align: best.align, color: strong, opacity: 1, shadow: true, curve: 0,
      });
      const sub = (body.auto.subtitle ?? '').trim();
      if (sub) layers.push({
        id: 'auto-sub', kind: 'text', x: best.x, y: best.y + 0.085, text: sub,
        size: 0.030, weight: 500, tracking: 0.04, lineHeight: 1.3,
        align: best.align, color: soft, opacity: 1, shadow: true, curve: 0,
      });
      const cta = (body.auto.cta ?? '').trim();
      if (cta) {
        const cy2 = vertical === 'top' ? 0.9 : 0.12;
        layers.push({ id: 'auto-pill', kind: 'rect', x: 0.5, y: cy2, w: Math.min(0.72, 0.16 + cta.length * 0.034), h: 0.095, color: light ? '#2f3a5c' : '#ffffff', opacity: 0.95, radius: 0.05 });
        layers.push({ id: 'auto-cta', kind: 'text', x: 0.5, y: cy2, text: cta, size: 0.030, weight: 600, tracking: 0.01, align: 'middle', color: light ? '#ffffff' : '#1b1d21', opacity: 1, shadow: false, curve: 0 });
      }
      return NextResponse.json({
        ok: true,
        layers,
        picked: { where: vertical === 'top' ? '위쪽' : '아래쪽', light, sd: Math.round(best.sd) },
      });
    }

    const design = body.design;
    if (!design?.imageUrl) {
      return NextResponse.json({ ok: false, error: '배경 이미지가 필요합니다.' }, { status: 400 });
    }

    // 배경 이미지를 받아온다 (cafe24 공개 URL)
    const res = await fetch(design.imageUrl, { cache: 'no-store' });
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `배경 이미지를 못 받았습니다 (HTTP ${res.status})` }, { status: 502 });
    }
    const base = sharp(Buffer.from(await res.arrayBuffer()));
    const meta = await base.metadata();
    const W = meta.width ?? 1000;
    const H = meta.height ?? 1000;

    // 화면과 같은 숫자로 SVG 를 만들어 겹친다
    const svg = renderLayersToSvg(design, W, H);
    const out = await base
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 94 })
      .toBuffer();

    if (!body.save) {
      // 미리보기 — 저장하지 않고 돌려준다
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
      spec: `디자인 · ${design.templateId ?? '직접'} · ${W}×${H}`,
      recipe: { talentCodes: [] },
      source: 'imgcreate' as const,
      promptMode: 'manual',
      aiModel: 'design-composer',
      provider: 'design',
      sizeValue: `${W}x${H}`, sizeLabel: '디자인 생성', aspect: `${W}:${H}`,
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
