import PageHeader from '@/components/PageHeader';
import DropboxManager from '@/components/DropboxManager';
import { getDropboxAssets, getDropboxSummary } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function DropboxPage() {
  /*
   * 첫 묶음만 서버에서 받아 화면을 바로 띄운다 — 레퍼런스 화면과 같은 이유로,
   * 수천 장을 한 번에 실어 보내면 그것만으로 페이지 진입이 느려진다.
   * 나머지는 화면이 뜬 뒤 /api/dropbox 로 이어 받는다.
   */
  const [assets, summary, brandSummary] = await Promise.all([
    getDropboxAssets(200),
    getDropboxSummary('product'),
    // 브랜드 정리는 탭의 장수만 먼저 필요하다 — 목록은 탭을 누를 때 받는다
    getDropboxSummary('brand'),
  ]);

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title="드롭박스"
        desc="팀 드롭박스에서 복사해 온 사진입니다. 원본은 읽기만 하고 건드리지 않습니다 — 웹용으로 줄인 사본이라, 원본 화질이 필요하면 사진을 눌러 나오는 드롭박스 경로에서 찾으세요."
      />
      <DropboxManager
        initial={assets}
        initialSummary={summary}
        counts={{ product: summary.total, brand: brandSummary.total }}
      />
    </div>
  );
}
