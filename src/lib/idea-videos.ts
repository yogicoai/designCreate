/**
 * 레퍼런스 제작물 — 기획안(/ideas)을 영상으로 시험해 본 결과물.
 *
 * 영상 제작물과 같은 videos 컬렉션·같은 cafe24 위장 저장·같은 /api/video 프록시를 쓰고, area 로만 가른다
 * (사용자 요청 2026-10-30: "아이디어 레퍼런스 아래다가 · 레퍼런스 제작물로 해서 · 거기서 확인해보자").
 * 완성본이 아니라 시험작이라 '영상 제작물' 화면·하위 폴더·N 표시에는 섞이지 않는다.
 * 폴더(= 기획안 한 편)와 그 안 묶음 소개는 settings 의 IDEA_FOLDERS_ID 문서 — 생김새는 video_folders 와 같다.
 */
export const IDEA_AREA = 'ideas';
export const IDEA_FOLDERS_ID = 'idea_video_folders';

/** 영상 제작물 쪽 조회에 붙이는 조건 — 레퍼런스 제작물을 뺀다 */
export const NOT_IDEA = { area: { $ne: IDEA_AREA } };
