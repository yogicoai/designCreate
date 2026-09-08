import PageHeader from '@/components/PageHeader';
import StoryboardStudio from '@/components/StoryboardStudio';
import { getCuts, getReferences, getProducts, getTalents } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * 영상 제작 — 컷 분할 스토리 시트를 만들어 대기열로 넘기는 화면.
 *
 * 렌더는 오너가 힉스필드에서 돌리고 완성본을 등록한다 (이미지 대기열과 같은 흐름).
 * 그래서 이 화면에는 "생성" 버튼이 없다 — 요청서를 만드는 곳이다.
 */
export default async function VideoPage() {
  const [cuts, references, products, talents] = await Promise.all([
    getCuts({ source: 'imgcreate', notProvider: 'design', limit: 200 }),
    getReferences(600),
    getProducts(),
    getTalents(),
  ]);

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title="영상 스토리보드"
        desc="컷마다 장면을 적고 이미지를 만들면 그 자리에 스토리보드가 그려집니다. 컷은 서로 이어받아 방·조명·색이 유지되고, 완성되면 그대로 영상 대기열로 넘어갑니다."
      />
      <StoryboardStudio
        cuts={cuts.map((c) => ({
          url: c.url,
          title: c.title || `${c.line} ${c.colorName}`.trim() || c.spec || '컷',
        }))}
        refs={references.map((r) => ({ url: r.url, title: (r.title || '').slice(0, 40) }))}
        products={products.map((p) => ({
          line: p.line,
          colors: (p.colors ?? []).map((c) => ({ key: c.key, name: c.name })),
        }))}
        talents={talents.map((t) => ({ code: String(t.code), label: `${t.category}${t.slot ?? ''}` }))}
      />
    </div>
  );
}
