import sharp from 'sharp';
import type { DesignDoc, DesignLayer } from '@/lib/design-render';

/**
 * 배경 fit(변형·보정)과 블러/모자이크 패치.
 * design 본 라우트와 AI 라우트가 같은 계산을 써야 화면=결과가 유지된다.
 */
export type FitSpec = NonNullable<DesignDoc['fit']>;

export async function fitToSize(
  buf: Buffer, W: number, H: number, fit: FitSpec,
): Promise<Buffer> {
  /*
   * 배경 보정 — 포토샵 방식 편집기의 밝기/대비/채도. CSS filter 와 같은 의미로 맞춘다:
   *   brightness(x) = 선형 곱          → modulate({brightness:x})
   *   saturate(x)   = 채도 곱          → modulate({saturation:x})
   *   contrast(x)   = (v-0.5)*x+0.5    → linear(x, 128*(1-x))
   */
  const adj = fit.adjust;
  if (adj && (adj.brightness ?? 1) * (adj.contrast ?? 1) * (adj.saturate ?? 1) !== 1) {
    let s = sharp(buf);
    if ((adj.brightness ?? 1) !== 1 || (adj.saturate ?? 1) !== 1) {
      s = s.modulate({ brightness: adj.brightness ?? 1, saturation: adj.saturate ?? 1 });
    }
    if ((adj.contrast ?? 1) !== 1) {
      const c = adj.contrast ?? 1;
      s = s.linear(c, 128 * (1 - c));
    }
    buf = await s.toBuffer();
  }

  const meta = await sharp(buf).metadata();
  const sw = meta.width ?? W;
  const sh = meta.height ?? H;

  /*
   * 배경 변형(zoom·위치) — 모든 모드를 한 식으로 통일한다.
   *   기준 배율 baseK: cover=꽉 채움 / 나머지=통째로 들어감(contain)
   *   실제 배율 k = baseK * zoom (cover 는 빈틈이 생기는 1 미만을 막는다)
   *   위치: left = fx*(W-fgW), top = fy*(H-fgH)
   *   → zoom=1 에서 기존 cover(object-position)·contain(중앙) 결과와 정확히 같다.
   */
  const zoomRaw = fit.zoom ?? 1;
  const zoom = fit.mode === 'cover' ? Math.max(1, zoomRaw) : Math.max(0.15, Math.min(4, zoomRaw));
  const baseK = fit.mode === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  const k = baseK * zoom;
  // 가로/세로 개별 변형(Ctrl+T) — zoom 위에 곱한다
  const zx = Math.max(0.15, Math.min(4, fit.zoomX ?? 1));
  const zy = Math.max(0.15, Math.min(4, fit.zoomY ?? 1));
  const fgW = Math.max(1, Math.round(sw * k * zx));
  const fgH = Math.max(1, Math.round(sh * k * zy));
  const fx = Math.max(0, Math.min(1, fit.fx));
  const fy = Math.max(0, Math.min(1, fit.fy));
  const left = Math.round(fx * (W - fgW));
  const top = Math.round(fy * (H - fgH));

  // 바탕 만들기
  let bg: Buffer;
  if (fit.mode === 'blur') {
    bg = await sharp(buf).resize(W, H, { fit: 'cover' })
      .blur(Math.max(8, Math.round(Math.min(W, H) / 22)))
      .modulate({ brightness: 0.82 }).toBuffer();
  } else if (fit.mode === 'color' || fit.mode === 'gradient') {
    const hex = /^#?[0-9a-fA-F]{6}$/.test(fit.fillColor || '') ? fit.fillColor!.replace('#', '') : 'f2f0ec';
    const rgb = { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
    const shift = (c: number, d: number) => Math.max(0, Math.min(255, Math.round(c + d)));
    if (fit.mode === 'gradient') {
      const topC = `rgb(${shift(rgb.r, 22)},${shift(rgb.g, 22)},${shift(rgb.b, 22)})`;
      const botC = `rgb(${shift(rgb.r, -26)},${shift(rgb.g, -26)},${shift(rgb.b, -26)})`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
        + `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">`
        + `<stop offset="0" stop-color="${topC}"/><stop offset="1" stop-color="${botC}"/></linearGradient></defs>`
        + `<rect width="${W}" height="${H}" fill="url(#g)"/></svg>`;
      bg = await sharp(Buffer.from(svg)).png().toBuffer();
    } else {
      bg = await sharp({ create: { width: W, height: H, channels: 3, background: rgb } }).png().toBuffer();
    }
  } else {
    // cover 는 zoom≥1 이라 fg 가 전면을 덮는다 — 바탕은 검정 캔버스면 충분
    bg = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
  }

  // 사진을 배율대로 키운 뒤, 캔버스 밖으로 나가는 부분은 잘라 얹는다
  let fg = await sharp(buf).resize(fgW, fgH).toBuffer();
  const cropL = Math.max(0, -left);
  const cropT = Math.max(0, -top);
  const visW = Math.min(W - Math.max(0, left), fgW - cropL);
  const visH = Math.min(H - Math.max(0, top), fgH - cropT);
  if (visW <= 0 || visH <= 0) {
    // 사진이 캔버스 밖으로 완전히 나간 경우 — 바탕만 돌려준다
    return sharp(bg).jpeg({ quality: 95 }).toBuffer();
  }
  if (cropL > 0 || cropT > 0 || visW < fgW || visH < fgH) {
    fg = await sharp(fg).extract({ left: cropL, top: cropT, width: visW, height: visH }).toBuffer();
  }
  return sharp(bg).composite([{ input: fg, left: Math.max(0, left), top: Math.max(0, top) }])
    .jpeg({ quality: 95 }).toBuffer();
}

/**
 * 영역 블러/모자이크 — 배경 래스터에 직접 적용한다.
 * SVG(librsvg)에는 backdrop-filter 가 없어서 합성 전에 sharp 로 굽는다.
 * 배경 사진 전용이다 — 위에 얹힌 텍스트·이미지 레이어는 흐려지지 않는다
 * (용도가 얼굴·번호판 가리기라 배경에만 걸리는 게 맞다).
 */
export async function applyPatches(buf: Buffer, W: number, H: number, layers: DesignLayer[]): Promise<Buffer> {
  const patches = layers.filter((l) => l.kind === 'blurpatch' && !l.hidden);
  if (!patches.length) return buf;
  const base = await sharp(buf).jpeg({ quality: 98 }).toBuffer();
  const comps: { input: Buffer; left: number; top: number }[] = [];
  for (const l of patches) {
    let w = Math.round((l.w ?? 0.3) * W);
    let h = Math.round((l.h ?? 0.2) * H);
    let left = Math.round((l.x ?? 0.5) * W - w / 2);
    let top = Math.round((l.y ?? 0.5) * H - h / 2);
    // 캔버스 밖으로 나간 부분은 잘라낸다
    if (left < 0) { w += left; left = 0; }
    if (top < 0) { h += top; top = 0; }
    w = Math.min(w, W - left); h = Math.min(h, H - top);
    if (w <= 3 || h <= 3) continue;
    const region = await sharp(base).extract({ left, top, width: w, height: h }).toBuffer();
    const s = Math.max(0, Math.min(1, l.strength ?? 0.5));
    let eff: Buffer;
    if (l.effect === 'mosaic') {
      // 셀 크기: 영역 짧은 변의 3~15% — 강도가 셀을 키운다
      const cell = Math.max(4, Math.round(Math.min(w, h) * (0.03 + s * 0.12)));
      eff = await sharp(region)
        .resize(Math.max(1, Math.round(w / cell)), Math.max(1, Math.round(h / cell)), { kernel: 'nearest' })
        .resize(w, h, { kernel: 'nearest' })
        .toBuffer();
    } else {
      eff = await sharp(region).blur(Math.max(1, (s * Math.min(w, h)) / 6)).toBuffer();
    }
    comps.push({ input: eff, left, top });
  }
  if (!comps.length) return buf;
  return sharp(base).composite(comps).jpeg({ quality: 95 }).toBuffer();
}

