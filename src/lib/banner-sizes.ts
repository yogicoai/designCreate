/**
 * 배너 규격 — 이 화면의 첫 단추.
 *
 * 배너는 "무슨 문구를 쓰나"보다 "어디에 걸리나"가 먼저 정해지는 물건이다.
 * 1920×600 웹 메인과 1080×1920 스토리는 같은 문구라도 배치가 완전히 달라야 한다.
 * 그래서 사이즈를 고르는 게 1단계이고, 자동 배치는 이 비율을 보고 판단한다.
 *
 * 숫자는 실제 게시 규격이다. 컷은 대개 1:1 로 생성되므로
 * 여기 맞추려면 잘라내거나(cover) 여백을 채워야(blur) 한다.
 */

export type BannerShape = 'wide' | 'square' | 'tall';

export interface BannerSize {
  id: string;
  group: '웹' | '모바일' | 'SNS';
  label: string;
  w: number;
  h: number;
  /**
   * 본문 폭 (px). 배경은 화면 끝까지 깔리지만 글자는 이 폭 안에서 시작해야
   * 페이지의 다른 요소와 왼쪽 줄이 맞는다.
   *
   * 자사몰 상품상세가 1300px 이라, 1910 짜리 풀블리드 배너에서 글자를
   * 캔버스 왼쪽 끝(6%)에 붙이면 본문 칼럼보다 바깥으로 나가 어긋나 보인다.
   * 여백 = (w - content) / 2 로 잡는다.
   */
  content?: number;
  note?: string;
}

export const BANNER_SIZES: BannerSize[] = [
  // ── 웹 (자사몰) ── 실제로 쓰는 규격
  { id: 'web-main',   group: '웹', label: '자사몰 웹 메인',   w: 1900, h: 675, content: 1300, note: 'PC 첫 화면 · 본문 1300 에 맞춰 왼쪽 정렬' },
  { id: 'web-detail', group: '웹', label: '상품상세 배너',    w: 1300, h: 500, note: '상세페이지 본문 폭 그대로' },
  { id: 'web-sub',    group: '웹', label: '웹 서브·카테고리', w: 1200, h: 400 },

  // ── 모바일 ── 실제로 쓰는 규격
  { id: 'mo-main',   group: '모바일', label: '자사몰 모바일 메인', w: 480, h: 558, note: '문구를 위에 쌓고 버튼은 아래' },
  { id: 'mo-strip',  group: '모바일', label: '모바일 띠배너', w: 750, h: 200, note: '아주 납작해서 문구는 한 줄' },
  { id: 'mo-popup',  group: '모바일', label: '앱·웹 팝업',   w: 800, h: 1000 },

  // ── SNS ──
  { id: 'ig-square', group: 'SNS', label: '인스타 피드 (정사각)', w: 1080, h: 1080, note: '컷 그대로 쓰기 좋다' },
  { id: 'ig-port',   group: 'SNS', label: '인스타 피드 (세로)',   w: 1080, h: 1350 },
  { id: 'ig-story',  group: 'SNS', label: '스토리·릴스',          w: 1080, h: 1920 },
  { id: 'kakao',     group: 'SNS', label: '카카오 채널 메시지',    w: 800,  h: 800 },
  { id: 'yt-thumb',  group: 'SNS', label: '유튜브 썸네일',        w: 1280, h: 720 },
];

export function findSize(id: string): BannerSize {
  return BANNER_SIZES.find((s) => s.id === id) ?? BANNER_SIZES[0];
}

/**
 * 비율로 배너의 성격을 나눈다. 자동 배치가 이걸 보고 배치를 바꾼다.
 *   wide   가로로 길다  → 문구를 한쪽 옆에 세운다 (위아래로 쌓으면 눌린다)
 *   tall   세로로 길다  → 위나 아래에 크게 쌓는다
 *   square 정사각에 가깝다 → 지금까지 하던 대로
 */
export function shapeOf(w: number, h: number): BannerShape {
  const r = w / h;
  if (r >= 1.7) return 'wide';
  if (r <= 0.8) return 'tall';
  return 'square';
}

/** 원본 컷을 이 규격에 맞출 때 얼마나 잘려나가는지 — 미리 알려주기 위한 값 */
export function cropLoss(srcW: number, srcH: number, dstW: number, dstH: number): number {
  const k = Math.max(dstW / srcW, dstH / srcH);       // cover 배율
  const kept = (dstW / k) * (dstH / k);
  return Math.max(0, 1 - kept / (srcW * srcH));
}
