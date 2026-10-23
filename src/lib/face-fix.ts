import type { CutDoc } from '@/lib/types';

/**
 * 「얼굴 다시 그리기」(/api/face-fix) 대상 모델 — 갤러리 카드와 대시보드 크게 보기가 같이 쓴다.
 * 얼굴 대조 기록이 있으면 얼굴이 보인 모델만(뒷모습·가린 얼굴 제외),
 * 기록이 없는 예전 생성 컷이면 넣은 전속 모델 전부(서버가 대조를 한 번 돌려 위치를 찾는다).
 * 생성 엔진 컷만 — 배너 디자인(design)·포토샵 편집(edit) 컷은 대상이 아니다.
 */
export function faceFixCodes(c: Pick<CutDoc, 'provider' | 'qc' | 'recipe'>): string[] {
  if (!['gemini', 'gpt', 'higgs'].includes(c.provider ?? '')) return [];
  const verdicts = c.qc?.face?.verdicts;
  if (verdicts?.length) return verdicts.filter((v) => v.verdict !== 'noFace').map((v) => v.code);
  return c.recipe?.talentCodes ?? [];
}
