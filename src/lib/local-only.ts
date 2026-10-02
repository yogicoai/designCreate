/**
 * 이 PC 에서 개발 서버(`next dev`)로 돌릴 때만 true.
 * 배포(서버)에서는 false 라 로컬 전용 화면은 메뉴에서 빠지고, 주소로 들어와도 404 다.
 *
 * 사용자 결정 2026-10-02: 포켓몬 작업 폴더는 "로컬에서만 보이는 것 — 서버에 올라갈 땐 숨김".
 * 클라이언트 번들에서도 NODE_ENV 는 빌드 때 박히므로 사이드바(클라이언트)에서 그대로 쓸 수 있다.
 */
export const LOCAL_ONLY = process.env.NODE_ENV === 'development';
