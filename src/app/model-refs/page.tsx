import PageHeader from '@/components/PageHeader';
import ModelRefsManager, { type ModelRef } from '@/components/ModelRefsManager';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * 자산관리 > 모델 레퍼런스 등록.
 *
 * 전속 모델(얼굴 시트를 가진 고정 모델)과는 별개 자산이다.
 * "이런 느낌의 사람" 을 사진 + 나이대·키·체형·AI 적합도로 등록해 두고 관리한다.
 */
export default async function ModelRefsPage() {
  const db = await getDb();
  const rows = await db.collection('model_refs')
    .find({ hidden: { $ne: true } }).sort({ createdAt: -1 }).limit(200).toArray();

  const models: ModelRef[] = rows.map((r) => ({
    id: String(r._id),
    name: (r.name as string) ?? '',
    rep: (r.rep as string) ?? '',
    age: (r.age as string) ?? '20e',
    heightCm: (r.heightCm as number) ?? 170,
    bodyType: (r.bodyType as string) ?? 'slim',
    fitPct: (r.fitPct as number) ?? 80,
    note: (r.note as string) ?? '',
    size: (r.size as string) ?? '',
    sizeEn: (r.sizeEn as string) ?? '',
    refs: Array.isArray(r.refs) ? (r.refs as { url: string; title: string }[]) : [],
  }));

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1400px]">
      <PageHeader
        title="모델 레퍼런스 등록"
        desc="원하는 모델의 느낌을 사진과 조건으로 등록해 둡니다. 나이대·키·체형·AI 적합도까지 함께 저장돼, 생성할 때 그 조건이 그대로 쓰입니다."
      />
      <ModelRefsManager initial={models} />
    </div>
  );
}
