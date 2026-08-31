import 'server-only';
import { collection, COLLECTIONS } from '@/lib/db';
import type { ProductDoc, PoseRefDoc, TalentDoc, CutDoc, HouseRuleDoc, ColorChipDoc } from '@/lib/types';

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
  limit?: number;
}

export async function getCuts(f: CutFilter = {}): Promise<WithId<CutDoc>[]> {
  const col = await collection<CutDoc>(COLLECTIONS.cuts);
  const q: Record<string, unknown> = { hidden: { $ne: true } };
  if (f.line) q.line = f.line;
  if (f.colorKey) q.colorKey = f.colorKey;
  if (f.talentCode) q['recipe.talentCodes'] = f.talentCode;
  if (f.source) q.source = f.source;
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
