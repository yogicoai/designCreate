import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { ObjectId } from 'mongodb';
import { getDb, COLLECTIONS } from '@/lib/db';
import { ftpConfigured, uploadBuffer, dailySubpath } from '@/lib/ftp';
import { planAspect } from '@/lib/aspect';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/image-edit — 「포토샵」(이미지 편집 화면)에서 고친 그림을 생성이미지 갤러리에 새 컷으로 저장한다.
 *
 * multipart/form-data: file (JPEG·PNG), (선택) title, (선택) fromCut = 갤러리에서 불러와 고친 컷의 id
 *
 * 갤러리에서 불러와 고친 것이면 원본 컷의 제품·색·모델 정보를 이어받는다 — 갤러리 필터(라인·색·모델)에 그대로 걸린다.
 * 원본 컷은 건드리지 않는다(새 컷으로 쌓는다). provider='edit' 는 생성이 아니라 편집이라
 * 생성 품질 통계(qc-stats)에서 뺀다 — 배너 디자인(provider='design')과 같은 대우.
 *
 * ⚠️ Vercel 은 요청 본문을 4.5MB 로 제한한다 — 화면에서 4MB 안으로 줄여 보낸다.
 */

const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png'];

export async function POST(req: Request) {
  try {
    if (!ftpConfigured()) {
      return NextResponse.json({ ok: false, error: 'FTP 설정이 없습니다 (.env.local).' }, { status: 500 });
    }
    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: '파일이 없습니다.' }, { status: 400 });
    if (file.type && !ALLOWED.includes(file.type)) {
      return NextResponse.json({ ok: false, error: `지원하지 않는 형식입니다: ${file.type}` }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ ok: false, error: `파일이 너무 큽니다 (${(file.size / 1024 / 1024).toFixed(1)}MB).` }, { status: 413 });
    }

    // 갤러리 컷은 JPEG 다 — 투명한 곳은 흰색으로
    const buf = await sharp(Buffer.from(await file.arrayBuffer())).rotate()
      .flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer();
    const meta = await sharp(buf).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;

    const db = await getDb();
    const cuts = db.collection(COLLECTIONS.cuts);
    const fromId = String(form?.get('fromCut') || '');
    const src = ObjectId.isValid(fromId) ? await cuts.findOne({ _id: new ObjectId(fromId) }) : null;

    const iso = new Date().toISOString();
    const stamp = iso.replace(/[-:T]/g, '').slice(0, 14);
    const url = await uploadBuffer(dailySubpath(iso), `edit_${stamp}_${Math.random().toString(36).slice(2, 7)}.jpg`, buf);

    const fallback = src ? `${String(src.title || src.spec || '컷')} (편집)` : '포토샵 편집';
    const title = String(form?.get('title') || fallback).slice(0, 120);
    const now = new Date(iso);
    const ins = await cuts.insertOne({
      line: src?.line ?? '',
      colorKey: src?.colorKey ?? '',
      colorName: src?.colorName ?? '',
      hex: src?.hex ?? '',
      url,
      title,
      spec: '',
      recipe: src?.recipe ?? { talentCodes: [] },
      source: 'imgcreate',
      provider: 'edit',
      aiModel: 'photocraft',
      origin: 'photo-edit',
      // 갤러리에서 불러와 고친 원본 — 계보만 남긴다(inputImages 에 넣으면 원본 삭제를 막는 "쓰임" 으로 센다)
      editedFrom: src ? String(src._id) : null,
      editedFromUrl: src?.url ?? null,
      prompt: '',
      promptMode: 'manual',
      sizeValue: `${w}x${h}`,
      sizeLabel: '',
      aspect: planAspect(w, h).genAspect,
      inputImages: [],
      width: w,
      height: h,
      note: '포토샵(이미지 편집)에서 고친 그림',
      hidden: false,
      createdAt: now,
      updatedAt: now,
    });
    return NextResponse.json({ ok: true, id: String(ins.insertedId), url, width: w, height: h });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
