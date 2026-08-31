import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { deleteRemote, REF_SUBPATH } from '@/lib/ftp';

/**
 * 레퍼런스 보관함.
 *
 * 업로드(/api/upload)된 레퍼런스는 자동으로 여기 등록된다. eventTemp(디자인 빌더)의
 * 레퍼런스 갤러리에서 가져온 항목도 함께 산다 (source: 'eventtemp').
 *
 * GET    최근 레퍼런스 목록
 * PATCH  { url, title } — 이름 변경
 * DELETE { url }                          — 보관함에서 숨김 (파일 유지)
 * DELETE { url, hard: true[, force] }     — 완전 삭제.
 *   - 생성 컷의 입력 기록(inputImages)에 쓰인 URL 이면 409 + usedIn 을 돌려주고,
 *     force: true 로만 지울 수 있다 (기록의 미리보기가 깨진다는 걸 알고 지우는 것).
 *   - FTP 파일은 우리 업로드 폴더(/web/design/update/)의 것만 지운다.
 *     디자인 빌더 등 다른 시스템 소유 파일은 목록에서만 제거한다.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 우리가 파일까지 지워도 되는 URL 프리픽스 */
function ownedPrefix(): string {
  const base = (process.env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');
  return `${base}/${REF_SUBPATH}/`;
}

export async function GET() {
  try {
    const db = await getDb();
    const docs = await db
      .collection('references')
      .find({ active: { $ne: false } })
      .sort({ createdAt: -1 })
      .limit(300)
      .toArray();
    return NextResponse.json({
      ok: true,
      references: docs.map((d) => ({
        url: d.url,
        title: d.title ?? '',
        width: d.width ?? 0,
        height: d.height ?? 0,
        category: d.category ?? null,
        tags: d.tags ?? [],
        source: d.source ?? 'upload',
        createdAt: d.createdAt ?? null,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as { url?: string; title?: string };
    if (!body.url) return NextResponse.json({ ok: false, error: 'url 이 필요합니다.' }, { status: 400 });
    const db = await getDb();
    await db.collection('references').updateOne(
      { url: body.url },
      { $set: { title: String(body.title ?? '').slice(0, 120) } },
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = (await req.json()) as { url?: string; hard?: boolean; force?: boolean };
    const url = String(body.url || '');
    if (!url) return NextResponse.json({ ok: false, error: 'url 이 필요합니다.' }, { status: 400 });
    const db = await getDb();

    // 기본 = 숨김 (파일 유지)
    if (!body.hard) {
      await db.collection('references').updateOne({ url }, { $set: { active: false } });
      return NextResponse.json({ ok: true, mode: 'hidden' });
    }

    // 완전 삭제 — 생성 이력이 이 URL 을 참조하면 경고
    const usedIn = await db.collection('cuts').countDocuments({ 'inputImages.url': url, hidden: { $ne: true } });
    if (usedIn > 0 && !body.force) {
      return NextResponse.json(
        {
          ok: false,
          needsForce: true,
          usedIn,
          error: `이 레퍼런스는 생성 컷 ${usedIn}개의 입력 기록에 쓰였습니다. 삭제하면 그 기록의 미리보기가 깨집니다.`,
        },
        { status: 409 },
      );
    }

    // 파일은 우리 폴더 것만 지운다 — 디자인 빌더 등 남의 자산은 목록에서만 제거
    let fileDeleted = false;
    const prefix = ownedPrefix();
    if (url.startsWith(prefix)) {
      const filename = url.slice(prefix.length);
      if (filename && !filename.includes('/')) {
        await deleteRemote(REF_SUBPATH, filename);
        fileDeleted = true;
      }
    }

    await db.collection('references').deleteOne({ url });
    return NextResponse.json({ ok: true, mode: 'deleted', fileDeleted, usedIn });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
