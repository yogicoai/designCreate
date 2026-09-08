import PageHeader from '@/components/PageHeader';
import VideoStudio from '@/components/VideoStudio';
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
        title="영상 제작"
        desc="첫 프레임과 용도를 고르면 컷 분할 스토리 시트를 만들어 드립니다. 시트를 확인·수정해 대기열에 넣으면 제작 후 완성 영상을 올려드립니다."
      />
      <VideoStudio
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
