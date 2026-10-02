import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Metadata } from 'sharp';

/**
 * 포켓몬 작업 폴더 — 이 PC 의 저장소 안 pokemon/ (git 에 안 올라간다, .gitignore).
 *
 *   pokemon/categories.json  카테고리(작업 묶음) 목록 — 첫 번째는 「1차 스티커 제작」 (사용자 요청 2026-10-02)
 *   pokemon/references/      레퍼런스 — 사용자가 올린 원본 그대로 + 같은 이름의 .json(카테고리 · 참고할 점)
 *   pokemon/results/         결과물(스티커 등) + .json(카테고리 · 어떤 레퍼런스에서 나왔는지 · 만든 모델·크레딧·프롬프트)
 *   pokemon/uploads/         (예전 '작업 이미지' 칸 — 레퍼런스로 합쳤다. 읽기만 한다)
 *   pokemon/thumbs/          목록용 축소본(webp, 자동)
 *   pokemon/_trash/          지운 것 — 잘못 지워도 되살릴 수 있게 옮겨만 둔다
 *
 * 카테고리 화면은 위에 레퍼런스 등록, 아래에 결과물(사용자 결정 2026-10-02 「레퍼런스 등록하고 결과물 밑에 뜨고」).
 * cafe24·DB 에는 아무것도 올리지 않는다(사용자 결정 2026-10-02: 로컬에서만, 이 폴더 안에서만, 둘만 본다).
 * 원본은 다시 압축하지 않고 받은 그대로 둔다 — 스티커는 투명 배경·가장자리 화질이 중요하다.
 * 항목마다 JSON 을 따로 두는 건 여러 장을 한꺼번에 올려도 서로 덮어쓰지 않게 하려는 것.
 *
 * 대화에서 결과물을 넣을 때: node scripts/pokemon-add.mjs <이미지|URL> --source "#ab12" …(개발 서버가 떠 있어야 한다)
 */

export const POKEMON_DIR = path.join(process.cwd(), 'pokemon');

const DIRS = { upload: 'uploads', reference: 'references', result: 'results' } as const;
export type PokemonKind = keyof typeof DIRS;

export interface PokemonCategory {
  /** 주소에 쓰는 이름 — c1, c2 … */
  slug: string;
  name: string;
  /** 작업 조건 — 카테고리 화면 맨 위에 보인다(예: 스티커 크기·필수 요소·버전) */
  brief?: string;
  createdAt: string;
}

/** 결과를 어떻게 만들었는지 — 힉스필드로 만든 것은 모델·크레딧·프롬프트를 남겨 다음 작업 때 다시 쓴다 */
export interface PokemonGen {
  /** 'higgsfield' · 'code' 등 */
  tool: string;
  model?: string;
  credits?: number;
  prompt?: string;
  jobId?: string;
}

export interface PokemonItem {
  id: string;
  kind: PokemonKind;
  /** 어느 카테고리의 것인지 (c1 …) */
  category: string;
  /** 폴더 기준 상대 경로 (references/pk_….png) */
  file: string;
  /** 화면에 보이는 이름 — 올린 파일 이름 */
  name: string;
  /** 레퍼런스: 참고할 점 · 결과물: 설명 */
  note: string;
  /** 결과물이 어떤 레퍼런스에서 나왔는지 */
  sourceIds: string[];
  width: number;
  height: number;
  bytes: number;
  format: string;
  /** 실제로 비치는 픽셀이 있는지 — 스티커(투명 배경) 확인용 */
  transparent: boolean;
  /** 결과물에만 — 만든 도구·모델·크레딧·프롬프트 */
  gen?: PokemonGen;
  createdAt: string;
  updatedAt: string;
}

const ID_RE = /^pk_\d{8}_\d{6}_[a-z0-9]{4}$/;
export const validId = (id: string) => ID_RE.test(id);
const SLUG_RE = /^c\d{1,4}$/;
export const validSlug = (s: string) => SLUG_RE.test(s);

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  avif: 'image/avif', heic: 'image/heic', tif: 'image/tiff', svg: 'image/svg+xml',
};
export const mimeOf = (file: string) => MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';

function extOf(meta: Metadata): string {
  switch (meta.format) {
    case 'jpeg': return 'jpg';
    case 'heif': return meta.compression === 'av1' ? 'avif' : 'heic';
    case 'tiff': return 'tif';
    default: return meta.format ?? 'bin';
  }
}

function newId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `pk_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${rand}`;
}

async function ensureDirs() {
  await Promise.all([...Object.values(DIRS), 'thumbs', '_trash'].map((d) => fs.mkdir(path.join(POKEMON_DIR, d), { recursive: true })));
}

const metaPath = (kind: PokemonKind, id: string) => path.join(POKEMON_DIR, DIRS[kind], `${id}.json`);
const thumbPath = (id: string) => path.join(POKEMON_DIR, 'thumbs', `${id}.webp`);
const CATEGORIES_FILE = path.join(POKEMON_DIR, 'categories.json');

async function writeFileAtomic(p: string, text: string) {
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, p);
}

// ── 카테고리 ─────────────────────────────────────────────

export async function listCategories(): Promise<PokemonCategory[]> {
  try {
    const list = JSON.parse(await fs.readFile(CATEGORIES_FILE, 'utf8')) as PokemonCategory[];
    return Array.isArray(list) ? list.filter((c) => validSlug(c.slug)) : [];
  } catch {
    return [];
  }
}

export async function getCategory(slug: string): Promise<PokemonCategory | null> {
  return (await listCategories()).find((c) => c.slug === slug) ?? null;
}

export async function createCategory(name: string, brief = ''): Promise<PokemonCategory> {
  await ensureDirs();
  const list = await listCategories();
  const n = Math.max(0, ...list.map((c) => Number(c.slug.slice(1)))) + 1;
  const cat: PokemonCategory = {
    slug: `c${n}`, name: name.trim().slice(0, 60) || `카테고리 ${n}`,
    ...(brief.trim() ? { brief: brief.trim().slice(0, 8000) } : {}),
    createdAt: new Date().toISOString(),
  };
  await writeFileAtomic(CATEGORIES_FILE, JSON.stringify([...list, cat], null, 1));
  return cat;
}

export async function updateCategory(slug: string, patch: { name?: string; brief?: string }): Promise<PokemonCategory | null> {
  const list = await listCategories();
  const cat = list.find((c) => c.slug === slug);
  if (!cat) return null;
  if (patch.name !== undefined && patch.name.trim()) cat.name = patch.name.trim().slice(0, 60);
  if (patch.brief !== undefined) cat.brief = patch.brief.trim().slice(0, 8000);
  await writeFileAtomic(CATEGORIES_FILE, JSON.stringify(list, null, 1));
  return cat;
}

// ── 이미지 ──────────────────────────────────────────────

async function readJson(p: string): Promise<PokemonItem | null> {
  try {
    const m = JSON.parse(await fs.readFile(p, 'utf8')) as PokemonItem;
    return validId(m.id) ? { ...m, category: m.category ?? '' } : null;
  } catch {
    return null;
  }
}

/** 레퍼런스 · 결과물 (category 를 주면 그 카테고리만), 새것부터 */
export async function listItems(category?: string): Promise<PokemonItem[]> {
  await ensureDirs();
  const found = await Promise.all(Object.values(DIRS).map(async (dir) => {
    const names = (await fs.readdir(path.join(POKEMON_DIR, dir))).filter((n) => n.endsWith('.json'));
    return Promise.all(names.map((n) => readJson(path.join(POKEMON_DIR, dir, n))));
  }));
  return found.flat()
    .filter((m): m is PokemonItem => !!m && (category === undefined || m.category === category))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getItem(id: string): Promise<PokemonItem | null> {
  if (!validId(id)) return null;
  for (const kind of Object.keys(DIRS) as PokemonKind[]) {
    const m = await readJson(metaPath(kind, id));
    if (m) return m;
  }
  return null;
}

/** 이미지 한 장을 폴더에 넣는다. 이미지로 못 읽는 파일이면 던진다. */
export async function addItem(
  buf: Buffer,
  opts: { kind: PokemonKind; category: string; name: string; note?: string; sourceIds?: string[]; gen?: PokemonGen },
): Promise<PokemonItem> {
  await ensureDirs();
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) throw new Error('이미지 크기를 읽지 못했습니다');
  const turned = (meta.orientation ?? 1) >= 5;                 // 사진 방향 정보 — 세로로 찍힌 JPEG
  const transparent = !!meta.hasAlpha && !(await sharp(buf).stats()).isOpaque;

  let id = newId();
  while (await getItem(id)) id = newId();
  const file = `${DIRS[opts.kind]}/${id}.${extOf(meta)}`;
  await fs.writeFile(path.join(POKEMON_DIR, file), buf);
  await sharp(buf).rotate().resize(720, 720, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 84, alphaQuality: 90 }).toFile(thumbPath(id))
    .catch(() => undefined);                                    // 축소본이 실패하면 원본을 그대로 보여준다

  const now = new Date().toISOString();
  const item: PokemonItem = {
    id,
    kind: opts.kind,
    category: opts.category,
    file,
    name: opts.name.trim() || '이미지',
    note: (opts.note ?? '').trim(),
    sourceIds: (opts.sourceIds ?? []).filter(validId),
    width: turned ? meta.height : meta.width,
    height: turned ? meta.width : meta.height,
    bytes: buf.length,
    format: extOf(meta),
    transparent,
    ...(opts.gen ? { gen: cleanGen(opts.gen) } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await writeFileAtomic(metaPath(opts.kind, id), JSON.stringify(item, null, 1));
  return item;
}

function cleanGen(g: PokemonGen): PokemonGen {
  const out: PokemonGen = { tool: String(g.tool || 'higgsfield').slice(0, 40) };
  if (g.model) out.model = String(g.model).slice(0, 80);
  if (g.credits !== undefined && g.credits !== null && Number.isFinite(Number(g.credits))) out.credits = Number(g.credits);
  if (g.prompt) out.prompt = String(g.prompt).slice(0, 8000);
  if (g.jobId) out.jobId = String(g.jobId).slice(0, 80);
  return out;
}

export async function updateItem(id: string, patch: { note?: string; name?: string; sourceIds?: string[]; category?: string }) {
  const item = await getItem(id);
  if (!item) return null;
  if (patch.note !== undefined) item.note = String(patch.note).slice(0, 4000).trim();
  if (patch.name !== undefined && String(patch.name).trim()) item.name = String(patch.name).slice(0, 120).trim();
  if (patch.sourceIds !== undefined) item.sourceIds = patch.sourceIds.filter(validId);
  if (patch.category !== undefined && (await getCategory(patch.category))) item.category = patch.category;
  item.updatedAt = new Date().toISOString();
  await writeFileAtomic(metaPath(item.kind, id), JSON.stringify(item, null, 1));
  return item;
}

/** 지우기 = _trash/ 로 옮기기. 되살리려면 그 파일들을 원래 폴더로 옮기면 된다. */
export async function removeItem(id: string): Promise<boolean> {
  const item = await getItem(id);
  if (!item) return false;
  const trash = path.join(POKEMON_DIR, '_trash');
  const move = async (from: string) => {
    await fs.rename(from, path.join(trash, path.basename(from))).catch(() => undefined);
  };
  await move(path.join(POKEMON_DIR, item.file));
  await move(thumbPath(id));
  await move(metaPath(item.kind, id));
  return true;
}

/** 보여줄 파일 — thumb 면 축소본(없으면 원본) */
export async function fileFor(id: string, thumb: boolean): Promise<{ path: string; mime: string; name: string } | null> {
  const item = await getItem(id);
  if (!item) return null;
  if (thumb) {
    const t = thumbPath(id);
    if (await fs.stat(t).then(() => true, () => false)) return { path: t, mime: 'image/webp', name: item.name };
  }
  return { path: path.join(POKEMON_DIR, item.file), mime: mimeOf(item.file), name: item.name };
}

/** 카테고리마다 개수와 미리보기(결과물 우선, 없으면 레퍼런스) — 포켓몬 첫 화면 · 사이드바용 */
export async function categorySummaries() {
  const [cats, items] = await Promise.all([listCategories(), listItems()]);
  return cats.map((c) => {
    const mine = items.filter((it) => it.category === c.slug);
    const refs = mine.filter((it) => it.kind !== 'result');
    const results = mine.filter((it) => it.kind === 'result');
    return {
      ...c,
      references: refs.length,
      results: results.length,
      preview: (results.length ? results : refs).slice(0, 4).map((it) => it.id),
    };
  });
}
