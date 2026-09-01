/**
 * 생성 컷의 봉제 태그 자리에 진짜 요기보 로고를 얹는다 (후보정).
 *
 * 왜 필요한가:
 *   태그는 2000px 이미지에서 가로 50px 남짓이다. 그 크기에서 워드마크의 글자 형태를
 *   유지할 수 있는 생성 모델은 없다 — 실측으로 "yogibo" 가 "qo ㅕo" 로 뭉개졌다.
 *   뭉개진 로고는 로고가 없는 것보다 브랜드에 해롭다.
 *   그래서 생성은 무지 태그로 두고(프롬프트 규칙), 로고는 여기서 얹는다.
 *
 * 하는 일:
 *   1) 태그의 **밝은 픽셀만** 골라 그 평균색으로 덮어 뭉개진 글자를 지운다
 *      (흐리게 처리하면 어두운 글자가 번질 뿐 지워지지 않는다 — 실측으로 확인)
 *   2) 덮개를 태그와 같은 각도로 회전시킨다
 *      (축 정렬 도형으로 덮으면 기울어진 태그를 벗어나 원단 위에 얼룩이 남는다)
 *   3) 로고를 같은 크기·각도로 얹는다
 *
 * 판단 기준: 확대해서 보지 말고 **실제 표시 크기**로 볼 것.
 * 태그는 2000px 배너에서 50px 남짓이라, 3배 확대하면 없던 결함이 보인다.
 *
 * 사용:
 *   node scripts/stamp-logo.mjs <입력> <출력> --cx 0.577 --cy 0.718 --w 0.026 --angle -35
 *     --cx/--cy  태그 중심 (이미지 대비 비율 0~1)
 *     --w        로고 너비 (이미지 가로 대비 비율)
 *     --angle    기울기(도). 음수 = 반시계
 *     --clean    태그 덮기 크기 배수 (기본 1.35, 0 이면 덮지 않고 로고만)
 *     --opacity  로고 불투명도 (기본 0.92 — 완전 불투명하면 스티커처럼 뜬다)
 *     --logo     로고 파일/URL (기본: 요기보 공식 로고)
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const LOGO_URL = 'https://yogibo.kr/web/img/icon/logo3_on.png';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('사용: node scripts/stamp-logo.mjs <입력> <출력> --cx 0.5 --cy 0.7 --w 0.03 --angle -35');
  process.exit(1);
}
const flag = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const cx = Number(flag('cx', 0.5));
const cy = Number(flag('cy', 0.5));
const wRatio = Number(flag('w', 0.03));
const angle = Number(flag('angle', 0));
const cleanScale = Number(flag('clean', 1.35));
const opacity = Number(flag('opacity', 0.92));
const logoSrc = flag('logo', LOGO_URL);

async function loadLogo(src) {
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`로고를 못 받았습니다 (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.readFileSync(src);
}

const base = sharp(fs.readFileSync(inPath));
const meta = await base.metadata();
const W = meta.width, H = meta.height;
const cxPx = Math.round(W * cx);
const cyPx = Math.round(H * cy);
const logoW = Math.max(8, Math.round(W * wRatio));

const layers = [];

/*
 * 1) 태그 덮기.
 *    뭉개진 글자를 지우려면 그 자리를 태그 색으로 덮어야 한다. 단색 사각형을 그대로 얹으면
 *    경계가 보이므로, 태그 주변을 크게 떠서 흐리게 만든 뒤 그걸 덮개로 쓴다.
 *    태그의 원단 톤과 음영이 자연히 따라온다.
 */
if (cleanScale > 0) {
  const cw = Math.round(logoW * cleanScale);
  const ch = Math.round(cw * 0.55);
  const sx = Math.max(0, Math.min(W - cw, cxPx - Math.round(cw / 2)));
  const sy = Math.max(0, Math.min(H - ch, cyPx - Math.round(ch / 2)));
  /*
   * 흐리게 처리하면 안 된다 — 어두운 글자가 번질 뿐 지워지지 않고, 로고 글자 사이로 비친다.
   * 태그에서 **밝은 픽셀만** 골라 그 평균색으로 채워야 글자가 실제로 사라진다.
   */
  const { data: px, info } = await sharp(fs.readFileSync(inPath))
    .extract({ left: sx, top: sy, width: cw, height: ch })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch3 = info.channels;
  const lum = [];
  for (let i = 0; i < info.width * info.height; i++) {
    const r = px[i * ch3], g = px[i * ch3 + 1], b = px[i * ch3 + 2];
    lum.push([0.299 * r + 0.587 * g + 0.114 * b, r, g, b]);
  }
  lum.sort((a, b) => b[0] - a[0]);
  const take = Math.max(1, Math.floor(lum.length * 0.25)); // 상위 25% = 글자 없는 원단
  let R = 0, G = 0, B = 0;
  for (let i = 0; i < take; i++) { R += lum[i][1]; G += lum[i][2]; B += lum[i][3]; }
  R = Math.round(R / take); G = Math.round(G / take); B = Math.round(B / take);
  const patch = await sharp({
    create: { width: cw, height: ch, channels: 3, background: { r: R, g: G, b: B } },
  }).png().toBuffer();
  /*
   * 덮개는 태그와 같은 각도로 기울어야 한다.
   * 축에 정렬된 타원으로 덮으면 기울어진 태그를 벗어나 원단 위로 흰 얼룩이 번진다.
   * 그래서 둥근 사각형 마스크를 만들고 로고와 같은 각도로 회전시킨다.
   */
  const rx = Math.round(Math.min(cw, ch) * 0.18);
  const mask = Buffer.from(
    `<svg width="${cw}" height="${ch}"><rect x="0" y="0" width="${cw}" height="${ch}" rx="${rx}" ry="${rx}" fill="white"/></svg>`,
  );
  const soft = await sharp(patch)
    .composite([{ input: mask, blend: 'dest-in' }])
    .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .blur(0.8)
    .png()
    .toBuffer();
  const sm = await sharp(soft).metadata();
  layers.push({
    input: soft,
    left: Math.max(0, cxPx - Math.round(sm.width / 2)),
    top: Math.max(0, cyPx - Math.round(sm.height / 2)),
  });
}

// 2) 로고 — 크기·기울기를 맞추고 살짝 투명하게 (완전 불투명하면 스티커처럼 뜬다)
const logoRaw = await loadLogo(logoSrc);
const logo = await sharp(logoRaw)
  .resize({ width: logoW })
  .ensureAlpha()
  .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .composite([
    {
      input: Buffer.from([255, 255, 255, Math.round(opacity * 255)]),
      raw: { width: 1, height: 1, channels: 4 },
      tile: true,
      blend: 'dest-in',
    },
  ])
  .png()
  .toBuffer();

const lm = await sharp(logo).metadata();
layers.push({
  input: logo,
  left: Math.max(0, cxPx - Math.round(lm.width / 2)),
  top: Math.max(0, cyPx - Math.round(lm.height / 2)),
});

const ext = path.extname(outPath).toLowerCase();
let out = sharp(fs.readFileSync(inPath)).composite(layers);
out = ext === '.png' ? out.png() : out.jpeg({ quality: 95 });
await out.toFile(outPath);

console.log(`로고 합성 완료: ${outPath}`);
console.log(`  이미지 ${W}x${H} · 태그 중심 (${cxPx}, ${cyPx}) · 로고 폭 ${logoW}px · 기울기 ${angle}°`);
