import PageHeader from '@/components/PageHeader';
import DropboxManager from '@/components/DropboxManager';
import { lineKr } from '@/lib/ai-products';
import { getDropboxAssets, getDropboxSummary, getProducts } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function DropboxPage() {
  /*
   * 첫 묶음만 서버에서 받아 화면을 바로 띄운다 — 레퍼런스 화면과 같은 이유로,
   * 수천 장을 한 번에 실어 보내면 그것만으로 페이지 진입이 느려진다.
   * 나머지는 화면이 뜬 뒤 /api/dropbox 로 이어 받는다.
   */
  const [assets, summary, products] = await Promise.all([
    getDropboxAssets(200),
    getDropboxSummary(),
    getProducts(),
  ]);

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title="드롭박스"
        desc="팀 드롭박스 「1. 디자인 / 2.7 제품사진」에서 복사해 온 제품사진입니다. 원본은 읽기만 하고 건드리지 않습니다. 폴더명은 분류가 아니라 근거라서, 어떤 제품인지는 여기서 확인해 확정합니다."
      />
      <DropboxManager
        initial={assets}
        initialSummary={summary}
        // 라벨 후보는 한글로 — 드롭박스 폴더명도 한글이라 같은 말로 맞춰야 고르기 쉽다
        products={products.map((p) => lineKr(p.line)).filter(Boolean)}
      />
    </div>
  );
}
