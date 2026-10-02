import { NextResponse } from 'next/server';
import { LOCAL_ONLY } from '@/lib/local-only';
import { listItems, addItem, getItem, getCategory, validId, validSlug, type PokemonKind, type PokemonGen } from '@/lib/pokemon-store';

/**
 * 포켓몬 작업 폴더 (로컬 전용 — 배포에서는 404).
 *
 * GET  /api/pokemon?category=c1 — 그 카테고리의 레퍼런스 · 결과물 (category 없으면 전부)
 * POST /api/pokemon — multipart: file, category(c1 …), (선택) note, kind('reference' | 'result', 기본 reference),
 *                     name(보이는 이름), sourceIds(결과물이 나온 레퍼런스 id, 쉼표로 여러 개),
 *                     gen(JSON — 결과물을 만든 도구·모델·크레딧·프롬프트: {tool, model, credits, prompt, jobId})
 *   category 를 안 주면 sourceIds 의 첫 레퍼런스가 속한 카테고리로 넣는다.
 *
 * 이 PC 의 개발 서버에서만 돌아서 Vercel 의 4.5MB 본문 제한이 없다 — 원본을 줄이지 않고 그대로 받는다.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 80 * 1024 * 1024;
const notFound = () => NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

export async function GET(req: Request) {
  if (!LOCAL_ONLY) return notFound();
  const category = new URL(req.url).searchParams.get('category') ?? undefined;
  return NextResponse.json({ ok: true, items: await listItems(category) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request) {
  if (!LOCAL_ONLY) return notFound();
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: '파일이 없습니다.' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: `파일이 너무 큽니다 (${(file.size / 1024 / 1024).toFixed(1)}MB, 최대 80MB).` }, { status: 413 });
  }
  const k = String(form?.get('kind') || '');
  const kind: PokemonKind = k === 'result' ? 'result' : k === 'upload' ? 'upload' : 'reference';
  const sourceIds = String(form?.get('sourceIds') || '').split(/[\s,]+/).filter(validId);

  // 카테고리 — 주어진 것, 없으면 첫 레퍼런스가 속한 것
  let category = String(form?.get('category') || '');
  if (!category && sourceIds.length) category = (await getItem(sourceIds[0]))?.category ?? '';
  if (!validSlug(category) || !(await getCategory(category))) {
    return NextResponse.json({ ok: false, error: '어느 카테고리에 넣을지 정해 주세요 (category=c1 …).' }, { status: 400 });
  }

  let gen: PokemonGen | undefined;
  try {
    const g = JSON.parse(String(form?.get('gen') || 'null'));
    if (g && typeof g === 'object') gen = { ...g, tool: String(g.tool || 'higgsfield') };
  } catch { /* 생성 정보는 선택 — 깨졌으면 없는 것으로 */ }
  try {
    const item = await addItem(Buffer.from(await file.arrayBuffer()), {
      kind,
      category,
      name: String(form?.get('name') || file.name || '이미지').slice(0, 120),
      note: String(form?.get('note') || '').slice(0, 4000),
      sourceIds,
      gen,
    });
    return NextResponse.json({ ok: true, item });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `이미지로 읽을 수 없습니다 — ${(e as Error).message}` }, { status: 400 });
  }
}
