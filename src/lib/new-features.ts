/**
 * 새 기능 알림 — 화면 안의 새 버튼·새 규칙 옆에 「NEW」 를 붙이는 기한.
 *
 * 사용자 요청 2026-10-21: "기능 추가 요소로 했을 때는 새로운 기능으로 해서 알려주는 방식으로".
 * 메뉴의 N(api/nav-badges 의 NEW_MENUS)처럼 날짜가 지나면 저절로 사라진다 — 표시를 박아 두면
 * 지우는 걸 잊어 계속 붙는다(2026-10-14 지적).
 */
export const NEW_FEATURES = {
  /** 얼굴 다시 그리기 — 생성 결과 카드·완료 팝업·생성이미지 갤러리 (2026-10-21) */
  faceFix: '2026-10-28T23:59:59+09:00',
  /** 2인 이상 전속 모델 컷은 4K 로 생성 + 2인 와이드 컷 안내 (2026-10-21) */
  multiFace4k: '2026-10-28T23:59:59+09:00',
} as const;

export type NewFeature = keyof typeof NEW_FEATURES;

export function isNewFeature(key: NewFeature, now = Date.now()): boolean {
  return now < new Date(NEW_FEATURES[key]).getTime();
}
