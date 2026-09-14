import 'server-only';
import sharp from 'sharp';

/**
 * 배경 사진의 톤을 재서 숫자로 적는다 — 합성 티를 줄이기 위한 것.
 *
 * 왜 재나: "이 공간의 조명에 맞춰라" 는 말만으로는 모델이 참조 제품의 스튜디오 룩(평면광·높은 채도·깨끗한
 * 암부)을 그대로 붙여넣는다 (사용자 지적 2026-09-14 — "너무 AI 합성 느낌"). 흐릿한 지시는 안 지켜지고
 * 숫자로 적은 지시는 지켜진다는 게 이 프로젝트의 규칙이라, 배경의 화이트밸런스·밝기·대비·암부·채도·빛 방향을
 * 실제로 재서 프롬프트에 넣는다. 로컬 계산이라 비용이 없다.
 */

export interface SceneTone {
  /** 프롬프트에 그대로 들어가는 영문 한 줄 */
  summaryEn: string;
  /** 화면·기록용 수치 */
  metrics: { L: number; a: number; b: number; contrast: number; black: number; chroma: number; lr: number; tb: number };
}

const lin = (v: number) => { v /= 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; };
const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
function toLab(r: number, g: number, b: number): [number, number, number] {
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, Y = R * 0.2126 + G * 0.7152 + B * 0.0722, Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

export async function measureSceneTone(url: string): Promise<SceneTone | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const { data, info } = await sharp(Buffer.from(await res.arrayBuffer()))
      .resize(256, 256, { fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height;
    const Ls: number[] = [];
    let sa = 0, sb = 0, sc = 0, left = 0, right = 0, top = 0, bottom = 0, nl = 0, nr = 0, nt = 0, nb = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 3;
      const [L, a, b] = toLab(data[k], data[k + 1], data[k + 2]);
      Ls.push(L); sa += a; sb += b; sc += Math.hypot(a, b);
      if (x < W / 3) { left += L; nl++; } else if (x >= (2 * W) / 3) { right += L; nr++; }
      if (y < H / 3) { top += L; nt++; } else if (y >= (2 * H) / 3) { bottom += L; nb++; }
    }
    const n = Ls.length;
    const mean = Ls.reduce((s, v) => s + v, 0) / n;
    const std = Math.sqrt(Ls.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
    const sorted = [...Ls].sort((p, q) => p - q);
    const black = sorted[Math.floor(n * 0.02)];
    const m = {
      L: +mean.toFixed(0), a: +(sa / n).toFixed(1), b: +(sb / n).toFixed(1), contrast: +std.toFixed(0), black: +black.toFixed(0),
      chroma: +(sc / n).toFixed(0), lr: +((right / nr) - (left / nl)).toFixed(0), tb: +((top / nt) - (bottom / nb)).toFixed(0),
    };

    const wb = m.b > 14 ? 'strongly warm, amber' : m.b > 7 ? 'warm' : m.b < -3 ? 'cool, bluish' : 'neutral';
    const bright = m.L > 72 ? 'bright and airy' : m.L > 55 ? 'medium exposure' : m.L > 40 ? 'dim' : 'dark and moody';
    const contrast = m.contrast < 14 ? 'soft, low contrast' : m.contrast < 22 ? 'moderate contrast' : 'high contrast';
    const blacks = m.black > 20 ? `lifted, faded blacks (the darkest shadows are only about L*${m.black}, never pure black)` : m.black > 10 ? `gentle blacks (darkest shadows about L*${m.black})` : 'deep blacks';
    const sat = m.chroma < 8 ? 'muted, desaturated colours' : m.chroma < 16 ? 'natural, restrained colours' : 'rich, saturated colours';
    /*
     * 빛 방향 — 위아래 밝기 차로 읽으면 실내는 천장·창이 늘 밝아 전부 "위에서" 가 된다 (실측: 창이 정면인 거실).
     * 가장 밝은 3% 픽셀(창·조명)의 무게중심이 곧 광원 위치다.
     */
    const cut = sorted[Math.floor(n * 0.97)];
    let cx = 0, cy = 0, cn = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Ls[y * W + x] >= cut) { cx += x; cy += y; cn++; }
    const hx = cn ? cx / cn / W : 0.5, hy = cn ? cy / cn / H : 0.5;
    const hPos = hx < 0.38 ? 'LEFT' : hx > 0.62 ? 'RIGHT' : 'CENTRE';
    const vPos = hy < 0.4 ? 'upper' : hy > 0.6 ? 'lower' : 'middle';
    const dir = `the brightest light source (window or lamp) sits in the ${vPos} ${hPos} of the frame — ` +
      (hPos === 'CENTRE'
        ? 'subjects in front of it are back-lit: their camera-facing sides fall into soft shade with a warm rim of light on their edges'
        : `light reaches the subjects from the ${hPos === 'LEFT' ? 'left' : 'right'}, leaving their opposite sides in soft shade`);

    return {
      metrics: m,
      summaryEn:
        `${wb} white balance (average b* ${m.b >= 0 ? '+' : ''}${m.b}), ${bright} (average L* ${m.L}), ${contrast} (L* spread ${m.contrast}), ` +
        `${blacks}, ${sat} (average chroma ${m.chroma}); ${dir}`,
    };
  } catch {
    return null;
  }
}
