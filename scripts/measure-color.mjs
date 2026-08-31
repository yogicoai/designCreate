// 생성물의 제품 색상을 공식 컬러칩과 ΔE 로 비교한다.
// 사용: node scripts/measure-color.mjs <파일> <목표hex> <left%> <top%> <w%> <h%>
import sharp from 'sharp';

const [file, target, l = 0.72, t = 0.30, w = 0.14, h = 0.14] = process.argv.slice(2);

const toLab = (R, G, B) => {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const [lr, lg, lb] = [f(R), f(G), f(B)];
  let X = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047;
  let Y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722;
  let Z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883;
  const g = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  [X, Y, Z] = [g(X), g(Y), g(Z)];
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
};

const meta = await sharp(file).metadata();
const box = {
  left: Math.round(meta.width * Number(l)), top: Math.round(meta.height * Number(t)),
  width: Math.round(meta.width * Number(w)), height: Math.round(meta.height * Number(h)),
};
const { data, info } = await sharp(file).extract(box).removeAlpha().raw().toBuffer({ resolveWithObject: true });
let r = 0, g = 0, b = 0, n = 0;
for (let i = 0; i < data.length; i += info.channels) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
[r, g, b] = [r / n, g / n, b / n].map(Math.round);
const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
const tc = target.replace('#', '');
const [tr, tg, tb] = [0, 2, 4].map((i) => parseInt(tc.slice(i, i + 2), 16));
const A = toLab(r, g, b), B = toLab(tr, tg, tb);
const dE = Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
console.log(`${file}\n  생성 ${hex}  vs  목표 ${target.toUpperCase()}   ΔE=${dE.toFixed(1)}  ${dE < 5 ? '육안 구분 어려움' : dE < 15 ? '눈에 띄는 차이 (보정 권장)' : '확연히 다름 (보정 필수)'}`);
