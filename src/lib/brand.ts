/**
 * 요기보 브랜드 토큰 — 배너에서 고를 수 있는 값은 여기 있는 것뿐이다.
 *
 * MD 가 색을 자유롭게 고르는 것 자체가 디자이너 개입이다. 선택지를 브랜드가
 * 허락한 몇 가지로 좁혀야 아무나 만들어도 브랜드처럼 보인다. 버튼 색은
 * "사진에서 뽑기" 아니면 이 목록 중 하나 — 그 밖의 색은 4단계에서 손으로
 * 다듬는 사람만 쓴다.
 *
 * ⚠️ 색값은 앱에서 이미 쓰던 것을 옮겨둔 출발점이다. 실제 브랜드 가이드
 *    확정값이 나오면 이 파일 하나만 고치면 전부 반영된다.
 */

export interface BrandColor {
  id: string;
  name: string;
  hex: string;
}

export const BRAND_BUTTON_COLORS: BrandColor[] = [
  { id: 'red',  name: '요기보 레드', hex: '#e2503c' },
  { id: 'navy', name: '딥 네이비',   hex: '#2f3a5c' },
  { id: 'char', name: '차콜',        hex: '#1b1d21' },
];

export function brandButtonHex(id: string): string | undefined {
  return BRAND_BUTTON_COLORS.find((c) => c.id === id)?.hex;
}
