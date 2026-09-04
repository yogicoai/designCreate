/**
 * 목록용 저화질 썸네일 URL — Next 이미지 최적화 프록시(/_next/image)를 거친다.
 *
 * 레퍼런스 원본(cafe24)이 장당 수 MB 라 목록에서 그대로 부르면 페이지가 기어간다
 * (사용자 확인 — 보관함·갤러리 로딩). 목록은 여기로 줄여 부르고,
 * 클릭해서 크게 볼 때만 원본 URL 을 쓴다.
 *
 * next.config 의 images.remotePatterns 에 있는 호스트만 프록시를 탈 수 있다 —
 * 그 외(외부 URL·data URI)는 원본을 그대로 돌려준다.
 */
const HOSTS = new Set(['yogibo.openhost.cafe24.com', 'yogibo.kr', 'yogibo.cafe24.com']);

export function thumbUrl(url: string, w: 128 | 256 | 384 = 256): string {
  try {
    const u = new URL(url);
    if (!HOSTS.has(u.hostname)) return url;
    // q 는 Next 기본 허용값(75)만 가능 — 다른 값은 400 (images.qualities 미설정 상태)
    return `/_next/image?url=${encodeURIComponent(url)}&w=${w}&q=75`;
  } catch {
    return url;
  }
}
