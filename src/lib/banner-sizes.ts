/**
 * 배너 규격 — 이 화면의 첫 단추.
 *
 * 배너는 "무슨 문구를 쓰나"보다 "어디에 걸리나"가 먼저 정해지는 물건이고,
 * '어디'는 규격보다 위에 채널이 있다: 자사몰 / 스마트스토어 / SNS.
 * 채널마다 걸리는 자리와 규격 묶음이 완전히 다르다 — eventTemp(구 배너 도구)도
 * 이 세 갈래로 나눠 관리했고, 그 규격 값을 그대로 이었다.
 *
 * 숫자는 실제 게시 규격이다. 컷은 대개 1:1 로 생성되므로
 * 여기 맞추려면 잘라내거나(cover) 여백을 채워야(blur) 한다.
 */

export type BannerShape = 'wide' | 'square' | 'tall';
export type Channel = '자사몰' | '스마트스토어' | 'SNS' | 'POP';

export const CHANNELS: Channel[] = ['자사몰', '스마트스토어', 'SNS', 'POP'];

export interface BannerSize {
  id: string;
  channel: Channel;
  label: string;
  w: number;
  h: number;
  /**
   * 본문 폭 (px). 배경은 화면 끝까지 깔리지만 글자는 이 폭 안에서 시작해야
   * 페이지의 다른 요소와 왼쪽 줄이 맞는다. 여백 = (w - content) / 2.
   * (자사몰 상품상세가 1300px — 풀블리드 배너에서 글자를 캔버스 끝에 붙이면
   *  본문 칼럼보다 바깥으로 나가 어긋나 보인다)
   */
  content?: number;
  note?: string;
  /**
   * 목록에서 감춘다. 지우지 않고 감추는 이유:
   *   - 예전에 이 규격으로 저장한 배너를 다시 열 때 findSize 가 크기를 찾아야 한다
   *   - 나중에 쓸 일이 생기면 이 표시만 지우면 된다
   */
  hidden?: boolean;
}

export const BANNER_SIZES: BannerSize[] = [
  // ── 자사몰 — 2026-09-03 재확정: 디자인팀 기본 템플릿(A안, 롤링배너)이 1920x680 기준 ──
  { id: 'web-main', channel: '자사몰', label: '자사몰 웹 메인 (롤링)', w: 1920, h: 680, content: 1300, note: 'PC 롤링배너 · A안 = 반반 분할(좌 문구+이미지 / 우 이미지)' },
  // 모바일도 디자인팀 실물 자산 기준 (yogibo.kr 운영 배너 실측 800×907 — 표시야 절반이지만 제작은 이 크기)
  { id: 'mo-main',  channel: '자사몰', label: '자사몰 모바일 메인', w: 800, h: 907, note: 'A안 = 이미지 1장 + 하단 그늘 + 문구 3줄 좌측정렬' },
  { id: 'web-detail', channel: '자사몰', label: '상품상세 배너', w: 1300, h: 500, hidden: true },
  { id: 'web-sub',    channel: '자사몰', label: '웹 서브·카테고리', w: 1200, h: 400, hidden: true },
  { id: 'mo-strip',   channel: '자사몰', label: '모바일 띠배너', w: 750, h: 200, hidden: true },
  { id: 'mo-popup',   channel: '자사몰', label: '앱·웹 팝업', w: 800, h: 1000, hidden: true },

  // ── 스마트스토어 — eventTemp 의 채널 규격 그대로 ──
  { id: 'ss-pc-main',   channel: '스마트스토어', label: 'PC 메인', w: 1920, h: 400, note: '슬림 가로 배너' },
  { id: 'ss-mo-main',   channel: '스마트스토어', label: '모바일 메인', w: 750, h: 600 },
  { id: 'ss-pc-coupon', channel: '스마트스토어', label: 'PC 쿠폰·홍보 띠', w: 1280, h: 200, note: '아주 납작해서 문구는 한 줄' },
  { id: 'ss-mo-coupon', channel: '스마트스토어', label: '모바일 쿠폰 띠', w: 750, h: 240 },
  { id: 'ss-thumb',     channel: '스마트스토어', label: '대표 이미지 (정사각)', w: 1300, h: 1300 },

  // ── SNS ──
  { id: 'ig-square', channel: 'SNS', label: '인스타 피드 (정사각)', w: 1080, h: 1080 },
  { id: 'ig-port',   channel: 'SNS', label: '인스타 피드 (세로)', w: 1080, h: 1350 },
  { id: 'ig-story',  channel: 'SNS', label: '스토리·릴스', w: 1080, h: 1920, hidden: true },
  { id: 'kakao',     channel: 'SNS', label: '카카오 채널 메시지', w: 800, h: 800, hidden: true },
  { id: 'yt-thumb',  channel: 'SNS', label: '유튜브 썸네일', w: 1280, h: 720, hidden: true },

  // ── POP (매장 인쇄물) — 포스터 3종. px 는 인쇄 납품 기준 역산 작업 해상도 ──
  //  A 계열은 전부 1:√2 라 세 규격이 같은 배치를 공유한다 (shapeOf 는 'tall').
  //  소형(A3)은 300dpi 원본을 그대로 만들고, 대형(A2·A1)은 포스터 시인거리 관행인
  //  150dpi 로 만든다 — 고급 인쇄가 필요하면 업스케일 한 번으로 커버된다.
  { id: 'pop-a2', channel: 'POP', label: '포스터 A2 (420×594mm)', w: 2480, h: 3508,
    note: '매장 벽·윈도우 표준 · 150dpi 실사출력 기준 · 인쇄소 납품 시 도련 3mm 별도' },
  { id: 'pop-a1', channel: 'POP', label: '포스터 A1 (594×841mm)', w: 3508, h: 4967,
    note: '대형 벽면·이젤 · 150dpi 실사출력 기준 · 도련 3mm 별도' },
  { id: 'pop-a3', channel: 'POP', label: '포스터 A3 (297×420mm)', w: 3508, h: 4961,
    note: '소형 안내·선반 · 300dpi 인쇄 원본 그대로 납품 가능 · 도련 3mm 별도' },
];

/**
 * 채널별 자동완성 묶음 — "자동완성 저장"이 한 번에 만드는 규격들.
 * 첫 항목이 그 채널의 대표 규격(채널을 고르면 기본으로 선택)이다.
 */
export const AUTO_SET: Record<Channel, string[]> = {
  '자사몰': ['web-main', 'mo-main'],
  '스마트스토어': ['ss-pc-main', 'ss-mo-main'],
  'SNS': ['ig-square', 'ig-port'],
  // 포스터는 A 계열이라 비율이 같다 — A2 로 잡으면 A1 은 같은 배치가 그대로 커진다
  'POP': ['pop-a2', 'pop-a1'],
};

/** 화면 목록에 내놓는 규격 — 채널로 거른다. 감춘 것은 findSize 로만 찾힌다 */
export function visibleSizesFor(channel: Channel): BannerSize[] {
  return BANNER_SIZES.filter((s) => s.channel === channel && !s.hidden);
}

export function defaultSizeFor(channel: Channel): string {
  return AUTO_SET[channel][0];
}

/** 저장된 배너를 다시 열 때, 그 규격이 속한 채널로 화면을 맞춘다 */
export function channelOf(sizeId: string): Channel {
  return BANNER_SIZES.find((s) => s.id === sizeId)?.channel ?? '자사몰';
}

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
