import 'server-only';
import { collection, COLLECTIONS } from '@/lib/db';
import type { ProductDoc, PoseRefDoc, TalentDoc, CutDoc, HouseRuleDoc, ColorChipDoc, ExpressionDoc } from '@/lib/types';

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

  const colorSlots = products.reduce((n, p) => n + p.colors.length, 0);
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
