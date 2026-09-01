import { NextResponse } from 'next/server';
import { getDb, COLLECTIONS } from '@/lib/db';
import { higgsfieldConfigured, CREDITS_PER_IMAGE } from '@/lib/higgsfield';

/**
 * 엔진별 잔여량 — 생성 전에 "얼마 남았고 얼마 나간다"를 화면에 띄우기 위한 것.
 *
 * gemini : 이 앱이 세는 월 생성 한도 (api_usage 카운터)
 * higgs  : 크레딧 **추정** 잔액. 힉스필드 플랫폼 REST 에는 잔액 조회 엔드포인트가 없어
 *          (생성 API 만 노출) 기준값에서 생성분을 빼는 방식으로 추적한다.
 *          실제 값과 어긋나면 PATCH 로 동기화한다.
 *
 * GET   → { gemini, higgs }
 * PATCH { credits } → 힉스필드 실제 잔액으로 기준값 재설정 (카운터 0)
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GEMINI_KEY = 'gemini-image';
const HIGGS_KEY = 'higgs-image';

export async function GET() {
  const out: Record<string, unknown> = {};

  try {
    const db = await getDb();
    const usage = db.collection(COLLECTIONS.apiUsage);

    const g = await usage.findOne({ _id: GEMINI_KEY as never });
    const limit = g?.limit ?? (Number(process.env.GEMINI_USAGE_LIMIT) || 300);
    const count = g?.count ?? 0;
    out.gemini = { count, limit, remaining: Math.max(0, limit - count) };

    if (higgsfieldConfigured()) {
      const h = await usage.findOne({ _id: HIGGS_KEY as never });
      const baseline = h?.baseline ?? null;
      const spent = (h?.count ?? 0) * CREDITS_PER_IMAGE;
      out.higgs = {
        configured: true,
        perImage: CREDITS_PER_IMAGE,
        generated: h?.count ?? 0,
        spent,
        baseline,
        // 기준값이 없으면 잔액을 모른다 — 화면에서 입력받는다
        credits: baseline != null ? Math.max(0, baseline - spent) : null,
        estimated: true,
        syncedAt: h?.syncedAt ?? null,
      };
    } else {
      out.higgs = { configured: false };
    }
  } catch (e) {
    out.error = (e as Error).message;
  }

  return NextResponse.json({ ok: true, ...out });
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as { credits?: number };
    const credits = Number(body.credits);
    if (!Number.isFinite(credits) || credits < 0) {
      return NextResponse.json({ ok: false, error: '유효한 크레딧 값이 필요합니다.' }, { status: 400 });
    }
    const db = await getDb();
    await db.collection(COLLECTIONS.apiUsage).updateOne(
      { _id: HIGGS_KEY as never },
      { $set: { baseline: credits, count: 0, syncedAt: new Date() } },
      { upsert: true },
    );
    return NextResponse.json({ ok: true, credits });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
