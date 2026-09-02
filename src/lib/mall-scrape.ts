import 'server-only';

/**
 * 경쟁사 자사몰 메인에서 배너 비주얼을 직접 걷어온다.
 *
 * 왜: 네이버 이미지 검색은 상품 썸네일 위주라 "걔네가 지금 뭘 걸어놨나"가
 * 안 보인다. 자사몰 메인은 공개 페이지고, 진행 중인 프로모션 배너가
 * 그대로 걸려 있다 — 실측: 폴리몰리 메인에서 main_bn_* 16장, 보니타는
 * cafe24 /web/product/big/YYYYMM/ (폴더명이 업로드 월) 비주얼이 잡혔다.
 *
 * 과거는 웨이백머신이 유일한 소급 경로다. 지난 이벤트 페이지는 내려가지만
 * 웨이백에 메인 스냅샷이 드문드문 남아 있다 (실측: 폴리몰리 2025-02/04/07,
 * 보니타 2025-02/07). 링크만 보드에 걸어 "그때 메인 보기"로 쓴다.
 *
 * 예의: 메인 한 장씩만, 스냅샷 수집 때만 받는다. 상시 크롤링이 아니다.
 * 스마트스토어는 봇 차단(429)이라 대상에서 뺐다.
 */

interface Mall {
  brand: string;
  url: string;
  /** 배너로 볼 경로 무늬 */
  include: RegExp;
  /** 로고·아이콘·버튼류 제외 */
  exclude: RegExp;
}

const MALLS: Mall[] = [
  {
    brand: '폴리몰리',
    url: 'https://pollimolli.com/',
    include: /main_bn|main_banner|display[/]pollimolli|images[/]main/i,
    exclude: /logo|icon|btn|footer|favicon/i,
  },
  {
    brand: '보니타',
    url: 'https://xn--9i1bx6qpsq.com/',                 // 한글 도메인 자사몰 (cafe24)
    include: /web[/]product[/]big|web[/]upload|file_data.*gallery/i,
    exclude: /logo|icon|btn|common|favicon|small|tiny/i,
  },
];

const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) imgCreate-trends' };

/** //host/a.jpg · /a.jpg · 상대경로를 전부 절대 URL 로 */
function absolutize(src: string, base: string): string {
  try { return new URL(src, base).toString(); } catch { return ''; }
}

export interface MallBanner { brand: string; url: string; page: string }

export async function fetchMallBanners(): Promise<MallBanner[]> {
  const out: MallBanner[] = [];
  for (const m of MALLS) {
    try {
      const res = await fetch(m.url, { headers: UA, signal: AbortSignal.timeout(15000), cache: 'no-store' });
      if (!res.ok) continue;
      const html = await res.text();
      const seen = new Set<string>();
      const re = /(?:src|data-src|data-original)="([^"]+[.](?:jpg|jpeg|png|gif|webp)[^"]*)"/gi;
      let hit: RegExpExecArray | null;
      while ((hit = re.exec(html)) && seen.size < 15) {
        const raw = hit[1];
        if (!m.include.test(raw) || m.exclude.test(raw)) continue;
        const abs = absolutize(raw, m.url);
        if (!abs || seen.has(abs)) continue;
        seen.add(abs);
        out.push({ brand: m.brand, url: abs, page: m.url });
      }
    } catch { /* 한 몰이 죽어도 나머지는 걷는다 */ }
  }
  return out;
}

export interface WaybackShot { brand: string; month: string; waybackUrl: string; page: string }

/** 웨이백에 남은 과거 메인 스냅샷 — 월당 하나로 접는다 */
export async function fetchWaybackMonths(): Promise<WaybackShot[]> {
  const out: WaybackShot[] = [];
  for (const m of MALLS) {
    try {
      const host = new URL(m.url).host;
      const cdx = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(host)}`
        + '&from=2024&output=json&collapse=timestamp:6&fl=timestamp,statuscode&limit=60';
      // CDX 는 첫 응답이 40초 넘게 걸리기도 한다 (실측: 한 번은 1.2초, 한 번은 20초 초과)
      // — 짧은 타임아웃 한 방으로 끝내면 스냅샷마다 복불복이 된다. 길게 잡고 한 번 더 시도.
      let rows: string[][] | null = null;
      for (let attempt = 0; attempt < 2 && !rows; attempt++) {
        try {
          const res = await fetch(cdx, { signal: AbortSignal.timeout(60000), cache: 'no-store' });
          if (res.ok) rows = (await res.json()) as string[][];
        } catch { /* 재시도 */ }
      }
      if (!rows) continue;
      for (const [ts, status] of rows.slice(1)) {
        // 3xx 스냅샷도 웨이백에서 정상적으로 열린다 (보관된 리다이렉트를 따라간다)
        if (status && !/^[23]/.test(status)) continue;
        out.push({
          brand: m.brand,
          month: `${ts.slice(0, 4)}-${ts.slice(4, 6)}`,
          waybackUrl: `https://web.archive.org/web/${ts}/${m.url}`,
          page: m.url,
        });
      }
    } catch { /* 웨이백이 느려도 스냅샷 본체는 산다 */ }
  }
  return out;
}
