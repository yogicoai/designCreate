// 폰트 등록이 sharp 의 첫 글자 렌더보다 먼저여야 한다 — 반드시 첫 import 로 둔다
import '@/lib/fonts';
import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { getDb, COLLECTIONS } from '@/lib/db';
import { uploadBuffer, dailySubpath, ftpConfigured } from '@/lib/ftp';
import { renderLayersToSvg, textEm, type DesignDoc, type DesignLayer } from '@/lib/design-render';
import { shapeOf, findSize, type BannerShape } from '@/lib/banner-sizes';

/**
 * 배너 디자인 생성 — 이미지 위에 텍스트를 얹어 완성본을 만든다.
 *
 * 왜 필요한가:
 *   생성 모델은 글자를 그림으로 그려서 반드시 뭉갠다 (로고 태그에서 확인).
 *   글자는 실제 폰트로 찍어야 한다. 그래서 이미지 생성과 텍스트 합성을 나눈다.
 *
 * 순서가 중요하다: **규격 → 배경 맞추기 → 배치**.
 * 배너는 걸릴 자리가 먼저 정해지는 물건이라, 1920x600 웹 배너와 1080x1920
 * 스토리는 같은 문구라도 배치가 달라야 한다.
 *
 * 화면에서는 같은 SVG 를 미리 그리고, 저장할 때 여기서 다시 그린다.
 * 두 렌더러가 같은 숫자(0~1 비율)를 읽기 때문에 화면에서 본 그대로 저장된다.
 *
 * GET                        저장된 내 템플릿 목록
 * POST { auto }              규격을 보고 1차 배치를 잡아준다
 * POST { design, save }      렌더 → 미리보기(base64) 또는 FTP 저장 + 갤러리 등록
 * PUT  { name, design }      템플릿으로 저장
 * DELETE { id }              템플릿 삭제
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 배경 컷을 배너 규격에 맞춘다.
 *
 * 컷은 대개 1:1 로 생성되는데 배너는 1920x600 처럼 납작하거나 1080x1920 처럼
 * 길쭉하다. 그냥 늘리면 사람이 찌그러지므로 둘 중 하나를 골라야 한다.
 *
 *   cover  꽉 채우고 넘치는 부분을 잘라낸다. fx/fy 로 어디를 남길지 정한다.
 *          (0.5/0.5 = 가운데. 인물이 아래쪽이면 fy 를 올린다)
 *   blur   자기 자신을 흐리게 깐 위에 통째로 얹는다. 하나도 잘리지 않지만
 *          좌우에 흐린 띠가 생긴다 — 세로 컷을 가로 배너에 쓸 때 쓸 만하다.
 *
 * 화면 미리보기는 CSS object-fit/object-position 으로 같은 계산을 한다.
 */
async function fitToSize(
  buf: Buffer, W: number, H: number,
  fit: { mode: 'cover' | 'blur' | 'color' | 'gradient'; fx: number; fy: number; fillColor?: string },
): Promise<Buffer> {
  const meta = await sharp(buf).metadata();
  const sw = meta.width ?? W;
  const sh = meta.height ?? H;

  if (fit.mode === 'blur') {
    // 흐린 배경은 잘라서 채우고, 그 위에 원본을 통째로 얹는다
    const bg = await sharp(buf).resize(W, H, { fit: 'cover' })
      .blur(Math.max(8, Math.round(Math.min(W, H) / 22)))
      .modulate({ brightness: 0.82 }).toBuffer();
    const fg = await sharp(buf).resize(W, H, { fit: 'inside' }).toBuffer();
    const fm = await sharp(fg).metadata();
    return sharp(bg).composite([{
      input: fg,
      left: Math.round((W - (fm.width ?? W)) / 2),
      top: Math.round((H - (fm.height ?? H)) / 2),
    }]).jpeg({ quality: 95 }).toBuffer();
  }

  if (fit.mode === 'color' || fit.mode === 'gradient') {
    /*
     * 줄여 넣기(contain) + 여백 채우기. 색값 하나로 서버·미리보기가 똑같이 그린다.
     * gradient 는 그 색을 위는 살짝 밝게 아래는 살짝 어둡게 세로 그라데이션 —
     * 사진이 배경으로 자연스럽게 녹아든다.
     */
    const hex = /^#?[0-9a-fA-F]{6}$/.test(fit.fillColor || '') ? fit.fillColor!.replace('#', '') : 'f2f0ec';
    const rgb = { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
    const shift = (c: number, d: number) => Math.max(0, Math.min(255, Math.round(c + d)));
    let bg: Buffer;
    if (fit.mode === 'gradient') {
      const top = `rgb(${shift(rgb.r, 22)},${shift(rgb.g, 22)},${shift(rgb.b, 22)})`;
      const bot = `rgb(${shift(rgb.r, -26)},${shift(rgb.g, -26)},${shift(rgb.b, -26)})`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
        + `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">`
        + `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bot}"/></linearGradient></defs>`
        + `<rect width="${W}" height="${H}" fill="url(#g)"/></svg>`;
      bg = await sharp(Buffer.from(svg)).png().toBuffer();
    } else {
      bg = await sharp({ create: { width: W, height: H, channels: 3, background: rgb } }).png().toBuffer();
    }
    const fg = await sharp(buf).resize(W, H, { fit: 'inside' }).toBuffer();
    const fm = await sharp(fg).metadata();
    return sharp(bg).composite([{
      input: fg,
      left: Math.round((W - (fm.width ?? W)) / 2),
      top: Math.round((H - (fm.height ?? H)) / 2),
    }]).jpeg({ quality: 95 }).toBuffer();
  }

  // cover — 배율을 맞춘 뒤 fx/fy 위치에서 잘라낸다
  const k = Math.max(W / sw, H / sh);
  const rw = Math.max(W, Math.round(sw * k));
  const rh = Math.max(H, Math.round(sh * k));
  const resized = await sharp(buf).resize(rw, rh).toBuffer();
  return sharp(resized).extract({
    left: Math.round((rw - W) * Math.max(0, Math.min(1, fit.fx))),
    top: Math.round((rh - H) * Math.max(0, Math.min(1, fit.fy))),
    width: W, height: H,
  }).jpeg({ quality: 95 }).toBuffer();
}

/**
 * 배경의 '어디가 비었나'를 잰다.
 *
 * 32x32 로 줄여서 후보 영역의 밝기(mean)와 복잡도(sd)를 본다.
 * 복잡도는 표준편차 — 하늘·벽처럼 고른 면은 낮고, 인물·소품이 있으면 높다.
 * 낮은 곳에 글자를 놓아야 인물 위에 안 겹친다.
 */
async function analyzeRegions(buf: Buffer) {
  // 컬러로 받는다 — 밝기·복잡도 외에 채도도 재야 한다 (강한 원색 배경 판별)
  const { data, info } = await sharp(buf).removeAlpha().resize(32, 32, { fit: 'fill' })
    .raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const px = (x: number, y: number) => {
    const i = (y * info.width + x) * ch;
    return [data[i], data[i + 1], data[i + 2]] as const;
  };
  const stat = (x0: number, y0: number, x1: number, y1: number) => {
    const v: number[] = [];
    /*
     * 채도는 픽셀별로 재서 평균한다. 평균색의 채도로 재면 청록 벽에
     * 흰 선반·액자가 섞이는 순간 평균이 회색으로 물타기돼 "색이 강한
     * 배경"이 안 걸렸다 (실측). 픽셀별 평균은 섞임에 훨씬 강하다.
     */
    let satSum = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const [pr, pg, pb] = px(x, y);
        const mx = Math.max(pr, pg, pb);
        satSum += mx === 0 ? 0 : (mx - Math.min(pr, pg, pb)) / mx;
        v.push(0.299 * pr + 0.587 * pg + 0.114 * pb);
      }
    }
    const n = v.length;
    const mean = v.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    return { mean, sd, sat: satSum / n };
  };
  // 사진에서 가장 넓게 쓰인 색 — 버튼 색을 여기서 가져온다
  const { dominant } = await sharp(buf).stats();
  return {
    top: stat(0, 0, 32, 11),
    bottom: stat(0, 21, 32, 32),
    left: stat(0, 4, 14, 28),
    right: stat(18, 4, 32, 28),
    dominant,
  };
}

/**
 * 글자색을 밝기 세 구간으로 나눈다.
 *
 * 실제 자사몰 배너를 보면 중간톤 배경에서 **제목만 흰색**이고 작은 글씨는 짙다.
 * 제목은 덩치가 커서 대비가 좀 모자라도 읽히고 흰색이 눈에 먼저 걸리는 반면,
 * 작은 글씨를 흰색으로 하면 중간톤 위에서 뭉개진다.
 * 한 가지 색으로 통일하면 이 맛이 안 난다.
 */
function inkOf(mean: number, sat = 0) {
  /*
   * 색이 강한 배경(채도 있는 색 벽·원색 빈백)은 밝기가 어중간해도
   * 짙은 글씨가 탁해 보인다 — 전부 흰 글씨가 정답이다 (사용자 요청).
   * 임계 0.16 (픽셀별 채도 평균 기준): 크림·모브 배경(0.05~0.13)은 안
   * 걸리고, 청록 벽에 소품이 섞인 영역(~0.2)과 원색·우드톤은 걸린다.
   * 처음엔 평균색 채도 0.35 로 잡았더니 청록 벽에서 작은 글씨가 짙게
   * 나와 사용자가 흰색을 다시 요청했다 — 측정 방식째 바꿨다.
   */
  if (sat > 0.16 && mean < 205) return { title: '#ffffff', small: '#f1eee8', scrim: '#000000', mid: false };
  if (mean < 120) return { title: '#ffffff', small: '#e9e6e1', scrim: '#000000', mid: false };
  if (mean > 190) return { title: '#1b1d21', small: '#4a4f57', scrim: '#ffffff', mid: false };
  return { title: '#ffffff', small: '#2a2c30', scrim: '#ffffff', mid: true };
}

/**
 * 버튼 색을 사진에서 가져온다 — 참고 배너들이 전부 사진 속 색을 쓴다.
 * 흰 글씨가 읽혀야 하므로 너무 밝으면 눌러서 쓴다.
 */
function pillFrom(c: { r: number; g: number; b: number } | undefined) {
  if (!c) return '#2f3a5c';
  const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  const k = lum > 140 ? 140 / lum : 1;
  const hex = (v: number) => Math.round(Math.max(0, Math.min(255, v * k))).toString(16).padStart(2, '0');
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

/**
 * 1차 배치를 잡는다.
 *
 * 규격의 비율에 따라 완전히 다른 배치를 쓴다:
 *   wide   가로로 길다 → 문구를 한쪽 옆에 세운다. 위아래로 쌓으면 눌린다.
 *   tall   세로로 길다 → 위나 아래에 크게 쌓고 반대쪽 끝에 버튼을 둔다.
 *   square 정사각     → 비어 있는 위/아래에 쌓는다.
 *
 * 글자 크기는 '원하는 비율'과 '캔버스를 안 뚫는 최대치' 중 작은 쪽을 쓴다.
 * 긴 제목이 알아서 줄어들기 때문에 쓰는 사람이 크기를 만질 일이 줄어든다.
 *
 * 글자 외곽 그림자는 기본으로 끈다. 자사몰 배너는 판판한 글씨가 깔끔하고,
 * 읽히게 만드는 일은 그늘(scrim)이 맡는다 — 배경이 복잡할수록 그늘이 짙어진다.
 * 그래도 묻히면 4단계에서 레이어별로 켤 수 있다.
 */
function buildAuto(
  shape: BannerShape,
  reg: Awaited<ReturnType<typeof analyzeRegions>>,
  W: number, H: number,
  txt: { eyebrow: string; title: string; subtitle: string; cta: string },
  content?: number,
  buttonHex?: string,                                  // 브랜드색 지정 — 없으면 사진에서 뽑는다
  tune?: { scale?: number; gap?: number },             // 문구 크기·줄 간격 배율 (기본 1 = 실측값)
) {
  const S = Math.min(W, H);
  /*
   * 배치 숫자는 실제 자사몰 배너 실측이 기본값이지만, 컷과 문구에 따라
   * 취향이 갈려서 배율로 조절할 수 있게 열어둔다 — "고정을 수정 가능하게".
   */
  const k = Math.max(0.5, Math.min(2, tune?.scale ?? 1));   // 문구 크기 배율
  const g = Math.max(0.5, Math.min(2, tune?.gap ?? 1));     // 줄 간격 배율
  /** 원하는 크기와 폭 제한 중 작은 쪽. 반환값은 짧은 변 대비 비율 */
  const fitText = (str: string, want: number, availFrac: number) =>
    Math.min(want, (availFrac * W) / (textEm(str) * S));

  const layers: DesignLayer[] = [];
  let where: string;
  let light: boolean;
  let sd: number;

  if (shape === 'wide') {
    // 비어 있는 쪽에 문구를 세운다
    const side = reg.left.sd <= reg.right.sd ? 'left' : 'right';
    const r = side === 'left' ? reg.left : reg.right;
    where = side === 'left' ? '왼쪽' : '오른쪽';
    light = r.mean > 140;
    sd = r.sd;
    /*
     * 글자가 시작하는 자리. 본문 폭이 정해진 규격(1910 안의 1300)이면
     * 캔버스 끝이 아니라 본문 왼쪽 모서리에 맞춘다 — 그래야 페이지의
     * 다른 요소와 줄이 맞는다. 본문 폭이 없으면 캔버스 기준 6%.
     */
    const marginX = content && content < W ? (W - content) / 2 / W : 0.06;
    const colFrac = content && content < W ? (content * 0.55) / W : 0.42;
    const x = side === 'left' ? marginX : 1 - marginX;
    const align = side === 'left' ? ('start' as const) : ('end' as const);
    const ink = inkOf(r.mean, r.sat);
    const strong = ink.title;
    const soft = ink.small;

    /*
     * 그늘(scrim)은 처음엔 깔지 않는다 (사용자 결정) — 실제 자사몰 배너는
     * 사진 위에 바로 글자를 얹고, 색 규칙(inkOf)이 읽히게 만든다.
     * 배경이 복잡해 묻히면 5단계에서 그늘을 손으로 추가하면 된다.
     */

    /*
     * 제목을 축으로 세 줄을 바짝 붙인다 (사용자: "간격이 넓다" 반복).
     * 제목 폰트가 짧은 변의 0.11(675 에서 74px)이라 줄 중심 간격은 그
     * 절반 남짓이면 충분하다 — 눈썹 -0.10 / 혜택 +0.115 로 잡았다.
     * 버튼만 아래(0.85)로 떨어뜨려 문구 덩어리와 분리한다.
     * g(줄 간격)·k(크기) 배율은 제목을 축으로 이 간격을 늘리고 줄인다.
     */
    const hasEye = !!txt.eyebrow;
    const ty = hasEye ? 0.40 : 0.36;
    // 눈썹과 혜택 줄은 작아서 흰색이면 중간톤 위에서 뭉갠다 — 제목만 흰색으로 둔다
    if (hasEye) layers.push({
      id: 'auto-eyebrow', kind: 'text', x, y: ty - 0.10 * g, text: txt.eyebrow,
      size: fitText(txt.eyebrow, 0.055 * k, colFrac), weight: 600, tracking: 0.01,
      lineHeight: 1.25, align, color: soft, opacity: 1, shadow: false, curve: 0,
    });
    if (txt.title) layers.push({
      id: 'auto-title', kind: 'text', x, y: ty, text: txt.title,
      size: fitText(txt.title, (hasEye ? 0.110 : 0.135) * k, colFrac), weight: 800, tracking: -0.015,
      lineHeight: 1.15, align, color: strong,
      opacity: 1, shadow: false, curve: 0,
    });
    if (txt.subtitle) layers.push({
      id: 'auto-sub', kind: 'text', x, y: ty + 0.115 * g, text: txt.subtitle,
      size: fitText(txt.subtitle, (hasEye ? 0.049 : 0.055) * k, colFrac), weight: 500, tracking: 0.03,
      lineHeight: 1.3, align, color: soft,
      opacity: 1, shadow: false, curve: 0,
    });
    if (txt.cta) {
      const cs = fitText(txt.cta, (hasEye ? 0.044 : 0.05) * k, colFrac * 0.8);
      // 화살표 자리까지 세어서 알약 폭을 잡는다
      const pw = ((textEm(txt.cta) + 3.2) * cs * S) / W;
      const px = side === 'left' ? marginX + pw / 2 : 1 - marginX - pw / 2;
      const cy = Math.min(0.88, 0.85);   // 버튼은 문구 덩어리에서 떨어뜨려 아래쪽에 고정
      const on = '#ffffff';
      layers.push({
        id: 'auto-pill', kind: 'rect', group: 'cta', x: px, y: cy, w: pw, h: (cs * S * 2.4) / H,
        color: buttonHex ?? pillFrom(reg.dominant), opacity: 0.95, radius: 10 / S,   // 모서리는 규격이 달라도 10px — 사이트 버튼과 같은 값
      });
      layers.push({
        id: 'auto-cta', kind: 'text', group: 'cta', x: px - (cs * S * 0.6) / W, y: cy, text: txt.cta, size: cs,
        weight: 600, tracking: 0.01, align: 'middle',
        color: on, opacity: 1, shadow: false, curve: 0,
      });
      layers.push({
        id: 'auto-cta-arrow', kind: 'icon', group: 'cta', x: px + pw / 2 - (cs * S * 0.9) / W, y: cy,
        icon: 'arrow', size: cs * 0.95, stroke: 0.13, color: on, opacity: 1,
      });
    }
  } else {
    // 정사각·세로형 — 비어 있는 위/아래에 쌓는다
    const topSide = reg.top.sd <= reg.bottom.sd;
    const r = topSide ? reg.top : reg.bottom;
    where = topSide ? '위쪽' : '아래쪽';
    light = r.mean > 140;
    sd = r.sd;
    /*
     * 간격과 크기는 실제 모바일 배너(480x558)를 재서 맞췄다.
     * 눈썹 0.168 · 제목 0.245 · 혜택 0.34 · 버튼 0.87 (세로 비율)
     * 문구를 위에 쌓고 버튼은 반대쪽 끝에 둔다.
     */
    const big = shape === 'tall';                       // 세로형은 더 크게 — 멀리서 본다
    const gap = (big ? 0.070 : 0.095) * g;              // 제목 → 혜택
    const eyeGap = (big ? 0.056 : 0.077) * g;           // 눈썹 → 제목
    const hasEye = !!txt.eyebrow;
    /*
     * 위 자리도 사용자 배치를 따라 올렸다 (웹과 같은 폭 -0.065).
     * 모바일 스크린샷은 잘린 크롭이라 정확 좌표를 못 읽었다 — 화면에서 잡은
     * 배치를 저장해주면 그 좌표를 그대로 기본값으로 옮길 것.
     */
    const y0 = topSide
      ? (hasEye ? (big ? 0.15 : 0.18) : (big ? 0.11 : 0.13))
      : (hasEye ? (big ? 0.76 : 0.79) : (big ? 0.80 : 0.84));
    const ink = inkOf(r.mean, r.sat);
    const strong = ink.title;
    const soft = ink.small;

    // 그늘은 처음엔 깔지 않는다 — 가로형과 같은 이유 (사용자 결정)
    if (hasEye) layers.push({
      id: 'auto-eyebrow', kind: 'text', x: 0.5, y: y0 - eyeGap, text: txt.eyebrow,
      size: fitText(txt.eyebrow, (big ? 0.034 : 0.030) * k, 0.82), weight: 600, tracking: 0.02,
      lineHeight: 1.25, align: 'middle', color: soft, opacity: 1, shadow: false, curve: 0,
    });
    if (txt.title) layers.push({
      id: 'auto-title', kind: 'text', x: 0.5, y: y0, text: txt.title,
      size: fitText(txt.title, (big ? 0.095 : 0.075) * k, 0.86), weight: 800, tracking: -0.01,
      lineHeight: 1.2, align: 'middle', color: strong,
      opacity: 1, shadow: false, curve: 0,
    });
    if (txt.subtitle) layers.push({
      id: 'auto-sub', kind: 'text', x: 0.5, y: y0 + gap, text: txt.subtitle,
      size: fitText(txt.subtitle, (big ? 0.032 : 0.028) * k, 0.82), weight: 500, tracking: 0.02,
      lineHeight: 1.3, align: 'middle', color: soft,
      opacity: 1, shadow: false, curve: 0,
    });
    if (txt.cta) {
      const cs = fitText(txt.cta, (big ? 0.032 : 0.028) * k, 0.7);
      // 화살표 자리까지 세어서 알약 폭을 잡는다 (가로형과 같은 규칙)
      const pw = Math.min(0.9, ((textEm(txt.cta) + 3.2) * cs * S) / W);
      const cy = topSide ? (big ? 0.9 : 0.87) : (big ? 0.10 : 0.13);
      const on = '#ffffff';
      layers.push({
        id: 'auto-pill', kind: 'rect', group: 'cta', x: 0.5, y: cy, w: pw,
        h: (cs * S * 2.6) / H, color: buttonHex ?? pillFrom(reg.dominant), opacity: 0.95, radius: 10 / S,   // 모서리는 규격이 달라도 10px — 사이트 버튼과 같은 값
      });
      layers.push({
        id: 'auto-cta', kind: 'text', group: 'cta', x: 0.5 - (cs * S * 0.6) / W, y: cy, text: txt.cta, size: cs,
        weight: 600, tracking: 0.01, align: 'middle',
        color: on, opacity: 1, shadow: false, curve: 0,
      });
      layers.push({
        id: 'auto-cta-arrow', kind: 'icon', group: 'cta', x: 0.5 + pw / 2 - (cs * S * 0.9) / W, y: cy,
        icon: 'arrow', size: cs * 0.95, stroke: 0.13, color: on, opacity: 1,
      });
    }
  }

  return { layers, picked: { where, light, sd: Math.round(sd), shape } };
}

/** 배경 이미지를 받아온다 (cafe24 공개 URL) */
async function fetchImage(url: string) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`배경 이미지를 못 받았습니다 (HTTP ${res.status})`);
  // Buffer<ArrayBufferLike> — sharp 가 돌려주는 것을 다시 담아야 해서 기본 제네릭으로 둔다
  const buf: Buffer = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(buf).metadata();
  return { buf, srcW: meta.width ?? 1000, srcH: meta.height ?? 1000 };
}

/**
 * 피사체(대개 인물)가 어디쯤인지 어림한다.
 *
 * 얼굴 인식까지는 없어도, "복잡한 곳의 무게중심"이면 자르기 사고를 대부분
 * 막는다 — 인물·제품이 있는 곳은 밝기가 요동치고, 벽·바닥은 고르기 때문이다.
 * 32x32 그레이스케일에서 이웃과의 밝기 차이를 무게로 쓴 무게중심 (0~1).
 */
async function subjectCenter(buf: Buffer) {
  const { data, info } = await sharp(buf).removeAlpha().resize(32, 32, { fit: 'fill' })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => data[y * info.width + x];
  let wsum = 0;
  let cx = 0;
  let cy = 0;
  for (let y = 1; y < 31; y++) {
    for (let x = 1; x < 31; x++) {
      const g = Math.abs(at(x, y) - at(x - 1, y)) + Math.abs(at(x, y) - at(x, y - 1));
      wsum += g; cx += g * x; cy += g * y;
    }
  }
  if (!wsum) return { cx: 0.5, cy: 0.5 };
  return { cx: cx / wsum / 32, cy: cy / wsum / 32 };
}

/**
 * 잘라내기(cover)에서 피사체가 창 가운데에 오는 fx/fy 를 구한다.
 * 사람 사진은 머리 쪽이 잘리면 못 쓰므로 세로는 살짝 위로 당긴다.
 */
function focusFor(srcW: number, srcH: number, W: number, H: number, cx: number, cy: number) {
  const k = Math.max(W / srcW, H / srcH);
  const visX = W / k / srcW;                          // 원본에서 보이는 가로 비중
  const visY = H / k / srcH;
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const fx = visX >= 1 ? 0.5 : clamp((cx - visX / 2) / (1 - visX));
  const fy = visY >= 1 ? 0.5 : clamp((cy - 0.06 - visY / 2) / (1 - visY));
  return { fx: Math.round(fx * 100) / 100, fy: Math.round(fy * 100) / 100 };
}

/** 배경 컷을 받아 규격에 맞춘 버퍼와 최종 크기를 돌려준다 */
async function prepareBase(design: Pick<DesignDoc, 'imageUrl' | 'size' | 'fit'>) {
  const { buf: raw, srcW, srcH } = await fetchImage(design.imageUrl);
  let buf = raw;
  const W = design.size?.w ?? srcW;
  const H = design.size?.h ?? srcH;
  if (W !== srcW || H !== srcH) {
    buf = await fitToSize(buf, W, H, design.fit ?? { mode: 'cover', fx: 0.5, fy: 0.5 });
  }
  return { buf, W, H, srcW, srcH };
}

export async function GET() {
  try {
    const db = await getDb();
    const docs = await db.collection(COLLECTIONS.designTemplates)
      .find({}).sort({ updatedAt: -1 }).limit(100).toArray();
    return NextResponse.json({
      ok: true,
      templates: docs.map((d) => ({
        id: String(d._id), name: d.name, design: d.design,
        updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

/** 렌더된 배너를 FTP 에 올리고 갤러리(cuts)에 등록한다 — 단건 저장과 짝 저장이 같이 쓴다 */
async function saveRendered(
  out: Buffer, design: DesignDoc, W: number, H: number, title: string,
  extra: Record<string, unknown> = {},
) {
  const iso = new Date().toISOString();
  const stamp = iso.replace(/[-:T]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 7);
  const url = await uploadBuffer(dailySubpath(iso), `design_${stamp}_${rand}.jpg`, out);

  const db = await getDb();
  const now = new Date(iso);
  const ins = await db.collection(COLLECTIONS.cuts).insertOne({
    line: '', colorKey: '', colorName: '', hex: '',
    url, title: title.slice(0, 120),
    spec: `배너 · ${design.size?.id ?? '원본 크기'} · ${W}×${H}`,
    recipe: { talentCodes: [] },
    source: 'imgcreate' as const,
    promptMode: 'manual',
    aiModel: 'design-composer',
    provider: 'design',
    sizeValue: `${W}x${H}`, sizeLabel: '배너 디자인', aspect: `${W}:${H}`,
    // 어떤 컷 위에 얹었는지 남긴다 — 나중에 원본을 되찾을 수 있어야 한다
    inputImages: [{ kind: 'base' as const, title: '배경 컷', url: design.imageUrl, role: 'base' }],
    direction: '', width: W, height: H,
    deltaE: null, measuredHex: null, note: '',
    design,                                   // 그대로 다시 열어 편집할 수 있게 통째로 남긴다
    hidden: false, createdAt: now, updatedAt: now,
    ...extra,
  });
  return { url, id: String(ins.insertedId) };
}

export async function POST(req: Request) {
  try {
    interface AutoTexts { eyebrow?: string; title: string; subtitle?: string; cta?: string }
    const body = (await req.json()) as {
      design?: DesignDoc; save?: boolean; title?: string;
      /** 수정으로 연 배너의 원본 id — 계보를 이으려면 저장 때 같이 온다 */
      sourceId?: string;
      /** 웹·모바일을 각각 손본 뒤 짝으로 묶어 저장할 때 — 클라이언트가 만든 묶음 표식 */
      pairId?: string;
      auto?: AutoTexts & {
        imageUrl: string;
        size?: { id?: string; w: number; h: number };
        fit?: { mode: 'cover' | 'blur' | 'color' | 'gradient'; fx: number; fy: number; fillColor?: string };
        /** true 면 잘라내기 위치를 피사체에 맞춰 서버가 정한다 */
        autoFocus?: boolean;
        /** 브랜드 버튼색 (hex). 없으면 사진에서 뽑는다 */
        buttonColor?: string;
        /** 문구 크기·줄 간격 배율 (기본 1 = 실측값) */
        tune?: { scale?: number; gap?: number };
      };
      /** 같은 문구로 여러 규격을 한 번에 만들어 짝으로 저장 */
      batch?: AutoTexts & { imageUrl: string; sizeIds: string[]; buttonColor?: string; sourceId?: string; tune?: { scale?: number; gap?: number }; font?: string;
        /** true 면 저장하지 않고 두 장의 렌더만 돌려준다 — 확인창에 보여주기 위한 것 */
        preview?: boolean };
    };

    // ── 1차 배치 ──
    if (body.auto?.imageUrl) {
      const a = body.auto;
      const { buf: raw, srcW, srcH } = await fetchImage(a.imageUrl);
      const W = a.size?.w ?? srcW;
      const H = a.size?.h ?? srcH;

      /*
       * 자르는 위치. 손대지 않았으면(autoFocus) 피사체 무게중심이 창 안에
       * 오도록 서버가 정하고, 정한 숫자를 그대로 돌려준다 — 화면 미리보기(CSS)가
       * 같은 숫자로 잘라야 저장본과 어긋나지 않아서 숫자로 주고받는다.
       */
      let fit: { mode: 'cover' | 'blur' | 'color' | 'gradient'; fx: number; fy: number; fillColor?: string } = a.fit ?? { mode: 'cover', fx: 0.5, fy: 0.5 };
      if (a.autoFocus && fit.mode === 'cover') {
        const c = await subjectCenter(raw);
        fit = { ...fit, ...focusFor(srcW, srcH, W, H, c.cx, c.cy) };
      }

      const buf = W !== srcW || H !== srcH ? await fitToSize(raw, W, H, fit) : raw;
      const reg = await analyzeRegions(buf);            // 규격에 맞춘 뒤의 그림을 본다
      // 본문 폭은 규격표에서 가져온다 — 글자 왼쪽 줄을 페이지 본문에 맞추기 위해서다
      const content = a.size?.id ? findSize(a.size.id).content : undefined;
      const out = buildAuto(shapeOf(W, H), reg, W, H, {
        eyebrow: (a.eyebrow ?? '').trim(),
        title: (a.title ?? '').trim(),
        subtitle: (a.subtitle ?? '').trim(),
        cta: (a.cta ?? '').trim(),
      }, content, a.buttonColor, a.tune);
      return NextResponse.json({
        ok: true, ...out, size: { w: W, h: H }, source: { w: srcW, h: srcH }, fit,
      });
    }

    // ── 웹+모바일 짝 저장 — 같은 문구로 여러 규격을 자동 배치해 한 번에 만든다 ──
    if (body.batch?.imageUrl) {
      const b = body.batch;
      if (!b.preview && !ftpConfigured()) {
        return NextResponse.json({ ok: false, error: 'FTP 설정이 없습니다 (.env.local).' }, { status: 500 });
      }
      const texts = {
        eyebrow: (b.eyebrow ?? '').trim(),
        title: (b.title ?? '').trim(),
        subtitle: (b.subtitle ?? '').trim(),
        cta: (b.cta ?? '').trim(),
      };
      const { buf: raw, srcW, srcH } = await fetchImage(b.imageUrl);
      const c = await subjectCenter(raw);               // 초점은 원본에서 한 번만 재면 된다
      const pairId = Math.random().toString(36).slice(2, 10);

      const items: { id?: string; url?: string; sizeId: string; w: number; h: number; label: string; preview?: string; layers?: DesignLayer[]; fit?: { mode: 'cover' | 'blur' | 'color' | 'gradient'; fx: number; fy: number; fillColor?: string } }[] = [];
      for (const sid of (b.sizeIds ?? []).slice(0, 4)) {
        const sz = findSize(sid);
        const W = sz.w;
        const H = sz.h;
        const fit = { mode: 'cover' as const, ...focusFor(srcW, srcH, W, H, c.cx, c.cy) };
        const buf = W !== srcW || H !== srcH ? await fitToSize(raw, W, H, fit) : raw;
        const reg = await analyzeRegions(buf);
        const auto = buildAuto(shapeOf(W, H), reg, W, H, texts, sz.content, b.buttonColor, b.tune);
        const design: DesignDoc = { imageUrl: b.imageUrl, layers: auto.layers, size: { id: sid, w: W, h: H }, fit, font: b.font };
        const svg = renderLayersToSvg(design, W, H);
        const out = await sharp(buf).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 94 }).toBuffer();
        // 확인창용 — 저장 없이 그림만 돌려준다. 같은 입력이면 같은 결과라 확인 후 다시 만들어도 같다.
        // layers·fit 도 같이 준다 — "이 버전만 무대에서 다듬기"가 그대로 이어받아야 한다
        if (b.preview) {
          items.push({
            sizeId: sid, w: W, h: H, label: sz.label,
            preview: `data:image/jpeg;base64,${out.toString('base64')}`,
            layers: auto.layers, fit,
          });
          continue;
        }
        const saved = await saveRendered(out, design, W, H, `${texts.title || '배너'} — ${sz.label}`, {
          pairId,
          ...(b.sourceId ? { revisedFrom: b.sourceId } : {}),
        });
        items.push({ ...saved, sizeId: sid, w: W, h: H, label: sz.label });
      }
      return NextResponse.json({ ok: true, pairId: b.preview ? undefined : pairId, items });
    }

    const design = body.design;
    if (!design?.imageUrl) {
      return NextResponse.json({ ok: false, error: '배경 이미지가 필요합니다.' }, { status: 400 });
    }

    const { buf, W, H } = await prepareBase(design);
    // 화면과 같은 숫자로 SVG 를 만들어 겹친다
    const svg = renderLayersToSvg(design, W, H);
    const out = await sharp(buf)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 94 })
      .toBuffer();

    if (!body.save) {
      return NextResponse.json({
        ok: true, preview: `data:image/jpeg;base64,${out.toString('base64')}`, width: W, height: H,
      });
    }

    if (!ftpConfigured()) {
      return NextResponse.json({ ok: false, error: 'FTP 설정이 없습니다 (.env.local).' }, { status: 500 });
    }
    const title = String(body.title || design.layers.find((l) => l.text)?.text || '디자인');
    const saved = await saveRendered(out, design, W, H, title, {
      // 수정으로 연 배너면 원본 id 를 계보로 남긴다 — 게시판에서 판(버전)을 묶어 보여준다
      ...(body.sourceId ? { revisedFrom: body.sourceId } : {}),
      ...(body.pairId ? { pairId: body.pairId } : {}),
    });

    return NextResponse.json({ ok: true, ...saved, width: W, height: H });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as { id?: string; name?: string; design?: DesignDoc };
    const name = String(body.name || '').trim();
    if (!name || !body.design) {
      return NextResponse.json({ ok: false, error: '이름과 디자인이 필요합니다.' }, { status: 400 });
    }
    const db = await getDb();
    const col = db.collection(COLLECTIONS.designTemplates);
    const now = new Date();
    // 템플릿은 배경 없이 배치만 저장한다 — 다른 컷에도 얹을 수 있어야 한다
    const design = { ...body.design, imageUrl: '' };
    if (body.id) {
      const { ObjectId } = await import('mongodb');
      await col.updateOne({ _id: new ObjectId(body.id) as never }, { $set: { name, design, updatedAt: now } });
      return NextResponse.json({ ok: true, id: body.id });
    }
    const ins = await col.insertOne({ name, design, createdAt: now, updatedAt: now });
    return NextResponse.json({ ok: true, id: String(ins.insertedId) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { id } = (await req.json()) as { id?: string };
    if (!id) return NextResponse.json({ ok: false, error: 'id 가 필요합니다.' }, { status: 400 });
    const { ObjectId } = await import('mongodb');
    const db = await getDb();
    await db.collection(COLLECTIONS.designTemplates).deleteOne({ _id: new ObjectId(id) as never });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
