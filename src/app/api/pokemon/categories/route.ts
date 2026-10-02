import { NextResponse } from 'next/server';
import { LOCAL_ONLY } from '@/lib/local-only';
import { categorySummaries, createCategory, updateCategory, validSlug } from '@/lib/pokemon-store';

/**
 * 포켓몬 카테고리 (로컬 전용 — 배포에서는 404).
 *
 * GET   /api/pokemon/categories          카테고리마다 개수·미리보기 (포켓몬 첫 화면 · 사이드바 하위 메뉴)
 * POST  /api/pokemon/categories          JSON { name, brief? } — 새 카테고리
 * PATCH /api/pokemon/categories          JSON { slug, name?, brief? } — 이름·작업 조건 바꾸기
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const notFound = () => NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

export async function GET() {
  if (!LOCAL_ONLY) return notFound();
  return NextResponse.json({ ok: true, categories: await categorySummaries() }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request) {
  if (!LOCAL_ONLY) return notFound();
  const body = await req.json().catch(() => ({}));
  const name = String(body?.name ?? '').trim();
  if (!name) return NextResponse.json({ ok: false, error: '카테고리 이름을 적어 주세요.' }, { status: 400 });
  return NextResponse.json({ ok: true, category: await createCategory(name, String(body?.brief ?? '')) });
}

export async function PATCH(req: Request) {
  if (!LOCAL_ONLY) return notFound();
  const body = await req.json().catch(() => ({}));
  const slug = String(body?.slug ?? '');
  if (!validSlug(slug)) return notFound();
  const cat = await updateCategory(slug, {
    name: typeof body?.name === 'string' ? body.name : undefined,
    brief: typeof body?.brief === 'string' ? body.brief : undefined,
  });
  return cat ? NextResponse.json({ ok: true, category: cat }) : notFound();
}
