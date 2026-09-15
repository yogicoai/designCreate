/**
 * 로고 없음 — 모든 이미지 생성의 필수 규칙 (사용자 확정 2026-09-15).
 *
 * 왜 필수인가: 제미나이가 요기보 태그·로고를 그리면 글자가 뭉개지거나(“qo ㅕo”), 크기가 과장되거나,
 * 없던 태그를 새로 붙인다 (2026-09-14 라운저 컷 — AI 생성 제품 칸은 로고가 없는데 태그가 생김).
 * 예전에는 "태그는 하나만, 작게, 글자가 무너질 것 같으면 비워라" 로 살리려 했지만 계속 이상하게 나왔다.
 * 그래서 로고·태그는 생성 단계에서 전부 빼고, 필요하면 나중에 디자인 단계에서 얹는다.
 *
 * 프롬프트 작성기(이미지 생성 화면)는 이 문장을 본문에 넣고, 제미나이 호출(gemini.ts)은
 * 어느 화면에서 들어온 프롬프트든 이 문장이 없으면 끝에 붙인다 — 배너 AI·스토리보드 시트 포함.
 */
export const NO_LOGO_RULE =
  'NO LOGO — MANDATORY: every product in this image is plain fabric with NO brand tag, NO sewn label, NO patch, ' +
  'NO logo, NO wordmark and NO lettering anywhere on it. If a reference photograph or the base photograph shows a tag ' +
  'or logo on a product, REMOVE it and render that spot as plain, continuous fabric of the same colour. ' +
  'Never draw, invent or add any logo, brand mark or tag.';

/** 프롬프트에 로고 없음 규칙이 없으면 끝에 붙인다 */
export function withNoLogo(prompt: string): string {
  return prompt.includes('NO LOGO — MANDATORY') ? prompt : `${prompt.trimEnd()}\n\n${NO_LOGO_RULE}`;
}
