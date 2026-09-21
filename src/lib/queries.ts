import 'server-only';
import { collection, COLLECTIONS } from '@/lib/db';
import type { ProductDoc, PoseRefDoc, TalentDoc, CutDoc, HouseRuleDoc, ColorChipDoc, ExpressionDoc } from '@/lib/types';
import { toSheet, type AiProductSheet } from '@/lib/ai-products';

/** 규격 프리셋 — 자사몰/스마트스토어/SNS */
export interface SizePresetDoc {
  value: string; label: string; group: string;
  width: number; height: number; variableHeight: boolean;
  exactRatio: string | null; genAspect: string; retention: number;
  cropAxis: 'vertical' | 'horizontal' | 'none';
  order: number; active: boolean;
}
/** 연출 변형 축 */
export interface VariationDoc {
  axis: string; axisLabel: string; value: string; label: string; hint: string; order: number;
}
/** 업로드 레퍼런스 보존 강도 */
export interface PreservationDoc {
  value: string; label: string; desc: string; instruction: string; order: number;
}
/** 제품 연출컷 */
export interface UsageShotDoc {
  itemId: string; itemName: string; line: string | null; colorKey: string | null;
  kind: string; kindKr: string; kindEn: string; usableAsRef: boolean; url: string;
}

/**
 * 서버 컴포넌트에서 쓰는 읽기 쿼리 모음.
 * Mongo 의 _id 나 Date 는 클라이언트 컴포넌트로 그대로 못 넘어가므로,
 * 여기서 평범한 JSON 으로 정규화해서 내보낸다.
 */

type WithId<T> = T & { id: string };

function plain<T extends object>(d: (T & { _id?: unknown }) | null): WithId<T> | null {
  if (!d) return null;
  const { _id, ...rest } = d as T & { _id?: unknown };
  return { ...(rest as T), id: String(_id ?? '') };
}

export async function getProducts(): Promise<WithId<ProductDoc>[]> {
  const col = await collection<ProductDoc>(COLLECTIONS.products);
  const docs = await col.find({ active: true }).sort({ order: 1 }).toArray();
  return docs.map((d) => plain(d)!);
}

export async function getProduct(line: string): Promise<WithId<ProductDoc> | null> {
  const col = await collection<ProductDoc>(COLLECTIONS.products);
  return plain(await col.findOne({ line }));
}

export async function getTalents(): Promise<WithId<TalentDoc>[]> {
  const col = await collection<TalentDoc>(COLLECTIONS.talents);
  const docs = await col.find({ active: true }).sort({ order: 1 }).toArray();
  return docs.map((d) => plain(d)!);
}

export async function getPoseRefs(line?: string): Promise<WithId<PoseRefDoc>[]> {
  const col = await collection<PoseRefDoc>(COLLECTIONS.poseRefs);
  const docs = await col.find({ active: true, ...(line ? { line } : {}) }).toArray();
  return docs.map((d) => plain(d)!);
}

export interface CutFilter {
  line?: string;
  colorKey?: string;
  talentCode?: string;
  source?: 'legacy' | 'imgcreate';
  /** 'design' 이면 저장된 배너만 (배너 관리 게시판용) */
  provider?: string;
  /** 배경 후보에서 배너를 빼기 위한 것 — 배너 위에 배너를 얹을 일은 없다 */
  notProvider?: string;
  /** 만든 화면 필터 — 'sns-auto' 등. notOrigin 은 그걸 뺀 나머지 */
  origin?: string;
  notOrigin?: string;
  limit?: number;
}

export async function getCuts(f: CutFilter = {}): Promise<WithId<CutDoc>[]> {
  const col = await collection<CutDoc>(COLLECTIONS.cuts);
  const q: Record<string, unknown> = { hidden: { $ne: true } };
  if (f.line) q.line = f.line;
  if (f.colorKey) q.colorKey = f.colorKey;
  if (f.talentCode) q['recipe.talentCodes'] = f.talentCode;
  if (f.source) q.source = f.source;
  if (f.provider) q.provider = f.provider;
  if (f.notProvider) q.provider = { $ne: f.notProvider };
  if (f.origin) q.origin = f.origin;
  if (f.notOrigin) q.origin = { $ne: f.notOrigin };
  const docs = await col.find(q).sort({ createdAt: -1 }).limit(f.limit ?? 500).toArray();
  // Date 는 직렬화되지 않으므로 문자열로 바꾼다
  return docs.map((d) => {
    const p = plain(d)!;
    return { ...p, createdAt: new Date(p.createdAt).toISOString() as unknown as Date };
  });
}

export async function getHouseRules(): Promise<WithId<HouseRuleDoc>[]> {
  const col = await collection<HouseRuleDoc>(COLLECTIONS.houseRules);
  const docs = await col.find({}).sort({ order: 1 }).toArray();
  return docs.map((d) => plain(d)!);
}

export async function getColorChips(): Promise<WithId<ColorChipDoc>[]> {
  const col = await collection<ColorChipDoc>(COLLECTIONS.colorChips);
  const docs = await col.find({}).toArray();
  return docs.map((d) => plain(d)!);
}

export async function getSizePresets(): Promise<WithId<SizePresetDoc>[]> {
  const col = await collection<SizePresetDoc>(COLLECTIONS.sizePresets);
  const docs = await col.find({ active: true }).sort({ order: 1 }).toArray();
  return docs.map((d) => plain(d)!);
}

export async function getVariationOptions(): Promise<WithId<VariationDoc>[]> {
  const col = await collection<VariationDoc>(COLLECTIONS.variationOptions);
  const docs = await col.find({}).sort({ axis: 1, order: 1 }).toArray();
  return docs.map((d) => plain(d)!);
}

export async function getPreservationModes(): Promise<WithId<PreservationDoc>[]> {
  const col = await collection<PreservationDoc>(COLLECTIONS.preservationModes);
  const docs = await col.find({}).sort({ order: 1 }).toArray();
  return docs.map((d) => plain(d)!);
}

export async function getExpressions(): Promise<WithId<ExpressionDoc>[]> {
  const col = await collection<ExpressionDoc>('expressions');
  const docs = await col.find({ active: true }).sort({ order: 1 }).toArray();
  return docs.map((d) => plain(d)!);
}

/**
 * 이미지 생성에서 고를 수 있는 AI 생성 제품 시트.
 * 검증중 시트는 화면에 안 띄운다: 고를 수 있으면 승인 절차가 의미를 잃는다.
 *
 * 형태 시트(shape)가 기본이지만 **조합 시트는 kind 와 무관하게** 가져온다 —
 * 팟+서포트처럼 사람이 앉아야 형태가 성립하는 조합은 제품컷이 아니라 사용컷이 기준이다
 * (실측 2026-09-16: 사람 없이 서포트를 둥근 팟 위에 올리면 네 번 다 미끄러지거나 홈을 판다).
 */
export async function getApprovedShapeSheets(): Promise<AiProductSheet[]> {
  const col = await collection(COLLECTIONS.aiProducts);
  const docs = await col.find({
    status: 'approved',
    hidden: { $ne: true },
    $or: [{ kind: 'shape' }, { comboLines: { $exists: true, $ne: [] } }],
  }).sort({ line: 1, approvedAt: -1, createdAt: -1 }).toArray();
  return docs.map((d) => toSheet(d)).filter((s) => s.panels.length > 0);
}

/** 생성 참조로 쓸 수 있는 연출컷만 (텍스트 박힌 가이드시트·GIF 제외) */
export async function getUsageShots(line?: string): Promise<WithId<UsageShotDoc>[]> {
  const col = await collection<UsageShotDoc>(COLLECTIONS.usageShots);
  const docs = await col.find({ usableAsRef: true, ...(line ? { line } : {}) }).toArray();
  return docs.map((d) => plain(d)!);
}

/** 레퍼런스 보관함 항목 */
export interface ReferenceDoc {
  url: string;
  title: string;
  width: number;
  height: number;
  /** 레퍼런스 분류 — shoot(촬영) / banner(배너) / sns(SNS) / interior / instagram. null=미분류 */
  category: string | null;
  /**
   * 분류 안의 하위 분류 — '22 맥스'처럼 연도+제품 단위.
   * 2022 촬영본(1천여 장)이 폴더별로 정리돼 있어, 촬영 탭 안에서 한 번 더 나눠 보여준다.
   */
  sub?: string | null;
  tags: string[];
  /** 'upload' = 이 앱에서 업로드 / 'eventtemp' = 디자인 빌더 갤러리에서 가져옴 */
  source: string;
  createdAt: Date | string | null;
}

/**
 * 구 분류(web-banner/mobile/sns-story/thumbnail)를 새 3종으로 정규화한다.
 * 읽는 시점에 항상 정규화하므로, eventTemp 재동기화로 구 값이 다시 들어와도 화면은 3종을 유지한다.
 */
export function normalizeRefCategory(cat: string | null | undefined): string | null {
  if (!cat) return null;
  if (cat === 'thumbnail' || cat === 'shoot') return 'shoot';
  if (cat === 'web-banner' || cat === 'mobile' || cat === 'banner') return 'banner';
  if (cat === 'sns-story' || cat === 'sns') return 'sns';
  if (cat === 'interior') return 'interior'; // 빈 공간·인테리어 컷 — '배경으로 사용' 소스
  if (cat === 'instagram') return 'instagram'; // 인스타그램 게시물 백필 (scripts/import-instagram-feed.mjs)
  if (cat === 'model') return 'model'; // 모델컷 — 전속 모델 인물 레퍼런스 폴더
  // SNS 자동화 소스 — 인물 교체용(사람 있는 컷)과 제품 배치용(사람 없는 공간)을 폴더로 나눈다
  if (cat === 'sns-person') return 'sns-person';
  if (cat === 'sns-scene') return 'sns-scene';
  /*
   * 'dropbox' 는 여기 없다 — 드롭박스에서 가져온 제품사진은 references 가 아니라
   * 별도 컬렉션 dropbox_assets 에 산다 (사용자 결정 2026-09-21).
   * 레퍼런스가 이미 4,600장인데 드롭박스 9,565장을 섞으면 기존 작업이 묻히기 때문.
   * 아래 getDropboxAssets() 참고.
   */
  return null;
}

export async function getReferences(limit = 300): Promise<ReferenceDoc[]> {
  const col = await collection<ReferenceDoc & { active?: boolean }>('references');
  const docs = await col.find({ active: { $ne: false } }).sort({ createdAt: -1 }).limit(limit).toArray();
  return docs.map((d) => ({
    url: d.url,
    title: d.title ?? '',
    width: d.width ?? 0,
    height: d.height ?? 0,
    category: normalizeRefCategory(d.category),
    sub: d.sub ?? null,
    tags: d.tags ?? [],
    source: d.source ?? 'upload',
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
  }));
}

/* ── 드롭박스 파일 ─────────────────────────────────────────────────────────
 *
 * 팀 드롭박스 `1. 디자인/2.7 제품사진` 에서 복사해 온 제품사진. 원본은 읽기만 한다.
 *
 * 왜 references 가 아니라 별도 컬렉션인가 (사용자 결정 2026-09-21):
 *   레퍼런스가 이미 4,600장인데 드롭박스에는 9,565장이 있다. 한 컬렉션에 섞으면
 *   촬영 1,072장·모델컷 1,257장 같은 기존 작업이 그대로 묻힌다. 화면도 따로 둔다.
 *
 * 왜 제품 라벨(sub)이 비어 있는가:
 *   드롭박스 폴더명이 정확하다는 보장이 없다. 실측 결과 '슬림' 폴더의 41장이 파일명에
 *   midi 를 달고 있었고 '롤 닷' 6장은 전부 miniroll 이었다. 게다가 파일명에 단서가 있는
 *   것은 전체의 7%뿐이고, 한 장에 여러 제품이 나오는 사진도 흔하다.
 *   그래서 확정 라벨은 비워두고 근거(folderHint·filenameHint·labelStatus)만 남긴다.
 *   검수 화면에서 conflict 부터 훑어 sub 를 채우면 그때 라벨이 확정된다.
 */
/*
 * 드롭박스 자산의 두 갈래 (사용자 요청 2026-09-21).
 *   product = 제품사진. 폴더명을 못 믿어서 사람이 검수로 라벨을 확정한다.
 *   brand   = 브랜드 정리(0. 브랜드 이미지). 폴더명이 곧 캠페인 이름(「04월 PASTEL LOVE」,
 *             「#1_Winter」)이라 그대로 믿는다 — 검수 없이 시즌·월별로 묶어 보여준다.
 * section 필드가 없는 옛 문서는 전부 제품사진이다 — 그래서 조회는 "brand 가 아니면 product" 로 건다.
 */
export type DropboxSection = 'product' | 'brand';
export function dropboxSectionMatch(section: DropboxSection): Record<string, unknown> {
  return section === 'brand' ? { section: 'brand' } : { section: { $ne: 'brand' } };
}

export interface DropboxAssetDoc {
  /** 제품사진 / 브랜드 정리 */
  section: DropboxSection;
  /** 브랜드 정리의 상위 묶음 — 「시즌」 또는 「월별」. 제품사진은 빈 문자열 */
  group: string;
  url: string;
  /** 원본 파일명(확장자 제외) */
  title: string;
  width: number;
  height: number;
  /** 확정 제품 라벨 — 사람이 검수해서 채운다. null = 아직 미확정 */
  sub: string | null;
  /** 근거① 드롭박스 폴더명. 분류로 쓰지 말 것 — 틀린 폴더가 실제로 있다 */
  folderHint: string;
  /** 근거② 파일명에서 찾은 제품 토큰 */
  filenameHint: string[];
  /** agree=폴더와 파일명 일치 / folder-only=파일명 단서 없음 / conflict=둘이 다름 */
  labelStatus: 'agree' | 'folder-only' | 'conflict';
  /** 드롭박스 원본 상대경로 — 멱등 키이자 되돌아갈 수 있는 근거 */
  sourcePath: string;
  sourceName: string;
  createdAt: string | null;
}

/** 폴더별·검수상태별 개수 — 화면 상단의 필터 칩에 쓴다 */
export interface DropboxSummary {
  total: number;
  labeled: number;
  /** group = 브랜드 정리의 상위 묶음(시즌/월별). 제품사진은 빈 문자열 */
  byFolder: { folder: string; group: string; total: number; labeled: number; conflict: number }[];
  byStatus: Record<string, number>;
}

export async function getDropboxAssets(limit = 300, skip = 0, section: DropboxSection = 'product'): Promise<DropboxAssetDoc[]> {
  const col = await collection<DropboxAssetDoc & { active?: boolean; createdAt?: unknown }>('dropbox_assets');
  const docs = await col
    .find({ active: { $ne: false }, ...dropboxSectionMatch(section) })
    .sort({ folderHint: 1, sourcePath: 1 })
    .skip(skip)
    .limit(limit)
    .toArray();
  return docs.map(toDropboxAsset);
}

/** DB 문서 한 건을 화면이 쓰는 평범한 JSON 으로 — API 라우트도 같은 함수를 쓴다 */
export function toDropboxAsset(d: Record<string, unknown>): DropboxAssetDoc {
  const status = String(d.labelStatus ?? 'folder-only');
  return {
    section: d.section === 'brand' ? 'brand' : 'product',
    group: String(d.group ?? ''),
    url: String(d.url ?? ''),
    title: String(d.title ?? ''),
    width: Number(d.width) || 0,
    height: Number(d.height) || 0,
    sub: (d.sub as string | null) ?? null,
    folderHint: String(d.folderHint ?? ''),
    filenameHint: Array.isArray(d.filenameHint) ? (d.filenameHint as string[]) : [],
    labelStatus: (status === 'agree' || status === 'conflict' ? status : 'folder-only'),
    sourcePath: String(d.sourcePath ?? ''),
    sourceName: String(d.sourceName ?? ''),
    createdAt: d.createdAt ? new Date(d.createdAt as string).toISOString() : null,
  };
}

/**
 * 드롭박스 자산을 생성 화면 보관함이 쓰는 모양(ReferenceDoc)으로 꺼낸다.
 *
 * 보관함은 분류 탭 + 하위 칩으로 거르는 구조라, 여기에 얹으면 `category: 'dropbox'` 가
 * 탭이 되고 `sub`(확정 라벨 또는 드롭박스 폴더명)이 하위 칩이 된다 — 별도 UI 없이
 * 폴더별로 골라 쓸 수 있다.
 *
 * 왜 전부 안 보내나: 드롭박스 자산은 수천 장이고 생성 화면은 이미 레퍼런스 4,000장을
 * 싣고 있다. 첫 묶음만 서버에서 보내고 나머지는 화면에서 /api/dropbox 로 이어 받는다.
 */
export async function getDropboxAsRefs(limit = 1500, section: DropboxSection = 'product'): Promise<ReferenceDoc[]> {
  const col = await collection<Record<string, unknown>>('dropbox_assets');
  const docs = await col
    .find({ active: { $ne: false }, ...dropboxSectionMatch(section) })
    .project({ section: 1, url: 1, title: 1, width: 1, height: 1, sub: 1, folderHint: 1, createdAt: 1 })
    .sort({ folderHint: 1, sourcePath: 1 })
    .limit(limit)
    .toArray();
  return docs.map(dropboxToRef);
}

/** 드롭박스 문서 → 보관함 항목. API 로 이어 받을 때 화면도 같은 변환을 쓴다 */
export function dropboxToRef(d: Record<string, unknown>): ReferenceDoc {
  return {
    url: String(d.url ?? ''),
    title: String(d.title ?? ''),
    width: Number(d.width) || 0,
    height: Number(d.height) || 0,
    // 브랜드 정리는 보관함에서도 따로 — 제품사진 수천 장에 묻히지 않게 탭을 나눈다
    category: d.section === 'brand' ? 'brand' : 'dropbox',
    // 확정 라벨이 있으면 그것을, 없으면 폴더명을 하위 칩으로 — 어느 쪽이든 골라 쓸 수 있어야 한다
    // (브랜드 정리는 폴더명이 곧 캠페인 이름이라 「04월 (PASTEL LOVE)」 가 그대로 칩이 된다)
    sub: (d.sub as string | null) || String(d.folderHint ?? '') || null,
    tags: [],
    source: 'dropbox',
    createdAt: d.createdAt ? new Date(d.createdAt as string).toISOString() : null,
  };
}

/**
 * 폴더별 현황. 수천 장이라 목록을 다 받아서 세면 안 된다 — DB 에서 집계한다.
 * labeled = 사람이 sub 를 채운 것, conflict = 폴더와 파일명이 어긋나 먼저 봐야 할 것.
 */
export async function getDropboxSummary(section: DropboxSection = 'product'): Promise<DropboxSummary> {
  const col = await collection<Record<string, unknown>>('dropbox_assets');
  const base = { active: { $ne: false }, ...dropboxSectionMatch(section) };
  const [rows, statusRows, total, labeled] = await Promise.all([
    col.aggregate<{ _id: string; group: string; total: number; labeled: number; conflict: number }>([
      { $match: base },
      {
        $group: {
          _id: '$folderHint',
          group: { $first: '$group' },
          total: { $sum: 1 },
          labeled: { $sum: { $cond: [{ $in: ['$sub', [null, '']] }, 0, 1] } },
          conflict: { $sum: { $cond: [{ $eq: ['$labelStatus', 'conflict'] }, 1, 0] } },
        },
      },
      { $sort: { total: -1 } },
    ]).toArray(),
    col.aggregate<{ _id: string; n: number }>([
      { $match: base }, { $group: { _id: '$labelStatus', n: { $sum: 1 } } },
    ]).toArray(),
    col.countDocuments(base),
    col.countDocuments({ ...base, sub: { $nin: [null, ''] } }),
  ]);
  const byFolder = rows.map((r) => ({
    folder: r._id || '(없음)', group: r.group || '', total: r.total, labeled: r.labeled, conflict: r.conflict,
  }));
  /*
   * 브랜드 정리는 장수가 아니라 달력 순서로 — 「#1_Winter → #4_Fall」, 「01월 → 12월」.
   * 폴더명이 번호로 시작해서 숫자 인식 정렬이면 그대로 맞는다.
   */
  if (section === 'brand') {
    byFolder.sort((a, b) => (a.group.localeCompare(b.group, 'ko')) || a.folder.localeCompare(b.folder, 'ko', { numeric: true }));
  }
  return {
    total,
    labeled,
    byFolder,
    byStatus: Object.fromEntries(statusRows.map((r) => [r._id || 'folder-only', r.n])),
  };
}

/**
 * 전속 모델별 레퍼런스 요약 — { '여성B': { total, thumbs[] } }.
 *
 * 모델컷이 1,200장이 넘어서 전부 페이지에 실으면 안 된다. 화면에는 개수와
 * 맛보기 몇 장만 필요하므로 DB 에서 집계해 그만큼만 가져온다.
 */
export async function getModelRefSummary(
  perModel = 6,
): Promise<Record<string, { total: number; thumbs: string[] }>> {
  const col = await collection<{ sub?: string; url: string }>('references');
  const rows = await col
    .aggregate<{ _id: string; total: number; thumbs: string[] }>([
      { $match: { active: { $ne: false }, category: 'model', sub: { $nin: [null, ''] } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$sub', total: { $sum: 1 }, thumbs: { $push: '$url' } } },
      { $project: { total: 1, thumbs: { $slice: ['$thumbs', perModel] } } },
    ])
    .toArray();
  const out: Record<string, { total: number; thumbs: string[] }> = {};
  for (const r of rows) out[r._id] = { total: r.total, thumbs: r.thumbs ?? [] };
  return out;
}

/** 대시보드 집계 — 한 번에 필요한 숫자를 모아온다 */
export async function getOverview() {
  const [products, talents, poses, cutsCol] = await Promise.all([
    getProducts(),
    getTalents(),
    getPoseRefs(),
    collection<CutDoc>(COLLECTIONS.cuts),
  ]);

  const [total, generated, byTalent] = await Promise.all([
    cutsCol.countDocuments({ hidden: { $ne: true } }),
    cutsCol.countDocuments({ source: 'imgcreate', hidden: { $ne: true } }),
    cutsCol
      .aggregate<{ _id: string; n: number }>([
        { $match: { hidden: { $ne: true } } },
        { $unwind: '$recipe.talentCodes' },
        { $group: { _id: '$recipe.talentCodes', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ])
      .toArray(),
  ]);

  // colors 가 없는 제품이 있다 (소품·신규 등록분) — 없으면 0칸으로 센다
  const colorSlots = products.reduce((n, p) => n + (p.colors?.length ?? 0), 0);
  const slotsWithCuts = await cutsCol
    .aggregate<{ _id: { line: string; colorKey: string } }>([
      { $match: { hidden: { $ne: true } } },
      { $group: { _id: { line: '$line', colorKey: '$colorKey' } } },
    ])
    .toArray();

  return {
    products,
    talents,
    counts: {
      lines: products.length,
      colorSlots,
      coveredSlots: slotsWithCuts.length,
      poses: poses.length,
      talents: talents.length,
      cuts: total,
      generated,
    },
    byTalent: byTalent.map((b) => ({ code: b._id, n: b.n })),
    unverifiedGeometry: products.filter((p) => !p.geometry?.verified).map((p) => p.line),
  };
}
