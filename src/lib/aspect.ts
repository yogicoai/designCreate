/**
 * 목표 픽셀 → 나노바나나 생성 비율 + 크롭 계획.
 * 프리셋 시드(scripts/seed-presets.mjs)와 커스텀 규격 입력이 같은 계산을 쓴다.
 */

export const GEN_ASPECTS = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'] as const;

export interface AspectPlan {
  genAspect: string;
  retention: number;
  cropAxis: 'vertical' | 'horizontal' | 'none';
}

export function planAspect(w: number, h: number): AspectPlan {
  if (!w || !h) return { genAspect: '1:1', retention: 1, cropAxis: 'none' };
  const target = w / h;
  let best = '1:1';
  let bestDiff = Infinity;
  for (const a of GEN_ASPECTS) {
    const [aw, ah] = a.split(':').map(Number);
    // 비율은 곱셈 스케일 — 로그 거리로 비교해야 넓은 후보가 부당하게 멀어 보이지 않는다
    const diff = Math.abs(Math.log(aw / ah / target));
    if (diff < bestDiff) { bestDiff = diff; best = a; }
  }
  const [bw, bh] = best.split(':').map(Number);
  const br = bw / bh;
  const retention = target > br ? br / target : target / br;
  return {
    genAspect: best,
    retention: Number(retention.toFixed(3)),
    cropAxis: Math.abs(target - br) < 0.01 ? 'none' : target > br ? 'vertical' : 'horizontal',
  };
}
