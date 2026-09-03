/**
 * 디자인 레이어 → SVG.
 *
 * 화면(CSS)과 서버(SVG)가 **같은 숫자**를 읽게 하는 것이 이 파일의 존재 이유다.
 * 좌표·크기는 전부 0~1 비율로 두고 렌더 시점에 실제 픽셀을 곱한다.
 * px 로 박아두면 1000px 컷과 2752px 컷에서 결과가 달라진다.
 *
 * 이 파일은 'server-only' 를 붙이지 않는다 — 화면 쪽에서도 같은 타입을 쓴다.
 */

export type LayerKind = 'text' | 'rect' | 'scrim' | 'icon' | 'image' | 'brush' | 'blurpatch';

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

  // ── 포토샵 방식 편집기 확장 ──
  /**
   * 진짜 드롭섀도 (기존 shadow 는 가독성용 얇은 윤곽선이다).
   * dx/dy/blur 는 글자 크기(em) 대비 — 캔버스가 커져도 비율이 유지된다.
   * 도형·이미지에도 적용된다 (그때는 짧은 변 대비 크기의 0.1 을 1em 으로 본다).
   */
  dropShadow?: { dx: number; dy: number; blur: number; color: string; opacity?: number };
  /** rect 의 모양 — ellipse 면 타원(원)으로 그린다 */
  shape?: 'rect' | 'ellipse';
  /** rect 테두리 (짧은 변 대비 굵기) */
  border?: { width: number; color: string };

  // ── 이미지 레이어 (로고·뱃지 PNG 등) ──
  /** 이미지 원본 URL. 서버 렌더는 assets 맵(url→dataURI)으로 받아 embed 한다 */
  src?: string;
  /** 원본 가로/세로 비율 (w/h) — 업로드 시 잰다. 렌더는 w 와 이걸로 h 를 계산 */
  srcAspect?: number;
  /**
   * true 면 슬롯(w×h)을 꽉 채우고 넘치는 부분을 자른다 (object-fit: cover).
   * 로고·뱃지는 기본(meet, 안에 맞춤)이 맞고, A안처럼 "이미지 자리"에 사진을
   * 끼우는 슬롯은 cover 가 맞다 — 비율이 달라도 옆이 비지 않는다.
   */
  cover?: boolean;

  /** 이 레이어만 다른 글꼴 — 없으면 배너 전체 글꼴(design.font)을 따른다 */
  font?: string;
  /** 텍스트 장평 (가로 스케일, 1=100%) — 포토샵 Ctrl+T 의 좌우 줄이기 */
  scaleX?: number;
  /** 텍스트 커스텀 외곽선 (width 는 em) — 기존 shadow(가독 윤곽)보다 우선한다 */
  textStroke?: { width: number; color: string };

  // ── 브러시 (자유 곡선 스트로크) ──
  /** 지나간 점들 (0~1 비율 좌표). strokeWidth 는 짧은 변 대비 비율 */
  points?: { x: number; y: number }[];
  strokeWidth?: number;

  // ── 영역 블러/모자이크 (배경 사진에 적용 — 얼굴·번호판 가리기) ──
  /** blurpatch 의 효과. 서버가 배경 래스터에 직접 적용한다 (SVG 로는 못 그린다) */
  effect?: 'blur' | 'mosaic';
  /** 효과 강도 0~1 */
  strength?: number;

  /** 편집기 전용 — 화면 숨김 (렌더에서도 건너뜀) */
  hidden?: boolean;
  /** 편집기 전용 — 잠금 (렌더와 무관, 캔버스 조작만 막음) */
  locked?: boolean;
  /** 편집기에서 보여줄 레이어 이름 */
  name?: string;
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
  /**
   * cover  잘라서 꽉 채운다 / blur  흐린 사본 위에 통째로 / color  줄여 넣고 남는 여백을
   * 단색으로 / gradient  남는 여백을 그 색의 위아래 그라데이션으로 자연스럽게 채운다.
   */
  /**
   * zoom — 배경 이미지 자체의 확대/이동(포토샵의 배경 변형).
   * 1 = 기존 동작. cover 는 1 미만이면 빈틈이 생겨 1로 클램프한다.
   * 위치는 fx/fy 가 계속 맡는다: left = fx*(W-fgW), top = fy*(H-fgH)
   * (zoom=1 cover 에서 기존 object-position 과 정확히 같은 식이다).
   */
  fit?: {
    mode: 'cover' | 'blur' | 'color' | 'gradient'; fx: number; fy: number; fillColor?: string; zoom?: number;
    /** 배경 가로/세로 개별 배율 (Ctrl+T 자유 변형) — zoom 위에 곱해진다. 1=변형 없음 */
    zoomX?: number;
    zoomY?: number;
    /** 배경 사진 보정 — 1 이 원본. CSS filter 와 같은 의미라 미리보기·저장본이 일치한다 */
    adjust?: { brightness?: number; contrast?: number; saturate?: number };
  };
  /**
   * 이 배너 전체의 글꼴 가족 이름. fonts/ 폴더에 있는 파일의 name 테이블
   * 이름이어야 한다 (banner-fonts 가 목록을 만든다). 없으면 FONT_STACK 순서.
   */
  font?: string;
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
  cart:   { label: '장바구니', path: 'M3 4h2l2.5 12h11L21 8H7M10 20a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM17 20a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z' },
  chevron:{ label: '꺾쇠',     path: 'M9 5l7 7-7 7' },
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
/** 배너가 고른 글꼴을 맨 앞에 세운 스택 — 그 글꼴이 없으면 기본 층계로 내려간다 */
function stackFor(font?: string): string {
  if (!font) return FONT_STACK;
  const clean = font.replace(/["']/g, '');
  return `'${clean}', ${FONT_STACK}`;
}

export function renderLayersToSvg(
  design: DesignDoc, W: number, H: number,
  /** 이미지 레이어의 url→dataURI 맵. 서버(sharp/librsvg)는 외부 URL 을 못 불러서 embed 가 필요하다. 브라우저 미리보기는 없어도 된다(원본 URL 로 그림). */
  assets?: Record<string, string>,
): string {
  // 글자·아이콘·모서리는 짧은 변을 기준으로 잰다.
  // 가로폭 기준이면 1920x600 배너에서 0.082 짜리 제목이 157px 가 되어 캔버스를 뚫는다.
  const S = Math.min(W, H);
  const fontStack = stackFor(design.font);
  const parts: string[] = [];
  const defs: string[] = [];

  /**
   * 드롭섀도 — feDropShadow 는 librsvg 호환이 들쭉날쭉해서, 어디서나 똑같이 나오는
   * "흐린 사본을 뒤에 깐다" 방식을 쓴다. inner 는 그림자색으로 칠한 같은 도형이어야 한다.
   */
  const dropShadowOf = (i: number, blurPx: number): string => {
    const fid = `ds${i}`;
    defs.push(`<filter id="${fid}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="${Math.max(0, blurPx).toFixed(2)}"/></filter>`);
    return fid;
  };

  design.layers.forEach((l, i) => {
    if (l.hidden) return; // 편집기에서 눈을 꺼둔 레이어
    // 블러/모자이크는 배경 래스터에 서버가 직접 적용한다 (route) — SVG 에는 안 그린다
    if (l.kind === 'blurpatch') return;
    const op = Math.max(0, Math.min(1, l.opacity ?? 1));

    if (l.kind === 'brush') {
      const pts = l.points ?? [];
      if (pts.length < 2) return;
      // 중점 이차곡선 스무딩 — 손떨림이 자연스러운 곡선이 된다
      const P = pts.map((q) => ({ x: q.x * W, y: q.y * H }));
      let d = `M ${P[0].x.toFixed(1)} ${P[0].y.toFixed(1)}`;
      for (let k = 1; k < P.length - 1; k++) {
        const mx = (P[k].x + P[k + 1].x) / 2, my = (P[k].y + P[k + 1].y) / 2;
        d += ` Q ${P[k].x.toFixed(1)} ${P[k].y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
      }
      d += ` L ${P[P.length - 1].x.toFixed(1)} ${P[P.length - 1].y.toFixed(1)}`;
      const sw = Math.max(0.5, (l.strokeWidth ?? 0.01) * S);
      const cx = (l.x ?? 0.5) * W, cy = (l.y ?? 0.5) * H;
      parts.push(rotWrap(
        `<path d="${d}" fill="none" stroke="${l.color}" stroke-opacity="${op}" stroke-width="${sw.toFixed(1)}"` +
        ' stroke-linecap="round" stroke-linejoin="round"/>',
        l.rotate, cx, cy,
      ));
      return;
    }

    if (l.kind === 'image') {
      const src = l.src ?? '';
      if (!src) return;
      const href = assets?.[src] ?? src;
      const w = (l.w ?? 0.2) * W;
      // h 가 명시되면 비율을 깨고 그 높이로 늘린다 (Ctrl+T 스트레치). 없으면 원본 비율
      const h = l.h != null ? l.h * H : (l.srcAspect ? w / l.srcAspect : 0.2 * H);
      const x = (l.x ?? 0.5) * W - w / 2;
      const y = (l.y ?? 0.5) * H - h / 2;
      const rot = l.rotate ? ` transform="rotate(${l.rotate} ${x + w / 2} ${y + h / 2})"` : '';
      parts.push(
        `<image x="${x}" y="${y}" width="${w}" height="${h}" opacity="${op}" preserveAspectRatio="xMidYMid ${l.cover ? 'slice' : 'meet'}"` +
        ` href="${esc(href)}" xlink:href="${esc(href)}"${rot}/>`,
      );
      return;
    }

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
      const cx0 = x + w / 2, cy0 = y + h / 2;
      const r = (l.radius ?? 0) * S;
      const rot = l.rotate ? ` transform="rotate(${l.rotate} ${cx0} ${cy0})"` : '';
      const bd = l.border && l.border.width > 0
        ? ` stroke="${l.border.color}" stroke-width="${(l.border.width * S).toFixed(2)}"`
        : '';
      const shapeAt = (dx: number, dy: number, fill: string, fillOp: number, extra = '') =>
        l.shape === 'ellipse'
          ? `<ellipse cx="${cx0 + dx}" cy="${cy0 + dy}" rx="${w / 2}" ry="${h / 2}" fill="${fill}" fill-opacity="${fillOp}"${extra}${rot}/>`
          : `<rect x="${x + dx}" y="${y + dy}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${fill}" fill-opacity="${fillOp}"${extra}${rot}/>`;
      if (l.dropShadow) {
        const d = l.dropShadow;
        const em = S * 0.1; // 도형의 1em = 짧은 변의 10%
        const fid = dropShadowOf(i, d.blur * em);
        parts.push(`<g filter="url(#${fid})" transform="translate(${(d.dx * em).toFixed(1)} ${(d.dy * em).toFixed(1)})">${shapeAt(0, 0, d.color, Math.max(0, Math.min(1, d.opacity ?? 0.5)))}</g>`);
      }
      parts.push(shapeAt(0, 0, l.color, op, bd));
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

    // 외곽선: 커스텀(textStroke)이 있으면 그것을, 없고 shadow 면 가독용 옅은 윤곽을
    const shadow = l.textStroke && l.textStroke.width > 0
      ? ` style="paint-order:stroke fill;stroke:${l.textStroke.color};stroke-width:${(l.textStroke.width * fs).toFixed(1)}px;stroke-linejoin:round"`
      : l.shadow
        ? ` style="paint-order:stroke fill;stroke:rgba(0,0,0,.28);stroke-width:${Math.max(1, fs * 0.045)}px;stroke-linejoin:round"`
        : '';

    // 레이어별 글꼴 — 있으면 그 글꼴을 맨 앞에 세운다 (PC 폰트 선택용)
    const layerStack = l.font ? stackFor(l.font) : fontStack;
    const common =
      `font-family="${layerStack}" font-size="${fs}" font-weight="${l.weight ?? 700}"` +
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
    // 장평(가로 스케일) — 글자 중심을 축으로 가로만 늘리거나 줄인다 (Ctrl+T 좌우 변형)
    const sx = l.scaleX ?? 1;
    const scaleWrap = (inner: string) => sx !== 1
      ? `<g transform="translate(${cx} 0) scale(${sx} 1) translate(${-cx} 0)">${inner}</g>`
      : inner;

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
      parts.push(scaleWrap(rotWrap(glyphs.join(''), l.rotate, cx, cy)));
      return;
    }

    const tspans = lines.map((ln, k) =>
      `<tspan x="${cx}" y="${startY + k * lh}">${esc(ln)}</tspan>`).join('');

    // 진짜 드롭섀도 — 그림자색으로 칠한 같은 글자를 흐려서 뒤에 깐다
    if (l.dropShadow) {
      const d = l.dropShadow;
      const fid = dropShadowOf(i, d.blur * fs);
      const shCommon =
        `font-family="${layerStack}" font-size="${fs}" font-weight="${l.weight ?? 700}"` +
        ` letter-spacing="${ls}" fill="${d.color}" fill-opacity="${Math.max(0, Math.min(1, d.opacity ?? 0.5))}"`;
      parts.push(scaleWrap(
        `<g filter="url(#${fid})" transform="translate(${(d.dx * fs).toFixed(1)} ${(d.dy * fs).toFixed(1)})">` +
        `<text ${shCommon} text-anchor="${anchor}" dominant-baseline="middle"${rot}>${tspans}</text></g>`,
      ));
    }

    parts.push(scaleWrap(
      `<text ${common} text-anchor="${anchor}" dominant-baseline="middle"${shadow}${rot}>${tspans}</text>`,
    ));
  });

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`
    + (defs.length ? `<defs>${defs.join('')}</defs>` : '')
    + parts.join('')
    + `</svg>`;
}
