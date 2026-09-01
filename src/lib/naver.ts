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

/*
 * .trim() 이 필수다.
 * 윈도우에서 .env.local 이 CRLF 로 저장되면 값 끝에 
 이 남는데, Next 는 그걸
 * 그대로 넘긴다. HTTP 헤더에 
 이 섞이면 네이버가 SE99(System error)로 거부한다.
 * 실측으로 하루를 날릴 뻔한 자리다 — 키는 맞는데 라우트에서만 실패한다.
 */
const ID = (process.env.NAVER_CLIENT_ID || '').trim();
const SECRET = (process.env.NAVER_CLIENT_SECRET || '').trim();

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

/** 블로그·카페 글 한 건 — 경쟁사 이벤트/프로모션 흔적 */
export interface NaverPost {
  title: string;
  link: string;
  /** 요약 발췌 — 할인율·기간이 여기 담기는 경우가 많다 */
  desc: string;
  /** 게시일 YYYY-MM-DD (카페 글은 날짜를 안 주는 경우가 있어 빈 문자열) */
  date: string;
  /** 블로그명 / 카페명 */
  source: string;
  kind: 'blog' | 'cafe';
  /** 제목·본문에서 뽑은 업체명 (못 찾으면 '') */
  brand: string;
  /** 대표 할인율 (%) — 0 이면 못 찾음 */
  discount: number;
  /** 판매가 (만원) — 0 이면 못 찾음 */
  price: number;
  /** 특가 소구 문구 — "어떤 카피를 썼나" 가 이 화면의 핵심이다 */
  copy: string[];
  /** 자사(요기보) 건인지 — 경쟁사 분석에서는 기본으로 걸러낸다 */
  isOurs: boolean;
}

/** YYYYMMDD → YYYY-MM-DD */
function ymd(s?: string): string {
  const t = String(s || '').replace(/\D/g, '');
  return t.length === 8 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : '';
}

/**
 * 경쟁사 이벤트·프로모션 흔적 검색.
 *
 * 이벤트 페이지는 끝나면 내려가서 원본이 안 남는다. 대신 블로그·카페에
 * "○○ 몇 % 특가", "○○ 럭키드로우 이벤트" 같은 글이 날짜와 함께 남는다 —
 * 실측으로 플래지어 32%, 요기보 44% 위클리특가, 폴리몰리 30% 가 그대로 잡혔다.
 *
 * 뉴스는 넣지 않는다. '빈백' 뉴스는 야외도서관·행사장에 빈백을 깔았다는
 * 기사가 대부분이라 경쟁사 프로모션과 무관한 노이즈다.
 */
export async function searchPosts(query: string, { display = 30 } = {}): Promise<NaverPost[]> {
  if (!naverConfigured()) {
    throw new NaverError('NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 이 설정되지 않았습니다 (.env.local).', 503);
  }
  const per = Math.max(1, Math.min(50, Math.round(display / 2)));
  const call = async (path: 'blog' | 'cafearticle', kind: 'blog' | 'cafe'): Promise<NaverPost[]> => {
    const u = `https://openapi.naver.com/v1/search/${path}.json`
      + `?query=${encodeURIComponent(query)}&display=${per}&sort=date`;
    const res = await fetch(u, {
      headers: { 'X-Naver-Client-Id': ID, 'X-Naver-Client-Secret': SECRET },
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { items?: Record<string, string>[] };
    return (j.items ?? []).map((x) => {
      const title = stripTags(x.title || '');
      const desc = stripTags(x.description || '');
      const both = `${title} ${desc}`;
      const brand = extractBrand(both);
      return {
        title,
        link: x.link || '',
        desc,
        date: ymd(x.postdate),
        source: stripTags(x.bloggername || x.cafename || ''),
        kind,
        brand,
        discount: extractDiscount(both),
        price: extractPrice(both),
        copy: extractCopy(both),
        isOurs: brand === OUR_BRAND || both.includes(OUR_BRAND),
      };
    });
  };
  const [a, b] = await Promise.all([call('blog', 'blog'), call('cafearticle', 'cafe')]);
  // 날짜 있는 것 우선, 최신순
  return [...a, ...b].sort((x, y) => (y.date || '').localeCompare(x.date || ''));
}

/** 자사 브랜드 — 경쟁사 분석에서는 빼야 한다 */
export const OUR_BRAND = '요기보';

/*
 * 추적할 경쟁사.
 *
 * 넓게 잡았더니 강아지빈백·라탄가구·잡화까지 끌려와 목록이 지저분해졌다.
 * 실제로 비교 의미가 있는 업체만 둔다. 새 업체가 눈에 띄면 여기 한 줄 추가하면
 * 그때부터 업체별 정리에 잡힌다 — 넓히는 건 쉽고, 좁히는 건 어렵다.
 */
export const BEANBAG_BRANDS = ['보니타', '폴리몰리'];

/**
 * 제목·본문에서 업체명을 뽑는다. 추적 목록에 있는 것만 인정한다.
 *
 * 예전에 [대괄호] 표기와 제목 첫 단어로도 추론했는데, "[핫딜]", "대여",
 * "빈백 환승", "9만원대" 같은 게 업체로 잡혀 목록이 더 지저분해졌다.
 * 모르면 모른다고 두는 편이 낫다 — 새 경쟁사는 BEANBAG_BRANDS 에 한 줄 추가하면 된다.
 */
export function extractBrand(text: string): string {
  const t = text || '';
  if (t.includes(OUR_BRAND)) return OUR_BRAND;
  for (const b of BEANBAG_BRANDS) if (t.includes(b)) return b;
  return '';
}

/** 할인율(%)을 뽑는다. 여러 개면 가장 큰 값 — 대표 소구 숫자일 확률이 높다 */
export function extractDiscount(text: string): number {
  const hits = [...String(text || '').matchAll(/(\d{1,2})\s*(?:%|퍼센트|퍼)/g)].map((m) => Number(m[1]));
  // 하한 10% — 1~5% 는 적립률·수수료·평점 같은 무관한 숫자가 대부분이었다
  const valid = hits.filter((n) => n >= 10 && n <= 90);
  return valid.length ? Math.max(...valid) : 0;
}

/**
 * 특가 소구 문구를 뽑는다 — "어떤 카피를 썼나" 가 이 화면의 핵심이다.
 * 할인율 주변과 자주 쓰이는 관용구를 함께 본다.
 */
export function extractCopy(text: string): string[] {
  const t = String(text || '');
  const out = new Set<string>();
  const PATTERNS = [
    /(?:[1-9]\d)\s*(?:%|퍼센트|퍼)\s*(?:할인|세일|특가|off|OFF)?/g,
    /(?:위클리|주말|단독|한정|타임|시즌|오픈|런칭|리뉴얼|블프|블랙프라이데이)\s*특가/g,
    /(?:럭키드로우|경품|사은품|증정|1\+1|원플러스원|무료배송|쿠폰)/g,
    /(?:최대|역대급|단독|오늘만|마지막)\s*\S{0,6}(?:할인|특가|찬스)/g,
  ];
  for (const re of PATTERNS) for (const m of t.matchAll(re)) out.add(m[0].replace(/\s+/g, ' ').trim());
  return [...out].slice(0, 6);
}

/**
 * 가격대를 뽑는다 (만원 단위).
 * "53 → 30만", "30만원", "298,000원" 같은 표기를 본다.
 * 할인 표기가 둘이면 낮은 쪽이 판매가다.
 *
 * 하한 5만원 — 그 아래는 배송비·부자재 금액이 섞여 들어온다.
 */
export function extractPrice(text: string): number {
  const t = String(text || '');
  const nums: number[] = [];
  for (const m of t.matchAll(/(\d{1,4})\s*만\s*원?/g)) {
    const n = Number(m[1]);
    if (n >= 5 && n <= 500) nums.push(n);
  }
  for (const m of t.matchAll(/(\d{1,3}(?:,\d{3})+)\s*원/g)) {
    const n = Math.round(Number(m[1].replace(/,/g, '')) / 10000);
    if (n >= 5 && n <= 500) nums.push(n);
  }
  return nums.length ? Math.min(...nums) : 0;
}
