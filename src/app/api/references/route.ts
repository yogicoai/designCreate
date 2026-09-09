import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { deleteRemote, REF_SUBPATH } from '@/lib/ftp';
import { normalizeRefCategory } from '@/lib/queries';

/**
 * 레퍼런스 보관함.
 *
 * 업로드(/api/upload)된 레퍼런스는 자동으로 여기 등록된다. eventTemp(디자인 빌더)의
 * 레퍼런스 갤러리에서 가져온 항목도 함께 산다 (source: 'eventtemp').
 *
 * GET    최근 레퍼런스 목록
 * POST   { url, title, category, sub } — 이미 있는 이미지를 보관함에 등록 (업로드 없이)
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

/**
 * GET /api/references?skip=&limit=&category=&sub=
 *
 * 보관함이 수천 장이라 한 번에 다 내려보내면 화면이 뜨는 데만 오래 걸린다.
 * 그래서 자산관리 화면은 첫 묶음만 서버에서 받아 바로 그리고, 나머지는 이 라우트로
 * 조각조각 이어 받는다 (skip/limit). 화면이 쓰는 필드만 projection 으로 골라 담는다.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const skip = Math.max(0, Number(url.searchParams.get('skip') ?? 0) || 0);
    const limit = Math.max(1, Math.min(3000, Number(url.searchParams.get('limit') ?? 300) || 300));
    // 분류·하위분류 필터 — 모델 레퍼런스 화면이 "이 모델 것만" 받아갈 때 쓴다
    const category = url.searchParams.get('category');
    const sub = url.searchParams.get('sub');
    const db = await getDb();
    const col = db.collection('references');
    const q: Record<string, unknown> = { active: { $ne: false } };
    if (category) q.category = category;
    if (sub) q.sub = sub;
    const [docs, total] = await Promise.all([
      col.find(q)
        .project({ url: 1, title: 1, width: 1, height: 1, category: 1, sub: 1, source: 1, createdAt: 1 })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      col.countDocuments(q),   // 수천 건이라도 밀리초 — 화면이 "몇 장 중 몇 장"을 알 수 있게 항상 센다
    ]);
    return NextResponse.json({
      ok: true,
      total,
      skip,
      references: docs.map((d) => ({
        url: d.url,
        title: d.title ?? '',
        width: d.width ?? 0,
        height: d.height ?? 0,
        category: normalizeRefCategory(d.category),
        sub: d.sub ?? null,
        tags: [],
        source: d.source ?? 'upload',
        createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
      })),
    }, {
      // 같은 묶음을 연달아 부를 때(탭 이동·뒤로가기)는 브라우저 캐시에서 바로 — 개인 데이터라 private
      headers: { 'Cache-Control': 'private, max-age=60, stale-while-revalidate=300' },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

/**
 * POST — 이미 서버에 있는 이미지를 보관함에 등록한다 (업로드 없이 주소만).
 *
 * 생성 결과를 그대로 레퍼런스로 쌓을 때 쓴다. 예: 사진 속 인물을 전속 모델로
 * 바꿔 만든 컷을 그 모델의 레퍼런스로 넣는 경우.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      url?: string; title?: string; category?: string | null; sub?: string | null;
      width?: number; height?: number; source?: string;
    };
    const url = String(body.url ?? '').trim();
    if (!url) return NextResponse.json({ ok: false, error: 'url 이 필요합니다.' }, { status: 400 });
    const db = await getDb();
    await db.collection('references').updateOne(
      { url },
      {
        $set: {
          url,
          title: String(body.title ?? '').slice(0, 120),
          category: normalizeRefCategory(body.category),
          ...(body.sub ? { sub: String(body.sub).slice(0, 40) } : {}),
          width: Number(body.width) || 0,
          height: Number(body.height) || 0,
          source: String(body.source ?? 'generated').slice(0, 30),
          active: true,
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as { url?: string; title?: string; category?: string | null; sub?: string | null };
    if (!body.url) return NextResponse.json({ ok: false, error: 'url 이 필요합니다.' }, { status: 400 });
    const db = await getDb();
    const set: Record<string, unknown> = {};
    if (body.title !== undefined) set.title = String(body.title ?? '').slice(0, 120);
    if (body.category !== undefined) {
      // 새 3종(shoot/banner/sns)으로 정규화 — 구 값이 와도 흡수한다
      set.category = normalizeRefCategory(body.category);
    }
    /*
     * sub = 하위 분류. 촬영은 '22 맥스' 처럼 촬영 회차가 들어가고,
     * 모델컷은 '여성B' 처럼 전속 모델 이름이 들어간다 — 같은 칸을 쓰면 칩 UI 가 그대로 붙는다.
     */
    if (body.sub !== undefined) set.sub = body.sub ? String(body.sub).slice(0, 40) : null;
    if (!Object.keys(set).length) return NextResponse.json({ ok: false, error: '변경할 값이 없습니다.' }, { status: 400 });
    await db.collection('references').updateOne({ url: body.url }, { $set: set });
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
