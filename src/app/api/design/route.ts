import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { getDb, COLLECTIONS } from '@/lib/db';
import { uploadBuffer, dailySubpath, ftpConfigured } from '@/lib/ftp';
import { renderLayersToSvg, type DesignDoc } from '@/lib/design-render';

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
    const body = (await req.json()) as { design?: DesignDoc; save?: boolean; title?: string };
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
