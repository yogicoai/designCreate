import 'server-only';
import sharp from 'sharp';

/**
 * 생성 후처리 — 목표 사이즈 크롭 + 컬러 정확도 측정.
 *
 * 실측(Phase 0.5)에서 색상별 편차가 확인됐다: 체리레드 ΔE 3~9(양호),
 * 올리브그린 ΔE 16~21(일관되게 어두움). 스와치를 참조로 넣어도 남는 편차다.
 * 그래서 생성물의 실제 색을 재서 기록하고, 필요하면 Lab 시프트로 보정한다.
 */

/** sRGB → CIE Lab */
export function toLab(R: number, G: number, B: number): [number, number, number] {
  const f = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [lr, lg, lb] = [f(R), f(G), f(B)];
  let X = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047;
  let Y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722;
  let Z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883;
  const g = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  [X, Y, Z] = [g(X), g(Y), g(Z)];
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

export function deltaE(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * 생성물에서 제품 색이 목표 hex 와 얼마나 다른지 잰다.
 *
 * 배경(#f2f2f4 스튜디오 그레이)과 피부·의상을 빼야 하므로, 목표 색과 **색상(hue)이 가까운
 * 픽셀만** 골라서 평균을 낸다. 단순 전체 평균은 배경에 끌려가 의미가 없다.
 */
export async function measureProductColor(
  buffer: Buffer,
  targetHex: string,
): Promise<{ hex: string; deltaE: number; sampled: number } | null> {
  try {
    const target = hexToRgb(targetHex);
    const tLab = toLab(...target);
    const { data, info } = await sharp(buffer)
      .removeAlpha()
      .resize(256, 256, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const px: [number, number, number] = [data[i], data[i + 1], data[i + 2]];
      // 목표 색과 Lab 거리가 가까운 픽셀만 — 배경/피부/의상 배제
      if (deltaE(toLab(...px), tLab) > 32) continue;
      r += px[0]; g += px[1]; b += px[2]; n++;
    }
    if (n < 50) return null; // 제품이 화면에 거의 없거나 색이 완전히 빗나감
    const avg: [number, number, number] = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    const hex = '#' + avg.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    return { hex, deltaE: Number(deltaE(toLab(...avg), tLab).toFixed(1)), sampled: n };
  } catch {
    return null;
  }
}

/**
 * 생성 비율에서 목표 픽셀로 크롭한다.
 *
 * 중앙 크롭이 아니라 **attention 크롭**을 쓴다 — 크롭 창이 얼굴·피사체가 있는 쪽을
 * 따라간다. 중앙 고정으로 잘랐더니 위쪽에 선 인물의 머리가 날아가는 사고가 실제로
 * 났다 (와이드 배너에서 서 있는 아이들 머리 잘림). attention 이 실패하면 중앙 폴백.
 *
 * 가변 높이(이벤트 페이지 등)는 폭만 맞추고 높이는 그대로 둔다.
 */
export async function cropToSize(
  buffer: Buffer,
  width: number,
  height: number,
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const meta = await sharp(buffer).metadata();
  if (!width || !meta.width || !meta.height) return { buffer, width: meta.width ?? 0, height: meta.height ?? 0 };

  if (!height) {
    // 세로 가변 — 폭만 맞춘다
    const out = await sharp(buffer).resize({ width, withoutEnlargement: false }).jpeg({ quality: 92 }).toBuffer();
    const m = await sharp(out).metadata();
    return { buffer: out, width: m.width ?? width, height: m.height ?? 0 };
  }

  try {
    const out = await sharp(buffer)
      .resize(width, height, { fit: 'cover', position: sharp.strategy.attention })
      .jpeg({ quality: 92 })
      .toBuffer();
    return { buffer: out, width, height };
  } catch {
    const out = await sharp(buffer)
      .resize(width, height, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 92 })
      .toBuffer();
    return { buffer: out, width, height };
  }
}
