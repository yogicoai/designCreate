/**
 * 드롭박스 사진의 제품 라벨 — 화면(칩·정리 모드 버튼)과 서버(API·분류 스크립트)가 같이 쓴다.
 *
 * 한 장에 여러 제품이 나오면 여러 개가 붙는다(촬영컷 30장 중 17장이 그랬다, 2026-09-22 테스트).
 * 「맥스 계열」·「물방울 계열」은 AI 가 모양은 알지만 크기를 못 가린 것 —
 * 맥스·미디·미니·슬림·더블은 모양이 같고 길이만 달라서, 사람이 없는 사진에서는 헷갈린다.
 * 사람이 정리 모드에서 정확한 제품으로 고쳐 주면 된다.
 * 라벨이 하나도 없으면 「미분류」 로 센다(필드가 없거나 빈 배열).
 */
export const PRODUCT_LABELS = [
  '맥스', '미디', '미니', '슬림', '더블',
  '라운저', '서포트', '피라미드', '팟', '드롭',
  '허기보', '버블', '롤', '메이트', '스퀴지보', '기타 요기보',
  '맥스 계열', '물방울 계열',
  '제품 없음',
] as const;
export type ProductLabel = (typeof PRODUCT_LABELS)[number];

/** 라벨이 없는 사진을 거르는 칩 이름 — 실제 라벨 값으로 저장하지는 않는다 */
export const UNSORTED = '미분류';

export function isProductLabel(v: unknown): v is ProductLabel {
  return typeof v === 'string' && (PRODUCT_LABELS as readonly string[]).includes(v);
}
