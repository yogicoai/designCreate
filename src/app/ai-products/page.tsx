import PageHeader from '@/components/PageHeader';
import AiProductsManager from '@/components/AiProductsManager';
import { COLLECTIONS, getDb } from '@/lib/db';
import { toSheet } from '@/lib/ai-products';

export const dynamic = 'force-dynamic';

/**
 * 자산관리 > AI 생성 제품.
 *
 * 제품 하나를 여러 각도로 한 장에 뽑아 칸별로 잘라둔 곳이다.
 * 공식 사진은 촬영 시기·각도가 제각각이라 서로 모양이 안 맞는 경우가 있고,
 * 그게 섞여 참조로 들어가면 형태가 무너진다. 한 번에 뽑은 시트는 모든 칸이 같은 물건이다.
 */
export default async function AiProductsPage() {
  const db = await getDb();
  const rows = await db.collection(COLLECTIONS.aiProducts)
    .find({ hidden: { $ne: true } }).sort({ line: 1, createdAt: -1 }).limit(300).toArray();

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1400px]">
      <PageHeader
        title="AI 생성 제품"
        desc="제품 하나를 여러 각도로 한 장에 뽑아 칸별로 잘라둔 곳입니다. 한 번에 생성해서 모든 칸이 같은 모양이고, 사양과 대조해 승인한 시트만 형태 기준으로 씁니다."
      />
      <AiProductsManager initial={rows.map((r) => toSheet(r as Record<string, unknown>))} />
    </div>
  );
}
