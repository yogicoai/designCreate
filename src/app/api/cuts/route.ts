import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDb, COLLECTIONS } from '@/lib/db';
import { deleteRemote } from '@/lib/ftp';

/**
 * 컷 관리.
 *
 * DELETE { id }                       — 숨김 (갤러리·대시보드에서 제외, 파일·기록 유지)
 * DELETE { id, hard: true[, force] }  — 완전 삭제. 이 앱이 생성한 컷(source=imgcreate)만.
 *   - FTP 파일(/web/design/<날짜>/...)까지 지운다
 *   - 다른 생성 컷의 베이스/입력으로 쓰였으면 409 + usedIn — force 로만 삭제
 *   - 이관(legacy) 컷은 youtube 자산이라 숨김만 허용
 *   - 사용량 카운터는 되돌리지 않는다 (이미 과금된 생성)
 */

export const runtime = 'nodejs';

export async function DELETE(req: Request) {
  try {
    const body = (await req.json()) as { id?: string; hard?: boolean; force?: boolean };
    if (!body.id || !ObjectId.isValid(body.id)) {
      return NextResponse.json({ ok: false, error: '유효한 id 가 필요합니다.' }, { status: 400 });
    }
    const db = await getDb();
    const cuts = db.collection(COLLECTIONS.cuts);
    const _id = new ObjectId(body.id);
    const cut = await cuts.findOne({ _id });
    if (!cut) return NextResponse.json({ ok: false, error: '컷을 찾을 수 없습니다.' }, { status: 404 });

    if (!body.hard) {
      await cuts.updateOne({ _id }, { $set: { hidden: true, updatedAt: new Date() } });
      return NextResponse.json({ ok: true, mode: 'hidden' });
    }

    if (cut.source !== 'imgcreate') {
      return NextResponse.json(
        { ok: false, error: '이관된 기존 컷은 삭제할 수 없습니다 (youtube 자산). 숨김만 가능합니다.' },
        { status: 400 },
      );
    }

    // 다른 생성 컷이 이 컷을 베이스/입력으로 썼으면 기록이 깨진다 — 확인받는다
    const usedIn = await cuts.countDocuments({ _id: { $ne: _id }, 'inputImages.url': cut.url, hidden: { $ne: true } });
    if (usedIn > 0 && !body.force) {
      return NextResponse.json(
        { ok: false, needsForce: true, usedIn, error: `이 컷은 다른 생성 컷 ${usedIn}개의 베이스/입력으로 쓰였습니다. 삭제하면 그 기록의 미리보기가 깨집니다.` },
        { status: 409 },
      );
    }

    // FTP 파일 — 우리 생성 폴더(/web/design/<날짜>/) 것만 지운다
    let fileDeleted = false;
    const base = (process.env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');
    if (base && String(cut.url).startsWith(`${base}/`)) {
      const rel = String(cut.url).slice(base.length + 1); // '2026-08-31/Max_olive_...jpg'
      const slash = rel.lastIndexOf('/');
      const subpath = slash >= 0 ? rel.slice(0, slash) : '';
      const filename = slash >= 0 ? rel.slice(slash + 1) : rel;
      // 레퍼런스 폴더(update/)나 자산 폴더(assets/)는 이 경로로 지우지 않는다
      if (filename && subpath && /^\d{4}-\d{2}-\d{2}$/.test(subpath)) {
        await deleteRemote(subpath, filename);
        fileDeleted = true;
      }
    }

    await cuts.deleteOne({ _id });
    return NextResponse.json({ ok: true, mode: 'deleted', fileDeleted, usedIn });
  } catch (e) {
    console.error('[cuts DELETE]', e);
    return NextResponse.json({ ok: false, error: (e as Error).message || '삭제 실패' }, { status: 500 });
  }
}
