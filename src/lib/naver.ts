import 'server-only';

/**
 * 네이버 검색 API — 시즌 트렌드 참고 이미지 수집용.
 *
 * 왜 네이버인가: 자사몰이 한국 대상이라 한국 검색 결과가 훨씬 유용하고,
 * 무료 한도가 25,000 쿼리/일로 구글 Custom Search(100/일)보다 250배 크다.
 *
 * 키: developers.naver.com 에서 애플리케이션 등록 → '검색' API 체크 →
 *     NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 을 .env.local 에 넣는다.
 */

const ID = process.env.NAVER_CLIENT_ID || '';
const SECRET = process.env.NAVER_CLIENT_SECRET || '';

export function naverConfigured(): boolean {
  return !!(ID && SECRET);
}

export class NaverError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'NaverError';
    this.status = status;
  }
}

export interface NaverImage {
  /** 원본 이미지 주소 */
  link: string;
  /** 썸네일 주소 (목록 표시용 — 원본보다 가볍다) */
  thumbnail: string;
  /** 검색 결과 제목 (HTML 태그가 섞여 오므로 정리해서 쓴다) */
  title: string;
  sizeWidth: number;
  sizeHeight: number;
}

/** <b> 같은 강조 태그와 HTML 엔티티를 벗긴다 */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/**
 * 이미지 검색.
 * @param display 1~100. 네이버가 한 번에 주는 최대치가 100 이다.
 * @param start   1~1000. 그 이상은 API 가 거부한다.
 */
export async function searchImages(
  query: string,
  { display = 40, start = 1, sort = 'sim' as 'sim' | 'date' } = {},
): Promise<NaverImage[]> {
  if (!naverConfigured()) {
    throw new NaverError('NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 이 설정되지 않았습니다 (.env.local).', 503);
  }
  const url = new URL('https://openapi.naver.com/v1/search/image');
  url.searchParams.set('query', query);
  url.searchParams.set('display', String(Math.min(100, Math.max(1, display))));
  url.searchParams.set('start', String(Math.min(1000, Math.max(1, start))));
  url.searchParams.set('sort', sort);
  // filter=large — 배너·상세컷 참고가 목적이라 작은 썸네일은 걸러낸다
  url.searchParams.set('filter', 'large');

  const res = await fetch(url, {
    headers: { 'X-Naver-Client-Id': ID, 'X-Naver-Client-Secret': SECRET },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new NaverError(`네이버 검색 실패 (HTTP ${res.status}): ${body.slice(0, 200)}`, res.status);
  }
  const json = (await res.json()) as {
    items?: { link: string; thumbnail: string; title: string; sizeheight: string; sizewidth: string }[];
  };
  return (json.items ?? []).map((x) => ({
    link: x.link,
    thumbnail: x.thumbnail,
    title: stripTags(x.title || ''),
    sizeWidth: Number(x.sizewidth) || 0,
    sizeHeight: Number(x.sizeheight) || 0,
  }));
}
