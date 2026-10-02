/**
 * 컷이 스튜디오 컷인가 — ΔE(목표 hex 와의 색 차이) 숫자를 믿어도 되는 컷인지 가른다 (점검 2026-10-02 4번).
 *
 * 왜: 배경·편집 원본이 있는 씬 컷은 방 조명으로 색이 바뀌는 게 정답이라 ΔE 가 커도 틀린 게 아니다.
 * 색을 잰 86컷 중 83컷이 씬 컷이었는데 전부 ΔE 가 빨갛게 떠서 숫자가 사람을 속였다.
 * 씬 컷의 색은 장면 검사(scene-check 의 colour)가 "방 조명을 감안해도 그 색 계열인가" 로 본다.
 *
 * 새 컷은 생성할 때 그림을 직접 보고 남긴 `qc.studio`(네 모서리가 단색인가)를 쓴다.
 * 그 기록이 없는 예전 컷은 입력 목록으로 추정한다 — 배경·분위기 참고·편집 원본이 없으면 스튜디오로.
 * (포즈 소스 컷은 kind 가 base 로 남지만 자세만 빌린 것이라 스튜디오다.)
 */
export function isStudioCut(c: { qc?: { studio?: boolean } | null; inputImages?: { kind: string; title?: string }[] }): boolean {
  if (typeof c.qc?.studio === 'boolean') return c.qc.studio;
  const im = c.inputImages ?? [];
  if (im.some((r) => r.kind === 'background' || r.kind === 'style')) return false;
  return !im.some((r) => r.kind === 'base' && !/^포즈 소스/.test(r.title ?? ''));
}
