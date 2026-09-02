import PageHeader from '@/components/PageHeader';
import BannerBoard, { type BannerRow } from '@/components/BannerBoard';
import { getCuts } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * 배너 디자인 관리 게시판.
 *
 * 배너는 컷과 같은 곳(cuts)에 저장되지만 provider='design' 으로 구분된다.
 * 설계도(design)를 함께 저장해두기 때문에 목록에서 그대로 다시 열어 고칠 수 있다.
 */
export default async function BannerManagePage() {
  const cuts = await getCuts({ source: 'imgcreate', provider: 'design', limit: 200 });

  const rows: BannerRow[] = cuts.map((c) => ({
    id: c.id,
    url: c.url,
    title: c.title || '배너',
    spec: c.spec ?? '',
    width: c.width ?? 0,
    height: c.height ?? 0,
    sizeLabel: c.sizeLabel || '배너 디자인',
    createdAt: String(c.createdAt),
    baseUrl: c.inputImages?.find((i) => i.role === 'base')?.url ?? null,
    // 설계도가 있어야 그때 그 배치로 다시 열 수 있다
    editable: !!c.design?.layers?.length,
    pairId: c.pairId ?? null,
    revisedFrom: c.revisedFrom ?? null,
  }));

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1200px]">
      <PageHeader
        title="배너 디자인 관리"
        desc="완성해서 저장한 배너들입니다. 수정을 누르면 그때 그 배치 그대로 다시 열립니다. 삭제하면 이미지 파일까지 지워집니다."
      />
      <BannerBoard rows={rows} />
    </div>
  );
}
