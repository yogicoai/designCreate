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

/*
 * 예외 하나 — 편집 원본이 드롭박스 실촬영본일 때 (사용자 결정 2026-09-22: "드롭박스는 촬영본이라 로고 안 없애도 된다").
 * 그 사진의 태그는 진짜 봉제 태그다. 지우지 않고 그대로 두되, 새 태그를 그리거나 키우는 건 여전히 금지하고,
 * 글자가 뭉개지면 비운다(결과물 검사가 뭉개진 것·원본보다 늘어난 것만 지운다 — logo-guard.ts guardOutput keepReal).
 */
export const KEEP_TAG_MARK = 'BRAND TAGS — REAL SHOOT';
export const KEEP_REAL_TAG_RULE =
  `${KEEP_TAG_MARK}: the base photograph is a real Yogibo photo shoot, so any Yogibo tag in it is the genuine sewn tag. ` +
  'Where a product in the base photograph carries that tag, keep it on the same product exactly as photographed — same size, ' +
  'position, shape, colour and "yogibo" lettering, crisp and correctly spelled. Never add a tag, label, patch or logo to a product ' +
  'that has none in the base photograph, never enlarge a tag, and never draw any other logo or lettering. If a tag cannot be ' +
  'rendered crisp and correctly spelled, leave that spot as plain, continuous fabric of the same colour instead.';

/** 프롬프트에 로고 규칙(없음 또는 실촬영 태그 유지)이 없으면 끝에 붙인다 — 태그 유지 규칙이 이미 있으면 그걸 존중한다 */
export function withNoLogo(prompt: string): string {
  return prompt.includes('NO LOGO — MANDATORY') || prompt.includes(KEEP_TAG_MARK) ? prompt : `${prompt.trimEnd()}\n\n${NO_LOGO_RULE}`;
}

/** 실촬영 태그 유지 규칙이 없으면 끝에 붙인다 (Opus 가 빠뜨려도 들어가게) */
export function withKeepRealTags(prompt: string): string {
  return prompt.includes(KEEP_TAG_MARK) ? prompt : `${prompt.trimEnd()}\n\n${KEEP_REAL_TAG_RULE}`;
}
