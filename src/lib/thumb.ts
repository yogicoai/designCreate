/**
 * 목록용 저화질 썸네일 URL — 우리 썸네일 함수(/api/thumb)를 거친다.
 *
 * 레퍼런스 원본(cafe24)이 장당 수 MB 라 목록에서 그대로 부르면 페이지가 기어간다
 * (사용자 확인 — 보관함·갤러리 로딩). 목록은 여기로 줄여 부르고,
 * 클릭해서 크게 볼 때만 원본 URL 을 쓴다.
 *
 * 예전엔 Next 이미지 최적화(/_next/image)를 썼는데, 배포 사이트(Vercel 무료 요금제)의 변환 월 한도를 다 써서
 * 402 로 거절돼 보관함 사진이 엑박이 됐다 (2026-09-22). 그래서 같은 일을 src/app/api/thumb 가 한다.
 *
 * 우리 호스팅(THUMB_HOSTS)만 줄여 준다 — 그 외(외부 URL·data URI)는 원본을 그대로 돌려준다.
 */
export const THUMB_HOSTS = new Set(['yogibo.openhost.cafe24.com', 'yogibo.kr', 'yogibo.cafe24.com']);
export const THUMB_WIDTHS = new Set([128, 256, 384]);

export function thumbUrl(url: string, w: 128 | 256 | 384 = 256): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !THUMB_HOSTS.has(u.hostname)) return url;
    return `/api/thumb?url=${encodeURIComponent(url)}&w=${w}`;
  } catch {
    return url;
  }
}
