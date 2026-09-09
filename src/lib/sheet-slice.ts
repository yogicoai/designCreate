import 'server-only';
import sharp from 'sharp';

/**
 * 여러 컷이 한 장에 담긴 콘티 시트를 칸별로 자른다.
 *
 * 왜 균등 분할이 아닌가: 생성 모델은 칸을 정확히 1/N 로 나눠주지 않는다.
 * 실측(얼굴 시트 3168px, 5칸)에서 경계가 703/1318/1901/2495 로 나왔다 — 균등이면
 * 634/1267/1901/2534 여야 한다. 균등으로 자르면 얼굴이 반씩 잘린다.
 *
 * 그래서 칸 사이의 '거의 흰 세로 구간' 을 찾아 그 중앙을 경계로 삼고,
 * 못 찾은 자리만 균등값으로 메운다.
 */

export interface SlicedPanel {
  left: number;
  width: number;
  buffer: Buffer;
}

/** 칸 경계 — 0 과 W 를 포함해 N+1 개를 돌려준다 */
export async function findColumnCuts(img: Buffer, panels: number): Promise<number[]> {
  const { data, info } = await sharp(img).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;

  // 세로로 훑어 '가장 어두운 픽셀조차 밝은' 열 = 칸 사이 여백
  const white: number[] = [];
  for (let x = 0; x < W; x++) {
    let mn = 255;
    for (let y = 0; y < H; y += 4) {
      const v = data[y * W + x];
      if (v < mn) mn = v;
    }
    if (mn > 225) white.push(x);
  }

  // 연속 구간으로 묶는다
  const runs: [number, number][] = [];
  let st = -1;
  let prev = -2;
  for (const x of white) {
    if (x !== prev + 1) { if (st >= 0) runs.push([st, prev]); st = x; }
    prev = x;
  }
  if (st >= 0) runs.push([st, prev]);

  // 가장자리 여백은 경계가 아니다
  const mids = runs
    .filter((r) => r[1] - r[0] >= 6 && r[0] > W * 0.05 && r[1] < W * 0.95)
    .map((r) => Math.round((r[0] + r[1]) / 2));

  const want = Array.from({ length: panels - 1 }, (_, i) => Math.round((W * (i + 1)) / panels));
  const picked = want.map((w) => {
    const near = mids
      .filter((m) => Math.abs(m - w) < W * 0.09)
      .sort((a, b) => Math.abs(a - w) - Math.abs(b - w));
    return near.length ? near[0] : w;
  });

  // 경계는 오름차순이어야 한다 — 검출이 엇갈리면 균등값으로 되돌린다
  for (let i = 1; i < picked.length; i++) {
    if (picked[i] <= picked[i - 1]) picked[i] = want[i];
  }
  return [0, ...picked, W];
}

/** 시트를 칸별 버퍼로 자른다 */
export async function sliceSheet(img: Buffer, panels: number): Promise<SlicedPanel[]> {
  const meta = await sharp(img).metadata();
  const H = meta.height ?? 0;
  if (!H || panels < 1) return [];
  const bounds = await findColumnCuts(img, panels);

  const out: SlicedPanel[] = [];
  for (let i = 0; i < panels; i++) {
    const left = bounds[i];
    const width = bounds[i + 1] - bounds[i];
    if (width < 8) continue;
    const buffer = await sharp(img)
      .extract({ left, top: 0, width, height: H })
      .jpeg({ quality: 92 })
      .toBuffer();
    out.push({ left, width, buffer });
  }
  return out;
}
