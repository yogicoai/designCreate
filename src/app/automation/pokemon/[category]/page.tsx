import Link from 'next/link';
import { notFound } from 'next/navigation';
import PageHeader from '@/components/PageHeader';
import PokemonBoard from '@/components/PokemonBoard';
import { LOCAL_ONLY } from '@/lib/local-only';
import { getCategory, listItems, validSlug } from '@/lib/pokemon-store';

export const dynamic = 'force-dynamic';

/**
 * 포켓몬 › 카테고리 하나 — 위에 작업 조건, 레퍼런스 등록, 그 아래 결과물 (사용자 결정 2026-10-02).
 * 주소는 카테고리 slug(c1 …). 로컬 전용 — 배포에서는 404.
 */
export default async function PokemonCategoryPage({ params }: { params: Promise<{ category: string }> }) {
  if (!LOCAL_ONLY) notFound();
  const { category: slug } = await params;
  if (!validSlug(slug)) notFound();
  const category = await getCategory(slug);
  if (!category) notFound();
  const items = await listItems(slug);

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title={category.name}
        desc="포켓몬 작업 폴더의 카테고리입니다. 레퍼런스를 올리고 요청을 적어 두면, 대화에서 그걸 보고 만든 결과물이 아래에 쌓입니다."
        right={<Link href="/automation/pokemon" className="chip">← 포켓몬 카테고리</Link>}
      />
      <PokemonBoard key={slug} initial={items} category={category} />
    </div>
  );
}
