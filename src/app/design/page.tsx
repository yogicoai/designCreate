import PageHeader from '@/components/PageHeader';
import DesignStudio from '@/components/DesignStudio';
import { getCuts } from '@/lib/queries';
import type { DesignDoc } from '@/lib/design-render';

export const dynamic = 'force-dynamic';

export default async function DesignPage({
  searchParams,
}: {
  searchParams: Promise<{ load?: string }>;
}) {
  const { load } = await searchParams;

  /*
   * 배경 후보에서 저장된 배너는 뺀다 — 배너 위에 배너를 얹을 일은 없다.
   * 이관 컷도 배너 소재가 아니라 제외한다.
   */
  const cuts = await getCuts({ source: 'imgcreate', notProvider: 'design', limit: 60 });

  // 관리 게시판에서 '수정' 으로 들어온 경우 — 그때 그 배치를 그대로 연다
  let initial: DesignDoc | undefined;
  let loadedTitle: string | undefined;
  if (load) {
    const saved = await getCuts({ source: 'imgcreate', provider: 'design', limit: 200 });
    const hit = saved.find((c) => c.id === load);
    if (hit?.design?.layers?.length) {
      initial = hit.design;
      loadedTitle = hit.title;
    }
  }

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title={initial ? '배너 디자인 수정' : '배너 디자인 생성'}
        desc={initial
          ? `저장해둔 "${loadedTitle ?? '배너'}" 를 그때 그 배치 그대로 열었습니다. 고친 뒤 저장하면 새 배너로 하나 더 쌓입니다 — 원본은 관리 게시판에 그대로 남습니다.`
          : '생성한 컷 위에 문구·버튼·아이콘을 얹어 배너를 완성합니다. 문구만 넣고 자동 배치를 누르면 규격의 비율에 맞는 자리를 찾아 읽히는 색으로 놓아줍니다 — 마음에 안 들면 끌어서 옮기고 크기를 조절하면 됩니다.'}
      />
      <DesignStudio
        initial={initial}
        cuts={cuts.map((c) => ({
          id: c.id,
          url: c.url,
          label: c.title || `${c.line} ${c.colorName}`.trim() || c.spec || '컷',
        }))}
      />
    </div>
  );
}
