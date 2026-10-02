import { notFound } from 'next/navigation';
import PageHeader from '@/components/PageHeader';
import PokemonCategories from '@/components/PokemonCategories';
import { LOCAL_ONLY } from '@/lib/local-only';
import { categorySummaries } from '@/lib/pokemon-store';

export const dynamic = 'force-dynamic';

/**
 * 자동화 > 포켓몬 — 이 PC 에서만 보이는 작업 폴더 (사용자 요청 2026-10-02).
 *
 * 카테고리(작업 묶음)별로 나눈다 — 첫 번째는 「1차 스티커 제작」. 카테고리 안에서 사용자가 레퍼런스를 올리고
 * 요청을 적어 두면, 대화(Claude)가 그걸 보고 힉스필드 등으로 만들어 같은 카테고리 아래 결과물로 넣는다.
 * 사용자와 Claude 둘만 쓰고, 다른 갤러리(생성이미지 등)와 섞지 않는다. 파일은 저장소의 pokemon/ 에만 있다.
 * 배포(서버)에서는 메뉴에서 빠지고 이 주소도 404 다 — src/lib/local-only.ts.
 */
export default async function PokemonPage() {
  if (!LOCAL_ONLY) notFound();
  const categories = await categorySummaries();

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title="포켓몬"
        desc="이 PC 에서만 보이는 작업 폴더입니다. 카테고리 안에 레퍼런스를 올리고 요청을 적어 두면 대화에서 이어서 작업하고, 결과물이 그 아래 쌓입니다. 서버·DB 에는 올라가지 않습니다."
      />
      <PokemonCategories initial={categories} />
    </div>
  );
}
