import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { uploadBuffer, deleteRemote, REF_SUBPATH, ftpConfigured } from '@/lib/ftp';
import { getDb } from '@/lib/db';
import { normalizeRefCategory } from '@/lib/queries';

/**
 * POST /api/upload — MD 가 올린 레퍼런스 이미지를 cafe24 FTP 로 올리고 공개 URL 을 돌려준다.
 *
 * multipart/form-data: file, (선택) title, (선택) category, (선택) sub(모델명),
 *                       (선택) register='0' 이면 레퍼런스 보관함에 안 넣는다
 * 저장 위치: /web/design/update/
 *
 * ⚠️ Vercel 은 요청 본문을 4.5MB 로 제한한다. 클라이언트에서 미리 줄여 보내지만,
 *    서버에서도 한 번 더 방어한다(직접 호출·구형 브라우저 대비).
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

export async function POST(req: Request) {
  try {
    if (!ftpConfigured()) {
      return NextResponse.json({ ok: false, error: 'FTP 설정이 없습니다 (.env.local).' }, { status: 500 });
    }

    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: '파일이 없습니다.' }, { status: 400 });
    }
    if (file.type && !ALLOWED.includes(file.type)) {
      return NextResponse.json({ ok: false, error: `지원하지 않는 형식입니다: ${file.type}` }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { ok: false, error: `파일이 너무 큽니다 (${(file.size / 1024 / 1024).toFixed(1)}MB). 4MB 이하로 줄여주세요.` },
        { status: 413 },
      );
    }

    const raw = Buffer.from(await file.arrayBuffer());

    // 레퍼런스는 스타일 참고용이라 원본 해상도가 필요 없다.
    // 2048px JPEG 로 정규화 — FTP 용량도 줄고, 생성 시 참조로 넣을 때도 가볍다.
    let buf: Buffer;
    let ext = 'jpg';
    try {
      buf = await sharp(raw).rotate().resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
    } catch {
      buf = raw; // 디코드 실패(특이 포맷) — 원본 그대로 올린다
      ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    }

    const meta = await sharp(buf).metadata().catch(() => ({ width: 0, height: 0 }));

    // 파일명은 ASCII 로 강제된다(cafe24 403 회피). 원본 한글 이름은 title 로 DB 에 남는다.
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 8);
    const url = await uploadBuffer(REF_SUBPATH, `ref_${stamp}_${rand}.${ext}`, buf);

    const title = String(form?.get('title') || file.name || '레퍼런스').slice(0, 120);
    // 분류 — 내용 기준 3종(shoot/banner/sns)으로 정규화. 구 값이 와도 흡수한다.
    const category = normalizeRefCategory(String(form?.get('category') || ''));
    /*
     * 하위 분류. 모델 레퍼런스면 전속 모델 이름('여성B')이 들어간다 —
     * 전속 모델 화면에서 바로 올릴 때 여기까지 붙여야 다시 태깅할 일이 없다.
     */
    const sub = String(form?.get('sub') || '').slice(0, 40);
    // replaceUrl 이 오면 "이미지 교체" — 기존 보관함 항목을 유지한 채 파일만 갈아끼운다
    const replaceUrl = String(form?.get('replaceUrl') || '');

    try {
      const db = await getDb();
      if (replaceUrl) {
        const existing = await db.collection('references').findOne({ url: replaceUrl });
        await db.collection('references').updateOne(
          { url: replaceUrl },
          { $set: {
              url,
              // 교체는 파일만 바꾸는 것 — 사람이 붙인 이름은 유지한다
              title: existing?.title || title,
              width: meta.width ?? 0, height: meta.height ?? 0, bytes: buf.length, active: true,
            },
            $setOnInsert: { createdAt: new Date() } },
          { upsert: true },
        );
        // 옛 파일 정리 — 우리 폴더 것이고 생성 이력이 안 쓰면 지운다
        const base = (process.env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');
        const prefix = `${base}/${REF_SUBPATH}/`;
        if (replaceUrl.startsWith(prefix)) {
          const usedIn = await db.collection('cuts').countDocuments({ 'inputImages.url': replaceUrl });
          const oldName = replaceUrl.slice(prefix.length);
          if (!usedIn && oldName && !oldName.includes('/')) await deleteRemote(REF_SUBPATH, oldName);
        }
      } else if (String(form?.get('register') || '1') !== '0') {
        // 보관함 자동 등록 — 다음 작업에서 재업로드 없이 골라 쓸 수 있게.
        // register=0 은 배너 배경처럼 '스타일 참고'가 아닌 것 — 보관함에 섞이면 안 된다.
        await db.collection('references').updateOne(
          { url },
          { $set: { url, title, category, ...(sub ? { sub } : {}), source: 'upload', width: meta.width ?? 0, height: meta.height ?? 0, bytes: buf.length, active: true },
            $setOnInsert: { createdAt: new Date() } },
          { upsert: true },
        );
      }
    } catch (e) {
      // 등록/교체 기록 실패가 업로드 자체를 실패시키면 안 된다
      console.warn('[upload] 보관함 기록 실패(업로드는 성공):', (e as Error).message);
    }

    return NextResponse.json({
      ok: true,
      url,
      title,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      bytes: buf.length,
      category,
    });
  } catch (e) {
    console.error('[upload]', e);
    return NextResponse.json({ ok: false, error: (e as Error).message || '업로드 실패' }, { status: 500 });
  }
}
