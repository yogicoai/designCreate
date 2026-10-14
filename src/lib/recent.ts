/**
 * "새로 추가됨(N)" 표시 기준 — 등록 후 하루 (사용자 요청 2026-09-15).
 * 사이드바 메뉴 배지(/api/nav-badges)와 화면 속 카드 배지가 같은 기준을 쓴다.
 */
export const NEW_BADGE_MS = 24 * 60 * 60 * 1000;

/**
 * 영상 제작물은 사흘 (사용자 요청 2026-10-13) — 영상은 며칠에 한 편씩 올라와서 하루면 못 보고 지나간다.
 * 새로 등록한 영상(createdAt)과, 카드는 그대로 두고 파일만 새 것으로 바꾼 영상(fileAt) 둘 다 센다.
 */
export const NEW_VIDEO_BADGE_MS = 3 * NEW_BADGE_MS;

/** 등록 시각이 기준 시간(기본 하루) 안이면 true — 시각이 없거나 잘못됐으면 false */
export function isRecent(
  iso: string | Date | null | undefined, now: number = Date.now(), within: number = NEW_BADGE_MS,
): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && now - t >= 0 && now - t < within;
}
