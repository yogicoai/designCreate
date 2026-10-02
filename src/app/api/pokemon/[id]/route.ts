import { promises as fs } from 'node:fs';
import { NextResponse } from 'next/server';
import { LOCAL_ONLY } from '@/lib/local-only';
import { fileFor, updateItem, removeItem, validId } from '@/lib/pokemon-store';

/**
 * 포켓몬 작업 폴더의 한 장 (로컬 전용 — 배포에서는 404).
 *
 * GET    /api/pokemon/<id>             원본 이미지 (?thumb=1 축소본 · ?download=1 내려받기)
 * PATCH  /api/pokemon/<id>             JSON { note?, name?, sourceIds?, category? }
 * DELETE /api/pokemon/<id>             pokemon/_trash/ 로 옮긴다(되살릴 수 있다)
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!LOCAL_ONLY || !validId(id)) return notFound();
  const q = new URL(req.url).searchParams;
  const f = await fileFor(id, q.get('thumb') === '1');
  if (!f) return notFound();
  const buf = await fs.readFile(f.path).catch(() => null);
  if (!buf) return notFound();
  const headers: Record<string, string> = { 'Content-Type': f.mime, 'Cache-Control': 'private, max-age=86400' };
  if (q.get('download') === '1') {
    const ext = f.path.split('.').pop();
    const base = f.name.replace(/\.[a-z0-9]{2,5}$/i, '');
    headers['Content-Disposition'] = `attachment; filename="${id}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`;
  }
  return new Response(new Uint8Array(buf), { headers });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!LOCAL_ONLY || !validId(id)) return notFound();
  const body = await req.json().catch(() => ({}));
  const item = await updateItem(id, {
    note: typeof body.note === 'string' ? body.note : undefined,
    name: typeof body.name === 'string' ? body.name : undefined,
    sourceIds: Array.isArray(body.sourceIds) ? body.sourceIds.map(String) : undefined,
    category: typeof body.category === 'string' ? body.category : undefined,
  });
  return item ? NextResponse.json({ ok: true, item }) : notFound();
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!LOCAL_ONLY || !validId(id)) return notFound();
  return (await removeItem(id)) ? NextResponse.json({ ok: true }) : notFound();
}
