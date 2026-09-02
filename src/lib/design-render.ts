/**
 * 디자인 레이어 → SVG.
 *
 * 화면(CSS)과 서버(SVG)가 **같은 숫자**를 읽게 하는 것이 이 파일의 존재 이유다.
 * 좌표·크기는 전부 0~1 비율로 두고 렌더 시점에 실제 픽셀을 곱한다.
 * px 로 박아두면 1000px 컷과 2752px 컷에서 결과가 달라진다.
 *
 * 이 파일은 'server-only' 를 붙이지 않는다 — 화면 쪽에서도 같은 타입을 쓴다.
 */

export type LayerKind = 'text' | 'rect' | 'scrim' | 'icon';

export interface DesignLayer {
  id: string;
  kind: LayerKind;
  /** 중심 좌표 (0~1). 도형은 좌상단이 아니라 중심 기준이라 옮기기가 직관적이다 */
  x: number;
  y: number;
  /** 도형 크기 (0~1). 텍스트는 쓰지 않는다 */
  w?: number;
  h?: number;

  // ── 텍스트 ──
  text?: string;
  /**
   * 글자 크기 — 캔버스의 **짧은 변** 대비 비율.
   * 가로폭 기준으로 하면 1920x600 같은 납작한 배너에서 글자가 캔버스를 뚫는다.
   * 짧은 변을 쓰면 정사각(짧은 변=가로)에서는 결과가 그대로다.
   */
  size?: number;
  weight?: number;
  /** 자간 (em) */
  tracking?: number;
  /** 줄 간격 배수 */
  lineHeight?: number;
  align?: 'start' | 'middle' | 'end';
  /** 글자에 그림자 — 밝은 배경 위 흰 글씨가 날아가는 걸 막는다 */
  shadow?: boolean;
  /**
   * 곡선 정도 (-1 ~ 1). 0 이면 직선.
   * 양수면 아래로 볼록(웃는 반달), 음수면 위로 볼록(우산 모양).
   * 글자를 호(arc)에 태우는 것이라 한 줄에만 적용된다.
   */
  curve?: number;

  // ── 공통 ──
  color: string;
  opacity: number;
  /** 도형 모서리 반경 (짧은 변 대비 비율) */
  radius?: number;
  /** scrim 의 그라데이션 방향 — 가로형 배너에서는 좌/우로 깐다 */
  direction?: 'top' | 'bottom' | 'left' | 'right' | 'none';
  /** 회전 (도) */
  rotate?: number;
  /**
   * 한 몸으로 다룰 레이어끼리 같은 이름을 준다.
   * 버튼이 대표적이다 — 알약·글자·화살표 셋이 따로 놀면 옮길 때마다 어긋난다.
   * 그리는 쪽은 이 값을 보지 않는다. 화면에서 다루는 단위일 뿐이다.
   */
  group?: string;

  // ── 아이콘 ──
  /** ICONS 의 키 */
  icon?: string;
  /** 선 굵기 — 아이콘 크기 대비 비율 */
  stroke?: number;
}

export interface DesignDoc {
  imageUrl: string;
  templateId?: string;
  layers: DesignLayer[];
  /**
   * 최종 배너 규격 (px). 배경 컷은 대개 1:1 이라 여기 맞추려면 손을 봐야 한다.
   * 없으면 배경 컷의 원래 크기를 그대로 쓴다.
   */
  size?: { id?: string; w: number; h: number };
  /**
   * 배경을 규격에 맞추는 방법.
   *   cover  잘라서 꽉 채운다 (fx/fy 로 어느 부분을 남길지 정한다, 0~1)
   *   blur   자기 자신을 흐리게 깐 위에 통째로 얹는다 — 하나도 잘리지 않는다
   */
  fit?: { mode: 'cover' | 'blur'; fx: number; fy: number };
}

/**
 * 글자 폭을 대략 잰다 (em 단위). 정확할 필요는 없고, 제목이 캔버스를
 * 뚫는지 판단할 정도면 된다. 곡선 텍스트의 글자 배치와 같은 표를 쓴다.
 */
export function textEm(str: string): number {
  let n = 0;
  for (const ch of str) {
    if (ch === ' ') n += 0.32;
    else if (/[ㄱ-힝一-鿿぀-ヿ]/.test(ch)) n += 1.0;
    else if (/[A-Z0-9]/.test(ch)) n += 0.62;
    else if (/[a-z]/.test(ch)) n += 0.55;
    else n += 0.35;
  }
  return n;
}


/*
 * 내장 아이콘.
 *
 * 외부 아이콘 라이브러리를 쓰지 않는다 — 서버 SVG 렌더와 브라우저 미리보기가
 * 같은 패스를 읽어야 결과가 어긋나지 않기 때문이다. 여기 있는 것만 쓴다.
 * 전부 24x24 좌표계, 선(stroke) 기반이라 굵기와 색을 자유롭게 바꿀 수 있다.
 *
 * 자사몰 배너에서 실제로 쓰는 것만 넣었다. 필요하면 24x24 패스를 한 줄 추가하면
 * 화면의 아이콘 목록에 바로 뜬다.
 */
export const ICONS: Record<string, { label: string; path: string; fill?: boolean }> = {
  arrow:  { label: '화살표',   path: 'M4 12h15M13 6l6 6-6 6' },
  gift:   { label: '선물',     path: 'M3 11h18v10H3zM3 7h18v4H3zM12 7v14M12 7S9.5 3 7.5 4.5 9 7 12 7zM12 7s2.5-4 4.5-2.5S15 7 12 7z' },
  star:   { label: '별',       path: 'M12 3l2.6 5.9 6.4.6-4.8 4.3 1.4 6.2L12 16.9 6.4 20l1.4-6.2L3 9.5l6.4-.6z' },
  heart:  { label: '하트',     path: 'M12 20s-7-4.5-7-9.3A4 4 0 0 1 12 8a4 4 0 0 1 7 2.7C19 15.5 12 20 12 20z' },
  tag:    { label: '가격표',   path: 'M3 12l9-9h8v8l-9 9zM16.5 7.5h.01' },
  truck:  { label: '배송',     path: 'M3 7h11v9H3zM14 10h4l3 3v3h-7zM7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z' },
  clock:  { label: '기간',     path: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2' },
  check:  { label: '체크',     path: 'M4 12.5l5 5L20 7' },
  percent:{ label: '할인',     path: 'M19 5L5 19M7.5 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM16.5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z' },
  home:   { label: '집',       path: 'M3 11l9-7 9 7M6 10v10h12V10' },
  sparkle:{ label: '반짝임',   path: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z' },
  moon:   { label: '달',       path: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' },
};

/** XML 에 그대로 넣으면 깨지는 문자들 */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 한글이 나오는 폰트를 순서대로 시도한다.
 * 서버 OS 마다 있는 폰트가 다르므로 넉넉히 나열한다 —
 * 하나라도 있으면 한글이 렌더된다. 없으면 두부(□)가 나온다.
 */
/*
 * 첫 항목이 저장소에 담긴 fonts/PretendardVariable.ttf 다 (instrumentation 이 등록).
 * 파일의 name 테이블을 읽어보면 가족 이름이 'Pretendard' 가 아니라
 * 'Pretendard Variable' 이라서, 이 이름이 스택에 없으면 파일이 있어도 못 찾는다.
 * 뒤는 폰트 파일이 없을 때(로컬 개발 등)를 위한 층계다.
 */
const FONT_STACK = [
  'Pretendard Variable', 'Pretendard', 'Noto Sans KR', 'Malgun Gothic', '맑은 고딕',
  'Apple SD Gothic Neo', 'NanumGothic', 'Nanum Gothic',
  'DejaVu Sans', 'sans-serif',
].map((f) => (f.includes(' ') ? `'${f}'` : f)).join(', ');

export { FONT_STACK };


/** 레이어 전체 회전이 있으면 <g> 로 감싼다 */
function rotWrap(inner: string, rotate: number | undefined, cx: number, cy: number): string {
  return rotate ? `<g transform="rotate(${rotate} ${cx} ${cy})">${inner}</g>` : inner;
}

/** 레이어들을 배경 크기(W×H)에 맞춰 SVG 한 장으로 그린다 */
export function renderLayersToSvg(design: DesignDoc, W: number, H: number): string {
  // 글자·아이콘·모서리는 짧은 변을 기준으로 잰다.
  // 가로폭 기준이면 1920x600 배너에서 0.082 짜리 제목이 157px 가 되어 캔버스를 뚫는다.
  const S = Math.min(W, H);
  const parts: string[] = [];
  const defs: string[] = [];

  design.layers.forEach((l, i) => {
    const op = Math.max(0, Math.min(1, l.opacity ?? 1));

    if (l.kind === 'scrim') {
      // 위/아래에서 흐려지는 그라데이션 — 글자가 배경에 묻히는 걸 막는 용도
      const gid = `g${i}`;
      const dir = l.direction ?? 'top';
      // 짙은 쪽 -> 투명한 쪽. bottom/right 는 뒤에서 짙어진다
      const fades = dir === 'bottom' || dir === 'right';
      const stops = dir === 'none'
        ? `<stop offset="0" stop-color="${l.color}" stop-opacity="${op}"/><stop offset="1" stop-color="${l.color}" stop-opacity="${op}"/>`
        : fades
          ? `<stop offset="0" stop-color="${l.color}" stop-opacity="0"/><stop offset="1" stop-color="${l.color}" stop-opacity="${op}"/>`
          : `<stop offset="0" stop-color="${l.color}" stop-opacity="${op}"/><stop offset="1" stop-color="${l.color}" stop-opacity="0"/>`;
      // 가로형 배너는 좌/우로 깔아야 한다 — 위아래로 깔면 문구 옆이 아니라 위를 덮는다
      const horiz = dir === 'left' || dir === 'right';
      const axis = horiz ? 'x1="0" y1="0" x2="1" y2="0"' : 'x1="0" y1="0" x2="0" y2="1"';
      defs.push(`<linearGradient id="${gid}" ${axis}>${stops}</linearGradient>`);
      const w = (l.w ?? 1) * W, h = (l.h ?? 0.4) * H;
      const x = (l.x ?? 0.5) * W - w / 2, y = (l.y ?? 0.2) * H - h / 2;
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${gid})"/>`);
      return;
    }

    if (l.kind === 'rect') {
      const w = (l.w ?? 0.3) * W, h = (l.h ?? 0.1) * H;
      const x = (l.x ?? 0.5) * W - w / 2, y = (l.y ?? 0.5) * H - h / 2;
      const r = (l.radius ?? 0) * S;
      const rot = l.rotate ? ` transform="rotate(${l.rotate} ${x + w / 2} ${y + h / 2})"` : '';
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${l.color}" fill-opacity="${op}"${rot}/>`);
      return;
    }

    if (l.kind === 'icon') {
      const ic = ICONS[l.icon ?? 'arrow'];
      if (!ic) return;
      // 24x24 좌표계를 원하는 크기로 키운다. size 는 짧은 변 대비 비율
      const box = (l.size ?? 0.06) * S;
      const k = box / 24;
      const x = (l.x ?? 0.5) * W - box / 2;
      const y = (l.y ?? 0.5) * H - box / 2;
      const sw = Math.max(0.6, (l.stroke ?? 0.09) * 24);
      const rot = l.rotate ? ` rotate(${l.rotate} ${box / 2} ${box / 2})` : '';
      parts.push(
        `<g transform="translate(${x} ${y}) scale(${k})${rot}" opacity="${op}">` +
        `<path d="${ic.path}" fill="${ic.fill ? l.color : 'none'}" stroke="${l.color}"` +
        ` stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/></g>`,
      );
      return;
    }

    // ── 텍스트 ──
    const raw = (l.text ?? '').trim();
    if (!raw) return;
    const fs = (l.size ?? 0.06) * S;
    const lh = (l.lineHeight ?? 1.25) * fs;
    const lines = raw.split('\n');
    const cx = (l.x ?? 0.5) * W;
    const cy = (l.y ?? 0.5) * H;
    // 여러 줄이면 블록 중심이 y 에 오도록 위로 올린다
    const startY = cy - ((lines.length - 1) * lh) / 2;
    const anchor = l.align ?? 'middle';
    const ls = (l.tracking ?? 0) * fs;
    const rot = l.rotate ? ` transform="rotate(${l.rotate} ${cx} ${cy})"` : '';

    // 밝은 배경 위 흰 글씨가 날아가지 않게 — 아주 옅은 그림자
    const shadow = l.shadow
      ? ` style="paint-order:stroke fill;stroke:rgba(0,0,0,.28);stroke-width:${Math.max(1, fs * 0.045)}px;stroke-linejoin:round"`
      : '';

    const common =
      `font-family="${FONT_STACK}" font-size="${fs}" font-weight="${l.weight ?? 700}"` +
      ` letter-spacing="${ls}" fill="${l.color}" fill-opacity="${op}"`;

    /*
     * 곡선 텍스트 — 글자를 하나씩 호(arc) 위에 놓는다.
     *
     * 처음엔 SVG textPath 를 썼는데 sharp 의 렌더러(librsvg)가 지원하지 않아
     * 글자가 통째로 사라졌다. 그래서 문자마다 좌표와 회전을 직접 계산한다 —
     * 평범한 <text> + transform 이라 어느 렌더러에서나 똑같이 나온다.
     *
     * 원호를 쓴다: 현(span)과 중앙 처짐(sagitta)으로 반지름을 구하고,
     * 각 글자를 각도에 배치한 뒤 접선 방향으로 회전시킨다.
     * 글자 폭이 제각각이라 균등 분배하면 한글과 영문이 섞일 때 간격이 어긋난다 —
     * 대략적인 폭 가중치로 누적 위치를 잡는다.
     */
    const curve = l.curve ?? 0;
    if (curve !== 0) {
      const chars = [...lines.join(' ')];
      const widthOf = (ch: string) => {
        if (ch === ' ') return 0.32;
        if (/[\u3131-\uD79D\u4E00-\u9FFF\u3040-\u30FF]/.test(ch)) return 1.0;  // 한글·한자·가나
        if (/[A-Z0-9]/.test(ch)) return 0.62;
        if (/[a-z]/.test(ch)) return 0.55;
        return 0.35;
      };
      const w = chars.map(widthOf);
      const total = w.reduce((a, b) => a + b, 0) * fs * (1 + (l.tracking ?? 0));
      const span = Math.max(total, fs);
      const sag = Math.abs(curve) * span * 0.28;          // 중앙 처짐
      const R = sag / 2 + (span * span) / (8 * sag);       // 원호 반지름
      const dir = curve > 0 ? 1 : -1;                      // +면 아래로 볼록
      const thetaMax = Math.asin(Math.min(1, span / (2 * R)));
      const cyc = cy - dir * (R - sag);                    // 원 중심

      let acc = 0;
      const glyphs = chars.map((ch, k) => {
        // 이 글자의 중심이 놓일 누적 위치 (0~1)
        const mid = (acc + w[k] / 2) / w.reduce((a, b) => a + b, 0);
        acc += w[k];
        const th = (mid * 2 - 1) * thetaMax;
        const px = cx + R * Math.sin(th);
        const py = cyc + dir * R * Math.cos(th);
        const deg = (th * 180) / Math.PI * dir;
        return `<text ${common} text-anchor="middle" dominant-baseline="middle"` +
               ` transform="translate(${px.toFixed(2)} ${py.toFixed(2)}) rotate(${deg.toFixed(2)})"` +
               `${shadow}>${esc(ch)}</text>`;
      });
      parts.push(rotWrap(glyphs.join(''), l.rotate, cx, cy));
      return;
    }

    const tspans = lines.map((ln, k) =>
      `<tspan x="${cx}" y="${startY + k * lh}">${esc(ln)}</tspan>`).join('');

    parts.push(
      `<text ${common} text-anchor="${anchor}" dominant-baseline="middle"${shadow}${rot}>${tspans}</text>`,
    );
  });

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`
    + (defs.length ? `<defs>${defs.join('')}</defs>` : '')
    + parts.join('')
    + `</svg>`;
}
