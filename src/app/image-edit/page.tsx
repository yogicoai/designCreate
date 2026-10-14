import ImageEditStudio, { type EditCut } from '@/components/ImageEditStudio';
import { getCuts } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * 포토샵 — 사진 자체를 고치는 화면 (오픈소스 PhotoCraft 를 통째로 띄운다).
 *
 * 사용자 요청 2026-10-14: "따로 빼서 항목으로 · 이미지 편집하기로 · 저기(배너 편집기)선 기존과 동일하게 간단 편집 기능으로 하고
 * 이건 정말 포토샵 기능 사용하게 · 이름은 포토샵이라고". 배너 편집기에 붙어 있던 PhotoCraft 버튼은 떼어 내고 여기로 옮겼다.
 * 생성이미지 갤러리에서 고를 수 있게 최근 컷을 같이 넘긴다 (SNS 자동화 컷 제외 — 갤러리 화면과 같은 범위).
 */
export default async function ImageEditPage() {
  const cuts = await getCuts({ notOrigin: 'sns-auto', limit: 160 }).catch(() => []);
  const items: EditCut[] = cuts
    .filter((c) => c.url)
    .map((c) => ({
      id: String(c.id),
      url: c.url,
      title: c.title || c.spec || '',
      createdAt: String(c.createdAt).slice(0, 10),
    }));
  return <ImageEditStudio cuts={items} />;
}
