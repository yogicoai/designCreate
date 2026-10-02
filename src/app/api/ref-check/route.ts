import { NextResponse } from 'next/server';
import { readReference } from '@/lib/ref-read';
import { refWarnings, type HygieneRole, type RefRead } from '@/lib/ref-hygiene';

/**
 * POST /api/ref-check — 올린 참조 사진에 무엇이 찍혀 있는지 읽어 준다 (점검 2026-10-02 6번).
 *
 * body: { urls: string[], role?: 'style' | 'base' | 'background' | 'shape' | 'pose' }
 * 응답: { ok, reads: { [url]: RefRead | null }, warnings?: { [url]: RefWarning[] } }
 *
 * 사진마다 한 번만 비전을 부르고 기록해 둔다(ref-read.ts). 역할별 경고는 화면이 refWarnings 로 직접 낸다 —
 * 역할은 올린 뒤에도 바뀌기 때문이다. role 을 같이 주면 그 역할 기준 경고도 돌려준다(스크립트용).
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

const ROLES: HygieneRole[] = ['style', 'base', 'background', 'shape', 'pose'];

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { urls?: unknown; role?: unknown };
    const urls = (Array.isArray(body.urls) ? body.urls : [])
      .filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u))
      .slice(0, 6);
    if (!urls.length) return NextResponse.json({ ok: false, error: 'urls 가 필요합니다.' }, { status: 400 });
    const role = ROLES.includes(body.role as HygieneRole) ? (body.role as HygieneRole) : null;

    const got = await Promise.all(urls.map((u) => readReference(u)));
    const reads: Record<string, RefRead | null> = {};
    urls.forEach((u, i) => { reads[u] = got[i]; });
    return NextResponse.json({
      ok: true,
      reads,
      ...(role ? { warnings: Object.fromEntries(urls.map((u) => [u, refWarnings(role, reads[u])])) } : {}),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
