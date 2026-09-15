/**
 * "새로 추가됨(N)" 표시 기준 — 등록 후 하루 (사용자 요청 2026-09-15).
 * 사이드바 메뉴 배지(/api/nav-badges)와 화면 속 카드 배지가 같은 기준을 쓴다.
 */
export const NEW_BADGE_MS = 24 * 60 * 60 * 1000;

/** 등록 시각이 하루 안이면 true — 시각이 없거나 잘못됐으면 false */
export function isRecent(iso: string | Date | null | undefined, now: number = Date.now()): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && now - t >= 0 && now - t < NEW_BADGE_MS;
}
