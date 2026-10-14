/**
 * PhotoCraft(오픈소스 포토샵 대체, MIT/Apache-2.0) 웹 버전과 그림을 주고받는 다리.
 *
 * PhotoCraft 웹 버전(public/photocraft/)은 서버 없이 도는 정적 사이트라, 파일을 받는 길이
 * "파일 고르기 · 끌어다 놓기 · 붙여넣기" 뿐이고 내보내는 길은 "브라우저 내려받기" 뿐이다
 * (바깥에서 부르는 API 가 없다). 우리 앱과 같은 출처의 iframe 으로 띄우면 그 두 길을 대신 걸어 줄 수 있다:
 *
 *   넣기  — File 을 만들어 캔버스에 끌어다 놓은 것처럼 drop 이벤트를 보낸다.
 *   받기  — 앱이 내려받기를 만들려고 부르는 URL.createObjectURL 과 <a download>.click() 을 감싸
 *           저장된 파일(Blob)을 가로채고, 실제 내려받기는 일어나지 않게 한다.
 *
 * 2026-10-13 v0.8.2 로 확인: 끌어다 놓기로 그림이 열리고, Ctrl+S 는 PSD(image/vnd.adobe.photoshop)를 내놓는다.
 * PSD 는 안에 들어 있는 "합쳐진 그림"만 읽어 돌려받는다(psdComposite).
 * 2026-10-14 확인: 캔버스에 합성 키 이벤트(Ctrl+S)를 보내도 저장이 일어난다 — 바뀐 것이 없어도 매번 내놓는다(requestSave).
 *
 * 쓰는 곳: 「포토샵」 메뉴(src/components/ImageEditStudio.tsx). 배너 편집기에 붙어 있던 것은 2026-10-14 사용자 요청으로
 * 떼어 냈다("저기선 기존과 동일하게 간단 편집 기능으로 하고 이건 정말 포토샵 기능 사용하게").
 */

/** PhotoCraft 정적 사이트의 주소 (public/photocraft/) */
export const PHOTOCRAFT_URL = '/photocraft/index.html';

export interface Captured {
  blob: Blob;
  /** 앱이 제안한 파일 이름 (예: banner.psd) */
  name: string;
}

/** iframe 안의 앱이 떴는지 — index.html 의 로딩 문구는 앱이 시작하면서 지운다 */
export async function waitForApp(frame: HTMLIFrameElement, timeoutMs = 90_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const d = frame.contentDocument;
    if (d && d.getElementById('photocraft_canvas') && !d.getElementById('photocraft_loading')) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * 저장·내보내기를 가로챈다. iframe 이 load 된 직후(앱이 뜨기 전이어도 된다)에 한 번 건다.
 * 돌려주는 함수를 부르면 원래대로 되돌린다.
 */
export function captureDownloads(frame: HTMLIFrameElement, onFile: (f: Captured) => void): () => void {
  const w = frame.contentWindow as (Window & typeof globalThis) | null;
  if (!w) return () => {};
  const blobs = new Map<string, Blob>();
  const origCreate = w.URL.createObjectURL;
  const origRevoke = w.URL.revokeObjectURL;
  const origClick = w.HTMLAnchorElement.prototype.click;

  w.URL.createObjectURL = function (obj: Blob | MediaSource) {
    const url = origCreate.call(w.URL, obj);
    // iframe 안에서 만든 Blob 은 그쪽 창의 Blob 이라 instanceof 를 그쪽 것으로 본다
    if (obj instanceof w.Blob) blobs.set(url, obj as Blob);
    return url;
  };
  w.URL.revokeObjectURL = function (url: string) {
    blobs.delete(url);
    origRevoke.call(w.URL, url);
  };
  w.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    const blob = this.hasAttribute('download') ? blobs.get(this.href) : undefined;
    if (blob) {
      onFile({ blob, name: this.getAttribute('download') || 'photocraft' });
      return;                                            // 실제 내려받기는 하지 않는다
    }
    origClick.call(this);
  };
  return () => {
    w.URL.createObjectURL = origCreate;
    w.URL.revokeObjectURL = origRevoke;
    w.HTMLAnchorElement.prototype.click = origClick;
  };
}

/**
 * PhotoCraft 캔버스에 포커스를 준다. 캔버스가 포커스를 잃으면(바깥 창을 쓰는 동안) 단축키를 무시한다 —
 * 2026-10-14 시험: AI 창을 쓴 뒤 보낸 Ctrl+S 가 그냥 사라졌고, 캔버스에 focus() 를 준 뒤에는 저장됐다.
 */
export function focusEditor(frame: HTMLIFrameElement) {
  frame.contentWindow?.focus();
  (frame.contentDocument?.getElementById('photocraft_canvas') as HTMLElement | null)?.focus();
}

/** PhotoCraft 에 저장(Ctrl+S)을 시킨다 — captureDownloads 를 걸어 두었으면 그쪽으로 PSD 가 온다 */
export function requestSave(frame: HTMLIFrameElement): boolean {
  const w = frame.contentWindow as (Window & typeof globalThis) | null;
  const canvas = frame.contentDocument?.getElementById('photocraft_canvas');
  if (!w || !canvas) return false;
  focusEditor(frame);
  for (const type of ['keydown', 'keyup']) {
    canvas.dispatchEvent(new w.KeyboardEvent(type, { key: 's', code: 'KeyS', keyCode: 83, which: 83, ctrlKey: true, bubbles: true, cancelable: true }));
  }
  return true;
}

/**
 * 문서 탭을 끌어 내려 "따로 떠 있는 창"으로 만드는 것을 막는다.
 * v0.8.2 웹판은 떠 있는 창을 만들면 원래 자리에 그림이 그대로 남아 창 밖으로 삐져나와 보인다(사용자 제보 2026-10-14,
 * 머리 없는 브라우저로 재현 — PhotoCraft 자체 문제, 최신판도 같음). 탭 줄(위에서 68~97px 띠)에서 누른 채 아래로
 * 끌면 띠 밖으로 나간 움직임만 PhotoCraft 에 전하지 않는다 — 탭을 옆으로 옮겨 순서 바꾸기·탭 고르기는 그대로 된다.
 * 띠 위치는 기본 작업 공간(Essentials) 기준이다. 돌려주는 함수를 부르면 원래대로.
 */
export function guardTabFloat(frame: HTMLIFrameElement, band: [number, number] = [68, 97]): () => void {
  const w = frame.contentWindow;
  if (!w) return () => {};
  let dragging = false;
  const down = (e: PointerEvent | MouseEvent) => { dragging = e.clientY >= band[0] && e.clientY <= band[1]; };
  const move = (e: PointerEvent | MouseEvent) => {
    if (dragging && (e.clientY > band[1] + 6 || e.clientY < band[0] - 6)) e.stopImmediatePropagation();
  };
  const up = () => { dragging = false; };
  const opts = { capture: true } as const;
  w.addEventListener('pointerdown', down, opts);
  w.addEventListener('mousedown', down, opts);
  w.addEventListener('pointermove', move, opts);
  w.addEventListener('mousemove', move, opts);
  w.addEventListener('pointerup', up, opts);
  w.addEventListener('mouseup', up, opts);
  return () => {
    w.removeEventListener('pointerdown', down, opts);
    w.removeEventListener('mousedown', down, opts);
    w.removeEventListener('pointermove', move, opts);
    w.removeEventListener('mousemove', move, opts);
    w.removeEventListener('pointerup', up, opts);
    w.removeEventListener('mouseup', up, opts);
  };
}

/** 그림 파일을 PhotoCraft 캔버스에 끌어다 놓은 것처럼 넣는다 — 새 문서로 열린다 */
export function dropFile(frame: HTMLIFrameElement, blob: Blob, name: string): boolean {
  const w = frame.contentWindow as (Window & typeof globalThis) | null;
  const canvas = frame.contentDocument?.getElementById('photocraft_canvas');
  if (!w || !canvas) return false;
  const file = new w.File([blob], name, { type: blob.type || 'image/jpeg' });
  const dt = new w.DataTransfer();
  dt.items.add(file);
  const r = canvas.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.width / 2, clientY: r.height / 2 };
  for (const type of ['dragenter', 'dragover', 'drop']) canvas.dispatchEvent(new w.DragEvent(type, init));
  return true;
}

export interface Composite {
  width: number;
  height: number;
  /** RGBA, 한 채널 8비트 */
  data: Uint8ClampedArray;
}

/**
 * PSD 파일에서 "합쳐진 그림"(맨 끝의 Image Data)만 읽는다 — 레이어는 읽지 않는다.
 * RGB · 8/16비트 · 무압축/RLE 만 받는다(PhotoCraft 가 저장하는 형식). 그 밖이면 null.
 */
export function psdComposite(buf: ArrayBuffer): Composite | null {
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  if (buf.byteLength < 30 || v.getUint32(0) !== 0x38425053) return null;      // '8BPS'
  if (v.getUint16(4) !== 1) return null;                                       // 1 = PSD (2 = PSB 는 받지 않는다)
  const channels = v.getUint16(12);
  const height = v.getUint32(14);
  const width = v.getUint32(18);
  const depth = v.getUint16(22);
  const mode = v.getUint16(24);
  if (mode !== 3 || channels < 3 || (depth !== 8 && depth !== 16) || !width || !height) return null;
  if (width * height > 64_000_000) return null;

  let o = 26;
  for (let i = 0; i < 3; i++) {                        // 색 모드 데이터 · 이미지 리소스 · 레이어와 마스크 — 길이만 읽고 건너뛴다
    if (o + 4 > buf.byteLength) return null;
    o += 4 + v.getUint32(o);
  }
  if (o + 2 > buf.byteLength) return null;
  const compression = v.getUint16(o);
  o += 2;
  const bps = depth / 8;
  const row = width * bps;
  const used = Math.min(channels, 4);                  // R·G·B(+첫 번째 덧채널 = 투명도)
  const planes: Uint8Array[] = [];

  if (compression === 0) {
    for (let c = 0; c < channels; c++) {
      if (o + row * height > buf.byteLength) return null;
      if (c < used) planes.push(u8.subarray(o, o + row * height));
      o += row * height;
    }
  } else if (compression === 1) {
    // 줄마다 압축된 길이가 먼저 나오고(채널 × 높이 개), 이어서 PackBits 데이터
    const counts = o;
    o += channels * height * 2;
    for (let c = 0; c < channels; c++) {
      const plane = c < used ? new Uint8Array(row * height) : null;
      for (let y = 0; y < height; y++) {
        const len = v.getUint16(counts + (c * height + y) * 2);
        if (o + len > buf.byteLength) return null;
        if (plane) {
          let s = o;
          const end = o + len;
          let d = y * row;
          const dEnd = d + row;
          while (s < end && d < dEnd) {
            const n = v.getInt8(s++);
            if (n >= 0) {
              const cnt = Math.min(n + 1, dEnd - d);
              plane.set(u8.subarray(s, s + cnt), d);
              s += n + 1;
              d += cnt;
            } else if (n !== -128) {
              const cnt = Math.min(1 - n, dEnd - d);
              plane.fill(u8[s++], d, d + cnt);
              d += cnt;
            }
          }
        }
        o += len;
      }
      if (plane) planes.push(plane);
    }
  } else {
    return null;
  }

  const n = width * height;
  const data = new Uint8ClampedArray(n * 4);
  const [r, g, b, a] = planes;
  for (let i = 0, p = 0; i < n; i++, p += bps) {       // 16비트는 윗바이트만 쓴다(빅엔디언)
    const q = i * 4;
    data[q] = r[p];
    data[q + 1] = g[p];
    data[q + 2] = b[p];
    data[q + 3] = a ? a[p] : 255;
  }
  return { width, height, data };
}

/**
 * 가로챈 파일(PSD · PNG · JPEG · WebP)을 캔버스 한 장으로 — PSD 는 합쳐진 그림을 읽는다.
 * 투명한 곳은 그대로 둔다(PNG 로 내보낼 때 살아 있다). JPEG 로 만들 때 흰 바탕을 깐다(canvasToBlob).
 */
export async function toCanvas(f: Captured): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  const isPsd = /photoshop/i.test(f.blob.type) || /\.psd$/i.test(f.name);
  if (isPsd) {
    const comp = psdComposite(await f.blob.arrayBuffer());
    if (!comp) throw new Error('이 PSD 는 읽지 못했습니다 — PhotoCraft 에서 File › Export 로 PNG 를 내보내 주세요.');
    canvas.width = comp.width;
    canvas.height = comp.height;
    canvas.getContext('2d')!.putImageData(new ImageData(comp.data as Uint8ClampedArray<ArrayBuffer>, comp.width, comp.height), 0, 0);
    return canvas;
  }
  if (/^image\/(png|jpeg|webp)$/i.test(f.blob.type) || /\.(png|jpe?g|webp)$/i.test(f.name)) {
    const bmp = await createImageBitmap(f.blob);
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d')!.drawImage(bmp, 0, 0);
    return canvas;
  }
  throw new Error(`이 형식(${f.name})은 받지 못합니다 — PSD(Ctrl+S)나 PNG·JPEG 로 저장해 주세요.`);
}

/**
 * 캔버스를 파일로. maxSide 를 주면 긴 변을 그만큼으로 줄인다(서버로 보내는 그림은 2048px — /api/upload 와 같은 기준).
 * JPEG 는 투명을 못 담아 흰 바탕을 깐다.
 */
export async function canvasToBlob(src: HTMLCanvasElement, type: 'image/png' | 'image/jpeg', maxSide = 0, quality = 0.95): Promise<Blob> {
  const k = maxSide ? Math.min(1, maxSide / Math.max(src.width, src.height)) : 1;
  const w = Math.max(1, Math.round(src.width * k));
  const h = Math.max(1, Math.round(src.height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  const out = await new Promise<Blob | null>((res) => c.toBlob(res, type, quality));
  if (!out) throw new Error('그림을 만들지 못했습니다.');
  return out;
}
