'use client';

/**
 * 포토샵 방식 편집기 — 피그마/포토샵을 아는 디자이너가 거부감 없이 쓰는 것이 목표.
 *
 * 구조는 피그마를 따른다:
 *   [레이어 패널] [캔버스(줌·팬)] [속성 패널]
 *   캔버스 조작: 클릭 선택 · 드래그 이동 · 8핸들 리사이즈 · 회전 스틱 · 스냅 가이드
 *   더블클릭으로 텍스트 인라인 편집 · Ctrl+Z/Y · Ctrl+D · 방향키 미세이동
 *
 * 미리보기는 저장본과 같은 renderLayersToSvg 를 그대로 얹는다 — 화면=결과.
 * 좌표계는 전부 0~1 비율(중심 기준)이라, 여기서 만진 레이어를 템플릿 방식으로
 * 돌려보내도 그대로 이어진다.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ICONS, renderLayersToSvg, textEm, FONT_STACK,
  type DesignDoc, type DesignLayer,
} from '@/lib/design-render';
import { shrinkForUpload } from '@/lib/client-image';

const uid = () => Math.random().toString(36).slice(2, 9);

/** 브러시 도구 노출 여부 — 숨기고 싶어지면 false 한 줄 (렌더·기존 획은 그대로 산다) */
const BRUSH_ENABLED = true;

type FitSpec = NonNullable<DesignDoc['fit']>;

interface Props {
  /** 배경·규격·fit·font 를 담은 현재 디자인 (레이어 포함) */
  base: DesignDoc;
  /** 배경 원본의 자연 크기 — 배경 확대/이동 미리보기 계산에 필요 */
  srcDims: { w: number; h: number };
  /** fonts/ 폴더에 있는 서버 보유 글꼴 (저장본에 항상 적용됨) */
  serverFonts?: string[];
  sizeLabel?: string;
  sourceId?: string;
  /** 템플릿 방식으로 돌아가기 — 편집한 레이어·배경 변형·(AI 로 바뀐) 배경 URL 을 돌려준다 */
  onExit: (layers: DesignLayer[], fit: FitSpec, imageUrl: string) => void;
  /** 저장 완료 알림 (게시판 새로고침 등) */
  onSaved?: () => void;
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** 레이어의 화면상 바운딩박스 (0~1 비율) */
function bboxOf(l: DesignLayer, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const S = Math.min(W, H);
  if (l.kind === 'text') {
    const fs = (l.size ?? 0.06) * S;
    const lines = (l.text ?? '').split('\n');
    const wEm = Math.max(...lines.map((ln) => textEm(ln)), 0.5);
    const wPx = wEm * fs * (1 + (l.tracking ?? 0)) * (l.scaleX ?? 1);
    const hPx = ((lines.length - 1) * (l.lineHeight ?? 1.25) + 1.25) * fs;
    const cx = (l.x ?? 0.5) * W;
    const left = l.align === 'start' ? cx : l.align === 'end' ? cx - wPx : cx - wPx / 2;
    return { x: left / W, y: ((l.y ?? 0.5) * H - hPx / 2) / H, w: wPx / W, h: hPx / H };
  }
  if (l.kind === 'icon') {
    const box = (l.size ?? 0.06) * S;
    return { x: (l.x ?? 0.5) - box / 2 / W, y: (l.y ?? 0.5) - box / 2 / H, w: box / W, h: box / H };
  }
  if (l.kind === 'image') {
    const w = (l.w ?? 0.2);
    const hPx = l.srcAspect ? (w * W) / l.srcAspect : (l.h ?? 0.2) * H;
    return { x: (l.x ?? 0.5) - w / 2, y: (l.y ?? 0.5) - hPx / 2 / H, w, h: hPx / H };
  }
  if (l.kind === 'brush') {
    const pts = l.points ?? [];
    if (!pts.length) return { x: (l.x ?? 0.5) - 0.05, y: (l.y ?? 0.5) - 0.05, w: 0.1, h: 0.1 };
    const pad = (l.strokeWidth ?? 0.01) * Math.min(W, H) / 2;
    const xs = pts.map((q) => q.x * W), ys = pts.map((q) => q.y * H);
    const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad;
    const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
    return { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
  }
  // rect / scrim / blurpatch
  const w = l.w ?? 0.3, h = l.h ?? 0.1;
  return { x: (l.x ?? 0.5) - w / 2, y: (l.y ?? 0.5) - h / 2, w, h };
}

/** 레이어를 (dx,dy) 만큼 옮긴다 — 브러시는 점들까지 함께 */
function shiftLayer(l: DesignLayer, dx: number, dy: number): DesignLayer {
  const out: DesignLayer = { ...l, x: (l.x ?? 0.5) + dx, y: (l.y ?? 0.5) + dy };
  if (l.kind === 'brush' && l.points) out.points = l.points.map((q) => ({ x: q.x + dx, y: q.y + dy }));
  return out;
}

/** 회전 고려한 점-레이어 히트 테스트 (스테이지 px 좌표) */
function hit(l: DesignLayer, px: number, py: number, W: number, H: number): boolean {
  const b = bboxOf(l, W, H);
  const cx = (l.x ?? 0.5) * W, cy = (l.y ?? 0.5) * H;
  let x = px, y = py;
  if (l.rotate) {
    const th = (-l.rotate * Math.PI) / 180;
    const dx = px - cx, dy = py - cy;
    x = cx + dx * Math.cos(th) - dy * Math.sin(th);
    y = cy + dx * Math.sin(th) + dy * Math.cos(th);
  }
  const pad = 6; // 가는 레이어도 잡히게
  return x >= b.x * W - pad && x <= (b.x + b.w) * W + pad && y >= b.y * H - pad && y <= (b.y + b.h) * H + pad;
}

function layerName(l: DesignLayer): string {
  if (l.name) return l.name;
  if (l.kind === 'text') return (l.text ?? '텍스트').split('\n')[0].slice(0, 14) || '텍스트';
  if (l.kind === 'rect') return l.shape === 'ellipse' ? '원' : '사각형';
  if (l.kind === 'icon') return ICONS[l.icon ?? '']?.label ?? '아이콘';
  if (l.kind === 'image') return '이미지';
  if (l.kind === 'brush') return '브러시';
  if (l.kind === 'blurpatch') return (l.effect === 'mosaic' ? '모자이크 영역' : '블러 영역');
  return '그라데이션';
}
const KIND_GLYPH: Record<string, string> = { text: 'T', rect: '▭', scrim: '▒', icon: '★', image: '🖼', brush: '✎', blurpatch: '▨' };

export default function DesignEditor(p: Props) {
  const W = p.base.size?.w ?? 1000;
  const H = p.base.size?.h ?? 1000;
  const S = Math.min(W, H);

  const [layers, setLayers] = useState<DesignLayer[]>(p.base.layers.map((l) => ({ ...l })));
  /*
   * 배경 fit(변형·보정)은 편집기가 소유한다 — 포토샵의 "배경 레이어 변형"에 해당.
   * zoom(크기)·fx/fy(위치)·adjust(밝기/대비/채도). 나갈 때 템플릿 방식으로 돌려준다.
   */
  const [fitState, setFitState] = useState<FitSpec>({
    mode: p.base.fit?.mode ?? 'cover',
    fx: p.base.fit?.fx ?? 0.5,
    fy: p.base.fit?.fy ?? 0.5,
    ...(p.base.fit?.fillColor ? { fillColor: p.base.fit.fillColor } : {}),
    ...(p.base.fit?.zoom ? { zoom: p.base.fit.zoom } : {}),
    ...(p.base.fit?.zoomX ? { zoomX: p.base.fit.zoomX } : {}),
    ...(p.base.fit?.zoomY ? { zoomY: p.base.fit.zoomY } : {}),
    ...(p.base.fit?.panX ? { panX: p.base.fit.panX } : {}),
    ...(p.base.fit?.panY ? { panY: p.base.fit.panY } : {}),
    ...(p.base.fit?.adjust ? { adjust: p.base.fit.adjust } : {}),
  });
  const [localFonts, setLocalFonts] = useState<string[]>([]);
  /*
   * 배경 URL — AI 도구(합성·지우개·아웃페인트)가 성공하면 여기가 새 이미지로 바뀐다.
   * 원본 자연 크기도 함께 다시 잰다 (배경 변형 계산에 필요).
   */
  const [bgUrl, setBgUrl] = useState(p.base.imageUrl);
  const [nat, setNat] = useState(p.srcDims);
  useEffect(() => {
    // 항상 비동기로 잰다 — 이펙트 안 동기 setState 를 피하면서 두 경우를 한 경로로
    const img = new window.Image();
    img.onload = () => setNat({ w: img.naturalWidth || 1000, h: img.naturalHeight || 1000 });
    img.src = bgUrl;
  }, [bgUrl]);

  /** 도구 — select(기본) / brush(자유 곡선). B 키로 토글 */
  const [tool, setTool] = useState<'select' | 'brush'>('select');
  const [brushW, setBrushW] = useState(0.012);
  const [brushColor, setBrushColor] = useState('#e2503c');
  const brushPts = useRef<{ x: number; y: number }[] | null>(null);

  /** AI 도구 상태 */
  const [aiBusy, setAiBusy] = useState<'merge' | 'erase' | 'outpaint' | null>(null);
  /*
   * 선택 — 포토샵처럼 Shift+클릭으로 여러 개를 모아 함께 끈다.
   * 핸들·속성 패널은 정확히 1개일 때만, 이동·복제·삭제·방향키는 전체에 적용.
   */
  const [selIds, setSelIds] = useState<Set<string>>(new Set());
  const selectOnly = useCallback((id: string) => setSelIds(new Set([id])), []);
  const toggleSel = useCallback((id: string) => setSelIds((cur) => {
    const n = new Set(cur);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  }), []);
  const clearSel = useCallback(() => setSelIds(new Set()), []);
  const [zoom, setZoom] = useState(0); // 0 = 화면 맞춤
  const [editing, setEditing] = useState<string | null>(null); // 인라인 텍스트 편집 중인 레이어
  const [busy, setBusy] = useState<'save' | 'preview' | 'upload' | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [guides, setGuides] = useState<{ v?: number; h?: number }>({});

  const wrapRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /**
   * 파일 선택이 채울 대상 레이어 — 빈 이미지 칸을 두 번 눌러 고르거나 "교체…" 로 왔을 때.
   * null 이면 새 이미지 레이어를 만든다 (툴바의 🖼 이미지).
   */
  const fillTargetRef = useRef<string | null>(null);
  function pickImageFor(id: string | null) { fillTargetRef.current = id; fileRef.current?.click(); }
  const editRef = useRef<HTMLTextAreaElement>(null);

  // ── 실행취소 — 조작 시작 때 스냅샷을 잡아두고, 끝날 때 확정한다 ──
  const past = useRef<DesignLayer[][]>([]);
  const future = useRef<DesignLayer[][]>([]);
  const pending = useRef<DesignLayer[] | null>(null);
  const begin = useCallback(() => {
    if (!pending.current) pending.current = layers.map((l) => ({ ...l }));
  }, [layers]);
  const commit = useCallback(() => {
    if (!pending.current) return;
    past.current.push(pending.current);
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    pending.current = null;
  }, []);
  const undo = useCallback(() => {
    pending.current = null;
    const prev = past.current.pop();
    if (!prev) return;
    setLayers((cur) => { future.current.push(cur.map((l) => ({ ...l }))); return prev; });
  }, []);
  const redo = useCallback(() => {
    const nxt = future.current.pop();
    if (!nxt) return;
    setLayers((cur) => { past.current.push(cur.map((l) => ({ ...l }))); return nxt; });
  }, []);

  /** 한 번짜리 변경 (버튼 클릭류) — 스냅샷 후 적용 */
  const apply = useCallback((fn: (cur: DesignLayer[]) => DesignLayer[]) => {
    begin(); setLayers(fn); commit();
  }, [begin, commit]);
  /** 연속 변경 중 (드래그·슬라이더) — begin 은 호출자가, commit 은 끝에 */
  const applyLive = useCallback((fn: (cur: DesignLayer[]) => DesignLayer[]) => setLayers(fn), []);

  const selLayer = selIds.size === 1 ? layers.find((l) => selIds.has(l.id)) ?? null : null;
  const selList = layers.filter((l) => selIds.has(l.id));

  // ── 줌 ──
  const [fitScale, setFitScale] = useState(0.4);
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const availW = el.clientWidth - 48, availH = el.clientHeight - 48;
      setFitScale(Math.max(0.05, Math.min(availW / W, availH / H)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);
  const scale = zoom || fitScale;
  const stW = W * scale, stH = H * scale;

  // ── SVG 미리보기 (저장본과 동일 렌더) ──
  const design: DesignDoc = useMemo(
    () => ({ ...p.base, imageUrl: bgUrl, layers, fit: fitState }),
    [p.base, bgUrl, layers, fitState],
  );
  const svg = useMemo(() => renderLayersToSvg(design, W, H), [design, W, H]);

  // ── 배경 미리보기 — 서버 fitToSize 와 같은 식 (zoom·위치·보정 포함) ──
  const fit = fitState;
  const fillColor = fit.fillColor ?? '#f2f0ec';
  const shade = (hex: string, d: number) => {
    const h = /^#?[0-9a-fA-F]{6}$/.test(hex) ? hex.replace('#', '') : 'f2f0ec';
    const cl = (v: number) => Math.max(0, Math.min(255, v + d));
    return `rgb(${cl(parseInt(h.slice(0, 2), 16))},${cl(parseInt(h.slice(2, 4), 16))},${cl(parseInt(h.slice(4, 6), 16))})`;
  };
  const bgZoom = fit.mode === 'cover' ? Math.max(1, fit.zoom ?? 1) : Math.max(0.15, Math.min(4, fit.zoom ?? 1));
  const bgBaseK = fit.mode === 'cover'
    ? Math.max(W / nat.w, H / nat.h)
    : Math.min(W / nat.w, H / nat.h);
  const bgZX = Math.max(0.15, Math.min(4, fit.zoomX ?? 1));
  const bgZY = Math.max(0.15, Math.min(4, fit.zoomY ?? 1));
  const bgW = nat.w * bgBaseK * bgZoom * bgZX;   // 캔버스 px 단위
  const bgH = nat.h * bgBaseK * bgZoom * bgZY;
  // 여백 안 이동 + 캔버스 밖으로 민 이동(pan) — 서버 렌더(design-fit)와 같은 식
  const bgLeft = fit.fx * (W - bgW) + (fit.panX ?? 0) * W;
  const bgTop = fit.fy * (H - bgH) + (fit.panY ?? 0) * H;
  const adjFilter = fit.adjust
    ? `brightness(${fit.adjust.brightness ?? 1}) contrast(${fit.adjust.contrast ?? 1}) saturate(${fit.adjust.saturate ?? 1})`
    : '';
  /** 배경을 드래그로 옮길 수 있는가 — 캔버스와 크기가 다를 때만 의미가 있다 */
  const bgMovableX = Math.abs(W - bgW) > 0.5;
  const bgMovableY = Math.abs(H - bgH) > 0.5;
  const patchFit = useCallback((patch: Partial<FitSpec>) => setFitState((cur) => ({ ...cur, ...patch })), []);

  // ── 포인터 조작 ──
  const drag = useRef<
    | { type: 'move'; grab: string; ids: string[]; sx: number; sy: number; start: Record<string, { x: number; y: number }> }
    | { type: 'resize'; id: string; handle: Handle; start: DesignLayer; sx: number; sy: number }
    | { type: 'rotate'; id: string; cx: number; cy: number }
    | { type: 'bgpan'; sx: number; sy: number; fx0: number; fy0: number }
    | null
  >(null);

  /** 이동 대상 — 선택된 것들 + 각자의 group 동료까지 한 몸으로 */
  const moveSetOf = useCallback((ids: Set<string>, cur: DesignLayer[]): string[] => {
    const groups = new Set(cur.filter((l) => ids.has(l.id) && l.group).map((l) => l.group as string));
    return cur.filter((l) => ids.has(l.id) || (l.group && groups.has(l.group))).map((l) => l.id);
  }, []);

  const stagePoint = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }; // 캔버스 px
  };

  const [liveBrush, setLiveBrush] = useState<{ x: number; y: number }[] | null>(null);
  // 레이어 이름 인라인 변경 — window.prompt 는 Next dev 가 막는다
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  function onStageDown(e: React.PointerEvent) {
    if (editing) return;
    const pt = stagePoint(e);

    // 브러시 도구 — 드래그가 곧 획이다
    if (tool === 'brush') {
      begin();
      brushPts.current = [{ x: pt.x / W, y: pt.y / H }];
      setLiveBrush(brushPts.current);
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    // 위(나중에 그려진) 레이어부터 잡는다
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (l.hidden || l.locked || l.kind === 'scrim') continue;
      if (hit(l, pt.x, pt.y, W, H)) {
        // Shift+클릭 = 선택에 더하거나 빼기 (누적 다중 선택) — 드래그는 시작하지 않는다
        if (e.shiftKey) { toggleSel(l.id); return; }

        // 선택 밖의 레이어를 잡으면 그것만 선택, 선택 안의 레이어면 묶음 그대로 끈다
        let ids = selIds.has(l.id) ? new Set(selIds) : new Set([l.id]);
        if (!selIds.has(l.id)) selectOnly(l.id);

        begin();
        let cur = layers;
        // Alt+드래그 = 복제해서 끌기 (포토샵)
        if (e.altKey) {
          const copies = layers.filter((x) => ids.has(x.id)).map((x) => ({ ...x, id: uid(), group: undefined }));
          cur = [...layers, ...copies];
          setLayers(cur);
          ids = new Set(copies.map((c) => c.id));
          setSelIds(ids);
        }
        const moveIds = moveSetOf(ids, cur);
        const start: Record<string, { x: number; y: number }> = {};
        for (const m of cur) if (moveIds.includes(m.id)) start[m.id] = { x: m.x ?? 0.5, y: m.y ?? 0.5 };
        drag.current = { type: 'move', grab: e.altKey ? [...ids][0] : l.id, ids: moveIds, sx: pt.x, sy: pt.y, start };
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        return;
      }
    }
    // 빈 곳: 클릭 = 선택 해제, 드래그 = 배경 이동 (Shift 는 다중선택 실수 방지로 제외)
    clearSel();
    if (!e.shiftKey && (bgMovableX || bgMovableY)) {
      drag.current = { type: 'bgpan', sx: pt.x, sy: pt.y, fx0: fit.fx, fy0: fit.fy };
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    }
  }

  function onHandleDown(e: React.PointerEvent, handle: Handle) {
    if (!selLayer) return;
    e.stopPropagation();
    begin();
    const pt = stagePoint(e);
    drag.current = { type: 'resize', id: selLayer.id, handle, start: { ...selLayer }, sx: pt.x, sy: pt.y };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }
  function onRotateDown(e: React.PointerEvent) {
    if (!selLayer) return;
    e.stopPropagation();
    begin();
    drag.current = { type: 'rotate', id: selLayer.id, cx: (selLayer.x ?? 0.5) * W, cy: (selLayer.y ?? 0.5) * H };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }

  function onStageMove(e: React.PointerEvent) {
    const pt = stagePoint(e);

    // 브러시 획 이어 그리기
    if (brushPts.current) {
      const last = brushPts.current[brushPts.current.length - 1];
      const minD = 2 / scale; // 화면 2px 이상 움직였을 때만 점 추가
      if (Math.hypot(pt.x - last.x * W, pt.y - last.y * H) >= minD) {
        brushPts.current = [...brushPts.current, { x: pt.x / W, y: pt.y / H }];
        setLiveBrush(brushPts.current);
      }
      return;
    }

    const d = drag.current;
    if (!d) return;

    if (d.type === 'bgpan') {
      // left = fx*(W-bgW) 이므로, 픽셀 이동량을 (W-bgW) 로 나누면 fx 변화량이 된다
      const nfx = bgMovableX ? d.fx0 + (pt.x - d.sx) / (W - bgW) : d.fx0;
      const nfy = bgMovableY ? d.fy0 + (pt.y - d.sy) / (H - bgH) : d.fy0;
      patchFit({ fx: Math.max(0, Math.min(1, nfx)), fy: Math.max(0, Math.min(1, nfy)) });
      return;
    }

    if (d.type === 'move') {
      let dx = (pt.x - d.sx) / W;
      let dy = (pt.y - d.sy) / H;
      // Shift = 수평/수직 축 고정 (포토샵)
      if (e.shiftKey) {
        if (Math.abs(dx * W) >= Math.abs(dy * H)) dy = 0; else dx = 0;
      }
      // 스냅 — 잡은 레이어의 중심 기준. Ctrl 로 끈다
      const g: { v?: number; h?: number } = {};
      const grabStart = d.start[d.grab];
      if (!e.ctrlKey && grabStart) {
        const th = 6 / scale;
        let nx = grabStart.x + dx, ny = grabStart.y + dy;
        const others = layers.filter((o) => !d.ids.includes(o.id) && !o.hidden);
        const targetsX = [0.5 * W, ...others.map((o) => (o.x ?? 0.5) * W)];
        const targetsY = [0.5 * H, ...others.map((o) => (o.y ?? 0.5) * H)];
        for (const t of targetsX) if (Math.abs(nx * W - t) < th) { nx = t / W; g.v = t; break; }
        for (const t of targetsY) if (Math.abs(ny * H - t) < th) { ny = t / H; g.h = t; break; }
        dx = nx - grabStart.x; dy = ny - grabStart.y;
      }
      setGuides(g);
      applyLive((cur) => cur.map((l) => {
        const st0 = d.start[l.id];
        if (!st0) return l;
        const moved = shiftLayer(l, st0.x - (l.x ?? 0.5) + dx, st0.y - (l.y ?? 0.5) + dy);
        return moved;
      }));
      return;
    }

    if (d.type === 'resize') {
      const st = d.start;
      const dxPx = pt.x - d.sx, dyPx = pt.y - d.sy;
      const sgnX = d.handle.includes('e') ? 1 : d.handle.includes('w') ? -1 : 0;
      const sgnY = d.handle.includes('s') ? 1 : d.handle.includes('n') ? -1 : 0;
      applyLive((cur) => cur.map((l) => {
        if (l.id !== d.id) return l;
        if (l.kind === 'text') {
          // 좌우 핸들 = 장평(가로만), 코너 = 크기(스케일) — 포토샵 Ctrl+T 감각
          if (sgnX && !sgnY) {
            const bw = bboxOf(st, W, H).w * W; // 시작 시점 가로폭 px
            const k = 1 + (sgnX * dxPx * 2) / Math.max(1, bw);
            return { ...l, scaleX: Math.max(0.3, Math.min(3, (st.scaleX ?? 1) * k)) };
          }
          const k = 1 + ((sgnX * dxPx + sgnY * dyPx) / (S * 0.5));
          return { ...l, size: Math.max(0.01, Math.min(0.6, (st.size ?? 0.06) * k)) };
        }
        if (l.kind === 'icon') {
          const k = 1 + ((sgnX * dxPx + sgnY * dyPx) / (S * 0.5));
          return { ...l, size: Math.max(0.01, Math.min(0.6, (st.size ?? 0.06) * k)) };
        }
        if (l.kind === 'brush') {
          // 코너 스케일 — 점 무리를 중심 기준으로 키운다
          const k = Math.max(0.2, Math.min(5, 1 + ((sgnX * dxPx + sgnY * dyPx) / (S * 0.5))));
          const cx0 = st.x ?? 0.5, cy0 = st.y ?? 0.5;
          return {
            ...l,
            strokeWidth: Math.max(0.002, (st.strokeWidth ?? 0.01) * k),
            points: (st.points ?? []).map((q) => ({ x: cx0 + (q.x - cx0) * k, y: cy0 + (q.y - cy0) * k })),
          };
        }
        if (l.kind === 'image') {
          // 시작 시점의 실제 표시 크기 (비율 무시 스트레치 지원)
          const stW = (st.w ?? 0.2) * W;
          const stH = st.h != null ? st.h * H : (st.srcAspect ? stW / st.srcAspect : 0.2 * H);
          if (sgnX && !sgnY) {   // 좌우 = 가로만 늘림
            const w = Math.max(0.02, Math.min(2, (st.w ?? 0.2) + (sgnX * dxPx * 2) / W));
            return { ...l, w, h: stH / H };
          }
          if (sgnY && !sgnX) {   // 상하 = 세로만 늘림
            const h = Math.max(0.02, Math.min(2, stH / H + (sgnY * dyPx * 2) / H));
            return { ...l, h };
          }
          // 코너 = 현재 비율 유지한 확대/축소
          const k = 1 + ((sgnX * dxPx + sgnY * dyPx) / Math.max(1, stW));
          const w = Math.max(0.02, Math.min(2, (st.w ?? 0.2) * k));
          return { ...l, w, ...(st.h != null ? { h: Math.max(0.02, (stH / H) * k) } : {}) };
        }
        // rect: 핸들 방향 축만 늘린다. Shift 로 비율 유지
        let w = st.w ?? 0.3, h = st.h ?? 0.1;
        if (sgnX) w = Math.max(0.01, (st.w ?? 0.3) + (sgnX * dxPx * 2) / W);
        if (sgnY) h = Math.max(0.01, (st.h ?? 0.1) + (sgnY * dyPx * 2) / H);
        if (e.shiftKey && sgnX && sgnY) {
          const k = Math.max(w / (st.w ?? 0.3), h / (st.h ?? 0.1));
          w = (st.w ?? 0.3) * k; h = (st.h ?? 0.1) * k;
        }
        return { ...l, w, h };
      }));
      return;
    }

    if (d.type === 'rotate') {
      let deg = (Math.atan2(pt.y - d.cy, pt.x - d.cx) * 180) / Math.PI + 90;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      deg = ((deg % 360) + 360) % 360;
      if (deg > 180) deg -= 360;
      applyLive((cur) => cur.map((l) => (l.id === d.id ? { ...l, rotate: Math.round(deg) || undefined } : l)));
    }
  }
  function onStageUp() {
    // 브러시 확정 — 점이 2개 이상이면 레이어로 굳힌다
    if (brushPts.current) {
      const pts = brushPts.current;
      brushPts.current = null;
      setLiveBrush(null);
      if (pts.length >= 2) {
        const cx0 = pts.reduce((a, q) => a + q.x, 0) / pts.length;
        const cy0 = pts.reduce((a, q) => a + q.y, 0) / pts.length;
        setLayers((cur) => [...cur, {
          id: uid(), kind: 'brush', points: pts, strokeWidth: brushW,
          x: cx0, y: cy0, color: brushColor, opacity: 1,
        }]);
        commit();
      } else {
        pending.current = null; // 점 하나짜리 클릭은 무효 — 스냅샷 버림
      }
      return;
    }
    if (drag.current) { drag.current = null; commit(); setGuides({}); }
  }

  // ── 키보드 ──
  useEffect(() => {
    /*
     * 단축키는 window 전역으로 듣는다 — 래퍼 포커스에 걸면 버튼 클릭 한 번에
     * 포커스가 새서 Ctrl+Z 가 "웹 기본동작"으로 흘러가 버린다 (사용자 실측).
     * 편집기가 떠 있는 동안은 어디를 클릭했든 포토샵처럼 항상 듣는다.
     * 입력창(input/textarea/select)에 타이핑 중일 때만 비켜준다.
     */
    const onKey = (e: KeyboardEvent) => {
      if (editing) return; // 텍스트 인라인 편집 중엔 캔버스 단축키 비활성
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); redo(); return; }
      if (mod && k === 'd') { e.preventDefault(); duplicateSel(); return; }
      if (mod && k === 'c') { e.preventDefault(); copySel(); return; }
      if (mod && k === 'x') { e.preventDefault(); copySel(); removeSel(); return; }
      if (mod && k === 'v') { e.preventDefault(); pasteClip(); return; }
      if (mod && k === '0') { e.preventDefault(); setZoom(0); return; }
      if (mod && (k === '=' || k === '+')) { e.preventDefault(); setZoom((z) => Math.min(4, (z || fitScale) * 1.25)); return; }
      if (mod && k === '-') { e.preventDefault(); setZoom((z) => Math.max(0.05, (z || fitScale) / 1.25)); return; }
      // Ctrl+] / [ = 순서 위/아래, +Shift = 맨앞/맨뒤 (포토샵)
      if (mod && (e.key === ']' || e.key === '[')) {
        e.preventDefault();
        const up = e.key === ']';
        const ids = new Set(selIds);
        if (!ids.size) return;
        apply((cur) => {
          const selected = cur.filter((l) => ids.has(l.id));
          const rest = cur.filter((l) => !ids.has(l.id));
          if (e.shiftKey) return up ? [...rest, ...selected] : [...selected, ...rest];
          const out = [...cur];
          const idxs = out.map((l, i) => (ids.has(l.id) ? i : -1)).filter((i) => i >= 0);
          const list = up ? [...idxs].reverse() : idxs;
          for (const i of list) {
            const j = i + (up ? 1 : -1);
            if (j < 0 || j >= out.length || ids.has(out[j].id)) continue;
            [out[i], out[j]] = [out[j], out[i]];
          }
          return out;
        });
        return;
      }
      // 도구 단축키 (포토샵 감각): T 텍스트 · R 사각형 · O 원 · U 아이콘 · P 이미지
      if (!mod && !e.altKey) {
        if (k === 't') { e.preventDefault(); addText(); return; }
        if (k === 'r') { e.preventDefault(); addRect('rect'); return; }
        if (k === 'o') { e.preventDefault(); addRect('ellipse'); return; }
        if (k === 'u') { e.preventDefault(); addIcon(); return; }
        if (k === 'p') { e.preventDefault(); pickImageFor(null); return; }
        if (k === 'b') { e.preventDefault(); setTool((t) => (t === 'brush' ? 'select' : 'brush')); return; }
        if (k === 'v') { e.preventDefault(); setTool('select'); return; }
      }
      if (e.key === 'Escape' && tool === 'brush') { setTool('select'); return; }
      if (!selIds.size) { if (e.key === 'Escape') clearSel(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSel(); return; }
      const step = (e.shiftKey ? 10 : 1);
      const move = (dx: number, dy: number) => {
        e.preventDefault();
        const ids = new Set(selIds);
        apply((cur) => cur.map((l) => (ids.has(l.id) ? shiftLayer(l, dx / W, dy / H) : l)));
      };
      if (e.key === 'ArrowLeft') move(-step, 0);
      else if (e.key === 'ArrowRight') move(step, 0);
      else if (e.key === 'ArrowUp') move(0, -step);
      else if (e.key === 'ArrowDown') move(0, step);
      else if (e.key === 'Escape') clearSel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selIds, editing, layers, undo, redo, apply, fitScale, tool]);

  // ── 레이어 조작 ──
  const patchSel = useCallback((patch: Partial<DesignLayer>, live = false) => {
    const id = selLayer?.id;
    if (!id) return;
    (live ? applyLive : apply)((cur) => cur.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }, [selLayer, apply, applyLive]);

  function addLayer(l: DesignLayer) { apply((cur) => [...cur, l]); selectOnly(l.id); }
  function addText() {
    addLayer({ id: uid(), kind: 'text', x: 0.5, y: 0.5, text: '텍스트를 입력하세요', size: 0.07, weight: 700, color: '#1b1d21', opacity: 1, align: 'middle', lineHeight: 1.25 });
  }
  function addRect(shape: 'rect' | 'ellipse') {
    addLayer({ id: uid(), kind: 'rect', shape, x: 0.5, y: 0.5, w: shape === 'ellipse' ? 0.24 : 0.3, h: shape === 'ellipse' ? 0.24 * (W / H) : 0.12, radius: shape === 'ellipse' ? 0 : 0.02, color: '#e2503c', opacity: 1 });
  }
  function addBlurpatch() {
    addLayer({
      id: uid(), kind: 'blurpatch', x: 0.5, y: 0.5, w: 0.26, h: 0.2,
      effect: 'blur', strength: 0.5, color: '#000000', opacity: 1,
    });
  }
  function addIcon() {
    addLayer({ id: uid(), kind: 'icon', icon: 'star', x: 0.5, y: 0.5, size: 0.08, stroke: 0.09, color: '#1b1d21', opacity: 1 });
  }
  async function addImage(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    setBusy('upload'); setErr('');
    try {
      const shrunk = await shrinkForUpload(f);
      const fd = new FormData();
      fd.append('file', shrunk.file);
      fd.append('title', f.name);
      fd.append('register', '0');       // 보관함엔 넣지 않는다 — 이 배너의 재료일 뿐
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || '업로드 실패'); return; }
      const aspect = (j.width && j.height) ? j.width / j.height : 1;
      const target = fillTargetRef.current;
      fillTargetRef.current = null;
      if (target && layers.some((x) => x.id === target)) {
        // 빈 칸(또는 기존 이미지)을 그 자리·크기 그대로 채운다 — 칸은 고정, 사진만 들어간다
        apply((cur) => cur.map((x) => (x.id === target
          ? {
              ...x, kind: 'image' as const, src: j.url, srcAspect: aspect,
              cover: x.cover ?? true, srcFx: 0.5, srcFy: 0.5, srcZoom: 1,
              name: x.name?.startsWith('우측 이미지') ? '우측 이미지' : x.name,
            }
          : x)));
        selectOnly(target);
      } else {
        addLayer({
          id: uid(), kind: 'image', src: j.url, srcAspect: aspect,
          x: 0.5, y: 0.5, w: 0.25, color: '#fff', opacity: 1,
        });
      }
    } catch (e) { setErr((e as Error).message); } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }
  function removeSel() {
    if (!selIds.size) return;
    const ids = new Set(selIds);
    apply((cur) => cur.filter((l) => !ids.has(l.id)));
    clearSel();
  }
  function duplicateSel() {
    if (!selList.length) return;
    const copies = selList.map((l) => ({ ...shiftLayer(l, 8 / W, 8 / H), id: uid(), group: undefined }));
    apply((cur) => [...cur, ...copies]);
    setSelIds(new Set(copies.map((c) => c.id)));
  }
  /** 클립보드 (Ctrl+C/X/V) — 편집기 안에서만 도는 레이어 복사판 */
  const clip = useRef<DesignLayer[]>([]);
  function copySel() { if (selList.length) clip.current = selList.map((l) => ({ ...l })); }
  function pasteClip() {
    if (!clip.current.length) return;
    const copies = clip.current.map((l) => ({ ...shiftLayer(l, 10 / W, 10 / H), id: uid(), group: undefined }));
    apply((cur) => [...cur, ...copies]);
    setSelIds(new Set(copies.map((c) => c.id)));
  }
  /** 캔버스 기준 정렬 — 바운딩박스를 좌/중/우·상/중/하에 붙인다 */
  function alignSel(mode: 'l' | 'cx' | 'r' | 't' | 'cy' | 'b') {
    if (!selLayer) return;
    const b = bboxOf(selLayer, W, H);
    const m = 0.04; // 가장자리 여백
    const patch: Partial<DesignLayer> = {};
    if (mode === 'l') patch.x = (selLayer.x ?? 0.5) + (m - b.x);
    if (mode === 'cx') patch.x = (selLayer.x ?? 0.5) + (0.5 - (b.x + b.w / 2));
    if (mode === 'r') patch.x = (selLayer.x ?? 0.5) + ((1 - m) - (b.x + b.w));
    if (mode === 't') patch.y = (selLayer.y ?? 0.5) + (m - b.y);
    if (mode === 'cy') patch.y = (selLayer.y ?? 0.5) + (0.5 - (b.y + b.h / 2));
    if (mode === 'b') patch.y = (selLayer.y ?? 0.5) + ((1 - m) - (b.y + b.h));
    apply((cur) => cur.map((l) => (l.id === selLayer.id ? shiftLayer(l, (patch.x ?? l.x ?? 0.5) - (l.x ?? 0.5), (patch.y ?? l.y ?? 0.5) - (l.y ?? 0.5)) : l)));
  }

  /** PC 에 깔린 폰트 목록 — 크롬/엣지의 queryLocalFonts (권한 팝업 1회) */
  async function loadLocalFonts() {
    try {
      const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
      if (!q) { setErr('이 브라우저는 PC 폰트 목록을 지원하지 않습니다 (크롬·엣지에서 가능)'); return; }
      const list = await q.call(window);
      setLocalFonts([...new Set(list.map((f) => f.family))].sort((a, b) => a.localeCompare(b, 'ko')));
      setNote('PC 폰트를 불러왔습니다 — 로컬 저장본에도 그대로 적용됩니다.');
    } catch { setErr('PC 폰트 접근이 거부되었습니다.'); }
  }

  function reorder(id: string, dir: 1 | -1) {
    apply((cur) => {
      const i = cur.findIndex((l) => l.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= cur.length) return cur;
      const out = [...cur];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });
  }

  /*
   * AI 도구 — 나노바나나 1회 호출 (앱 생성과 같은 실측 단가 ₩230~314 수준).
   * 성공하면 결과가 새 배경이 되고(변형 초기화), 재료로 쓴 레이어는 지운다.
   */
  async function runAi(op: 'merge' | 'erase' | 'outpaint') {
    if (aiBusy) return;
    const target = selLayer;
    const payload: Record<string, unknown> = {
      op, imageUrl: bgUrl, size: { w: W, h: H }, fit: fitState, layers,
    };
    if (op === 'merge') {
      if (!target || target.kind !== 'image' || !target.src) { setErr('먼저 합성할 이미지 레이어를 선택하세요.'); return; }
      payload.overlay = { src: target.src, x: target.x ?? 0.5, y: target.y ?? 0.5, w: target.w ?? 0.2, h: target.h ?? 0.2, srcAspect: target.h != null ? undefined : target.srcAspect };
    }
    if (op === 'erase') {
      if (!target || (target.kind !== 'rect' && target.kind !== 'blurpatch')) { setErr('지울 개체 위에 사각형(또는 블러영역)을 올리고 선택하세요.'); return; }
      payload.overlay = { x: target.x ?? 0.5, y: target.y ?? 0.5, w: target.w ?? 0.3, h: target.h ?? 0.2 };
    }
    setAiBusy(op); setErr(''); setNote('');
    try {
      const r = await fetch('/api/design/ai', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'AI 처리 실패'); return; }
      begin();
      if ((op === 'merge' || op === 'erase') && target) {
        setLayers((cur) => cur.filter((l) => l.id !== target.id));
        clearSel();
      }
      commit();
      setBgUrl(j.url);
      setFitState({ mode: 'cover', fx: 0.5, fy: 0.5 }); // 결과에 구워졌으니 변형 초기화
      setNote(op === 'merge' ? 'AI 합성 완료 — 배경에 구워졌습니다.' : op === 'erase' ? 'AI 지우개 완료.' : 'AI 아웃페인트 완료.');
    } catch (e) { setErr((e as Error).message); } finally { setAiBusy(null); }
  }

  // ── 저장·미리보기 ──
  async function render(save: boolean) {
    setBusy(save ? 'save' : 'preview'); setErr(''); setNote('');
    try {
      const r = await fetch('/api/design', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ design, save, sourceId: p.sourceId }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || '실패'); return; }
      if (save) { setNote('저장했습니다 — 배너 디자인 관리에서 볼 수 있습니다.'); p.onSaved?.(); }
      else setPreview(j.preview);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  // ── 선택 크롬 좌표 ──
  const selBox = selLayer ? bboxOf(selLayer, W, H) : null;

  const num = (v: number | undefined, d = 0) => (v ?? d);
  const pct = (v: number) => Math.round(v * 1000) / 10;

  const inputCls = 'w-full px-1.5 py-1 text-[12px] rounded-[8px]';
  const inputStyle: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text)' };
  const row = 'flex items-center gap-1.5 mb-1.5';
  const lbl = { className: 'text-[10px] w-[52px] shrink-0', style: { color: 'var(--text-mute)' } as React.CSSProperties };

  return (
    <div ref={wrapRef} tabIndex={0} className="fixed inset-0 z-40 flex flex-col outline-none"
         style={{ background: '#101216' }}>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => addImage(e.target.files)} />

      {/* ── 툴바 ── */}
      <div className="flex items-center gap-1.5 px-3 h-[46px] shrink-0"
           style={{ background: 'var(--surface)', borderBottom: '1px solid var(--line)' }}>
        <button className="btn text-[12px]" onClick={() => p.onExit(layers, fitState, bgUrl)}>← 템플릿 방식</button>
        <span className="mx-1" style={{ color: 'var(--line-strong)' }}>|</span>
        <button className="chip" title="텍스트 추가" onClick={addText}>T 텍스트</button>
        <button className="chip" title="사각형 추가" onClick={() => addRect('rect')}>▭ 사각형</button>
        <button className="chip" title="원 추가" onClick={() => addRect('ellipse')}>○ 원</button>
        <button className="chip" title="아이콘 추가" onClick={addIcon}>★ 아이콘</button>
        <button className="chip" title="이미지(로고·뱃지) 추가 (P)" onClick={() => pickImageFor(null)} disabled={busy === 'upload'}>
          {busy === 'upload' ? '올리는 중…' : '🖼 이미지'}
        </button>
        {BRUSH_ENABLED && (
          <button className="chip" title="브러시 — 드래그로 자유 곡선 그리기 (B, Esc 로 종료)"
                  onClick={() => setTool((t) => (t === 'brush' ? 'select' : 'brush'))}
                  style={tool === 'brush' ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
            ✎ 브러시
          </button>
        )}
        <button className="chip" title="블러/모자이크 영역 — 배경 사진의 얼굴·번호판 가리기" onClick={addBlurpatch}>
          ▨ 블러영역
        </button>
        <span className="mx-1" style={{ color: 'var(--line-strong)' }}>|</span>
        <button className="chip" title="실행취소 (Ctrl+Z)" onClick={undo}>↶</button>
        <button className="chip" title="다시실행 (Ctrl+Y)" onClick={redo}>↷</button>
        <span className="mx-1" style={{ color: 'var(--line-strong)' }}>|</span>
        <button className="chip" onClick={() => setZoom((z) => Math.max(0.05, (z || fitScale) / 1.25))}>−</button>
        <button className="chip tabular-nums" title="화면 맞춤" onClick={() => setZoom(0)}>{Math.round(scale * 100)}%</button>
        <button className="chip" onClick={() => setZoom((z) => Math.min(4, (z || fitScale) * 1.25))}>＋</button>

        <span className="ml-auto text-[11px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
          {p.sizeLabel ?? ''} {W}×{H}
        </span>
        {note && <span className="text-[11px]" style={{ color: 'var(--ok)' }}>{note}</span>}
        {err && <span className="text-[11px]" style={{ color: 'var(--danger)' }}>{err}</span>}
        <button className="btn text-[12px]" onClick={() => render(false)} disabled={!!busy}>
          {busy === 'preview' ? '만드는 중…' : '미리보기'}
        </button>
        <button className="btn btn-primary text-[12px]" onClick={() => render(true)} disabled={!!busy}>
          {busy === 'save' ? '저장 중…' : '저장'}
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* ── 레이어 패널 ── */}
        <div className="w-[210px] shrink-0 overflow-y-auto p-2"
             style={{ background: 'var(--surface)', borderRight: '1px solid var(--line)' }}>
          <div className="label mb-1.5">레이어</div>
          {[...layers].reverse().map((l) => (
            <div key={l.id}
                 onClick={(e) => (e.shiftKey ? toggleSel(l.id) : selectOnly(l.id))}
                 draggable
                 onDragStart={(e) => { e.dataTransfer.setData('text/plain', l.id); e.dataTransfer.effectAllowed = 'move'; }}
                 onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                 onDrop={(e) => {
                   e.preventDefault();
                   const fromId = e.dataTransfer.getData('text/plain');
                   if (!fromId || fromId === l.id) return;
                   // 끌어다 놓은 자리 '위'(패널 기준)로 옮긴다 = layers 배열에서 대상 인덱스로 이동
                   apply((cur) => {
                     const from = cur.findIndex((x) => x.id === fromId);
                     const to = cur.findIndex((x) => x.id === l.id);
                     if (from < 0 || to < 0) return cur;
                     const out = [...cur];
                     const [m] = out.splice(from, 1);
                     out.splice(to, 0, m);
                     return out;
                   });
                 }}
                 className="flex items-center gap-1 px-1.5 py-1 rounded-[8px] mb-0.5 cursor-pointer"
                 style={{
                   background: selIds.has(l.id) ? 'var(--accent-soft)' : 'transparent',
                   border: '1px solid ' + (selIds.has(l.id) ? 'var(--accent)' : 'transparent'),
                   opacity: l.hidden ? 0.45 : 1,
                 }}>
              <button title={l.hidden ? '보이기' : '숨기기'}
                      onClick={(e) => { e.stopPropagation(); apply((cur) => cur.map((x) => (x.id === l.id ? { ...x, hidden: !x.hidden } : x))); }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-mute)', padding: 0, width: 16 }}>
                {l.hidden ? '◌' : '●'}
              </button>
              <button title={l.locked ? '잠금 해제' : '잠금'}
                      onClick={(e) => { e.stopPropagation(); apply((cur) => cur.map((x) => (x.id === l.id ? { ...x, locked: !x.locked } : x))); }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: l.locked ? 'var(--warn)' : 'var(--text-mute)', padding: 0, width: 14 }}>
                {l.locked ? '🔒' : '·'}
              </button>
              <span className="text-[10px] w-[14px] text-center" style={{ color: 'var(--text-mute)' }}>{KIND_GLYPH[l.kind]}</span>
              {renaming?.id === l.id ? (
                <input
                  autoFocus
                  value={renaming.value}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenaming({ id: l.id, value: e.target.value })}
                  onBlur={() => {
                    const v = renaming.value.trim();
                    if (v) apply((cur) => cur.map((x) => (x.id === l.id ? { ...x, name: v } : x)));
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  className="text-[11px] flex-1 min-w-0 px-1 rounded"
                  style={{ background: 'var(--surface-2)', border: '1px solid var(--accent)', color: 'var(--text)' }}
                />
              ) : (
                <span className="text-[11px] truncate flex-1"
                      style={{ color: 'var(--text-dim)' }}
                      title="더블클릭 = 이름 변경"
                      onDoubleClick={(e) => { e.stopPropagation(); setRenaming({ id: l.id, value: layerName(l) }); }}>
                  {layerName(l)}
                </span>
              )}
              <button title="위로" onClick={(e) => { e.stopPropagation(); reorder(l.id, 1); }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-mute)', padding: 0 }}>▲</button>
              <button title="아래로" onClick={(e) => { e.stopPropagation(); reorder(l.id, -1); }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-mute)', padding: 0 }}>▼</button>
            </div>
          ))}
          {!layers.length && (
            <div className="text-[11px] p-2" style={{ color: 'var(--text-mute)' }}>
              레이어가 없습니다. 위 도구로 추가하세요.
            </div>
          )}
          {/*
            * 배경(원본) 이미지 — 진짜 레이어는 아니지만 목록에서 함께 관리한다.
            * 맨 아래 행 = 제일 뒤에 깔린 것. 누르면 선택이 풀리며 배경 모드가 되어
            * 우측 패널에 배경 변형(Ctrl+T)·보정이 뜬다. 선택이 없을 때 = 배경 선택 상태.
            */}
          <div onClick={clearSel}
               title="배경 이미지 — 누르면 우측에 배경 변형(크기·위치)·보정(밝기·대비·채도)이 뜹니다"
               className="flex items-center gap-1.5 px-1.5 py-1 rounded-[8px] mt-1 cursor-pointer"
               style={{
                 background: selIds.size === 0 ? 'var(--accent-soft)' : 'transparent',
                 border: '1px solid ' + (selIds.size === 0 ? 'var(--accent)' : 'var(--line)'),
               }}>
            <span className="text-[10px] w-[14px] text-center" style={{ color: 'var(--text-mute)' }}>🖼</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={bgUrl} alt="" className="w-[18px] h-[18px] object-cover rounded shrink-0"
                 style={{ border: '1px solid var(--line)' }} draggable={false} />
            <span className="text-[11px] truncate flex-1" style={{ color: 'var(--text-dim)' }}>배경 이미지</span>
            <span className="text-[9px]" style={{ color: 'var(--text-mute)' }}>원본</span>
          </div>
        </div>

        {/* ── 캔버스 ── */}
        <div ref={viewRef} className="flex-1 min-w-0 overflow-auto flex items-center justify-center"
             onWheel={(e) => {
               if (!e.ctrlKey) return;
               e.preventDefault();
               setZoom((z) => Math.max(0.05, Math.min(4, (z || fitScale) * (e.deltaY < 0 ? 1.1 : 0.9))));
             }}>
          <div className="p-6">
            <div ref={stageRef}
                 onPointerDown={onStageDown}
                 onPointerMove={onStageMove}
                 onPointerUp={onStageUp}
                 onPointerLeave={onStageUp}
                 onDoubleClick={(e) => {
                   const pt = stagePoint(e);
                   for (let i = layers.length - 1; i >= 0; i--) {
                     const l = layers[i];
                     if (l.hidden || l.locked || !hit(l, pt.x, pt.y, W, H)) continue;
                     if (l.kind === 'text') { setEditing(l.id); return; }
                     // 아직 사진이 없는 이미지 칸 — 두 번 누르면 바로 사진 고르기
                     if (l.kind === 'rect' && l.name?.startsWith('우측 이미지 자리')) {
                       selectOnly(l.id); pickImageFor(l.id); return;
                     }
                     // 이미지·도형은 두 번 누르면 오른쪽 설정(크기 등)으로 — 선택만 해주면 패널이 그 레이어로 바뀐다
                     selectOnly(l.id);
                     return;
                   }
                 }}
                 className="relative select-none"
                 style={{ width: stW, height: stH, background: 'var(--surface-2)', touchAction: 'none',
                          boxShadow: '0 8px 40px rgba(0,0,0,.5)', cursor: drag.current ? 'grabbing' : 'default' }}>
              {/* 배경 — 서버 fitToSize 와 같은 식 (zoom·위치 명시 크기, 보정 filter) */}
              <div className="absolute inset-0 overflow-hidden">
                {fit.mode === 'blur' && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={bgUrl} alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover"
                       style={{ filter: `blur(18px) brightness(0.82)${adjFilter ? ' ' + adjFilter : ''}`, transform: 'scale(1.1)' }} draggable={false} />
                )}
                {(fit.mode === 'color' || fit.mode === 'gradient') && (
                  <div className="absolute inset-0" aria-hidden
                       style={fit.mode === 'gradient'
                         ? { background: `linear-gradient(${shade(fillColor, 22)}, ${shade(fillColor, -26)})` }
                         : { background: fillColor }} />
                )}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={bgUrl} alt="배경" draggable={false}
                     className="absolute"
                     style={{
                       width: `${(bgW / W) * 100}%`, height: `${(bgH / H) * 100}%`,
                       left: `${(bgLeft / W) * 100}%`, top: `${(bgTop / H) * 100}%`,
                       maxWidth: 'none',
                       ...(adjFilter ? { filter: adjFilter } : {}),
                     }} />
              </div>
              {/* 블러/모자이크 영역 미리보기 — backdrop-filter 로 근사 (저장은 서버가 정확히 굽는다) */}
              {layers.map((l) => {
                if (l.kind !== 'blurpatch' || l.hidden) return null;
                const st = l.strength ?? 0.5;
                const blurPx = l.effect === 'mosaic' ? 6 + st * 10 : 4 + st * 18;
                // 회전까지 그대로 — bbox 로 그리면 기울여도 화면에선 똑바로 서 보였다 (서버 렌더와 불일치)
                const pw = (l.w ?? 0.3) * stW, ph = (l.h ?? 0.2) * stH;
                return (
                  <div key={l.id} className="absolute pointer-events-none flex items-center justify-center"
                       style={{
                         left: (l.x ?? 0.5) * stW - pw / 2, top: (l.y ?? 0.5) * stH - ph / 2,
                         width: pw, height: ph,
                         ...(l.rotate ? { transform: `rotate(${l.rotate}deg)` } : {}),
                         backdropFilter: `blur(${blurPx}px)`, WebkitBackdropFilter: `blur(${blurPx}px)`,
                         outline: '1px dashed rgba(255,255,255,.55)',
                       }}>
                    {l.effect === 'mosaic' && (
                      <span className="text-[9px] px-1 rounded" style={{ background: 'rgba(0,0,0,.5)', color: '#fff' }}>
                        모자이크 (저장 시 픽셀화)
                      </span>
                    )}
                  </div>
                );
              })}

              {/* 저장본과 같은 SVG */}
              <div className="absolute inset-0 pointer-events-none"
                   dangerouslySetInnerHTML={{ __html: svg.replace('<svg ', '<svg style="width:100%;height:100%;display:block" ') }} />

              {/* 그리는 중인 브러시 획 — 실시간 미리보기 */}
              {liveBrush && liveBrush.length >= 2 && (
                <svg className="absolute inset-0 pointer-events-none" style={{ width: '100%', height: '100%' }}
                     viewBox={`0 0 ${W} ${H}`}>
                  <path
                    d={liveBrush.map((q, i) => `${i === 0 ? 'M' : 'L'} ${(q.x * W).toFixed(1)} ${(q.y * H).toFixed(1)}`).join(' ')}
                    fill="none" stroke={brushColor} strokeWidth={Math.max(0.5, brushW * S)}
                    strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}

              {/* 스냅 가이드 */}
              {guides.v != null && (
                <div className="absolute pointer-events-none" style={{ left: guides.v * scale, top: 0, bottom: 0, width: 1, background: '#ff33aa' }} />
              )}
              {guides.h != null && (
                <div className="absolute pointer-events-none" style={{ top: guides.h * scale, left: 0, right: 0, height: 1, background: '#ff33aa' }} />
              )}

              {/* 다중 선택 — 각자 파란 테두리만 (핸들은 1개 선택일 때) */}
              {selIds.size > 1 && selList.map((l) => {
                const b = bboxOf(l, W, H);
                return (
                  <div key={l.id} className="absolute pointer-events-none"
                       style={{
                         left: b.x * stW, top: b.y * stH,
                         width: Math.max(8, b.w * stW), height: Math.max(8, b.h * stH),
                         transform: l.rotate ? `rotate(${l.rotate}deg)` : undefined,
                         border: '1.5px solid #4c9ffe', boxShadow: '0 0 0 1px rgba(0,0,0,.35)',
                       }} />
                );
              })}

              {/* 선택 크롬 — 바운딩·8핸들·회전 스틱 */}
              {selLayer && selBox && !selLayer.hidden && (
                <div className="absolute pointer-events-none"
                     style={{
                       left: selBox.x * stW, top: selBox.y * stH,
                       width: Math.max(8, selBox.w * stW), height: Math.max(8, selBox.h * stH),
                       transform: selLayer.rotate ? `rotate(${selLayer.rotate}deg)` : undefined,
                       transformOrigin: `${((selLayer.x ?? 0.5) - selBox.x) * stW / Math.max(1e-6, selBox.w * stW) * 100}% ${((selLayer.y ?? 0.5) - selBox.y) * stH / Math.max(1e-6, selBox.h * stH) * 100}%`,
                       border: '1.5px solid #4c9ffe', boxShadow: '0 0 0 1px rgba(0,0,0,.4)',
                     }}>
                  {!selLayer.locked && HANDLES.map((h) => {
                    const pos: React.CSSProperties = { position: 'absolute', width: 9, height: 9, background: '#fff', border: '1.5px solid #4c9ffe', borderRadius: 2, pointerEvents: 'auto' };
                    if (h.includes('n')) pos.top = -5; if (h.includes('s')) pos.bottom = -5;
                    if (h.includes('w')) pos.left = -5; if (h.includes('e')) pos.right = -5;
                    if (h === 'n' || h === 's') { pos.left = '50%'; pos.marginLeft = -4.5; }
                    if (h === 'e' || h === 'w') { pos.top = '50%'; pos.marginTop = -4.5; }
                    const cursors: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
                    pos.cursor = cursors[h];
                    // 텍스트: 좌우=장평·코너=크기 (상하 없음) / 아이콘: 코너만 / 이미지·도형: 전부
                    if (selLayer.kind === 'text' && (h === 'n' || h === 's')) return null;
                    if (selLayer.kind === 'icon' && (h === 'n' || h === 's' || h === 'e' || h === 'w')) return null;
                    return <div key={h} style={pos} onPointerDown={(e) => onHandleDown(e, h)} />;
                  })}
                  {!selLayer.locked && (
                    <>
                      <div style={{ position: 'absolute', left: '50%', top: -26, width: 1, height: 20, background: '#4c9ffe' }} />
                      <div title="회전 (Shift = 15°)"
                           onPointerDown={onRotateDown}
                           style={{ position: 'absolute', left: '50%', top: -34, marginLeft: -6, width: 12, height: 12, borderRadius: 12, background: '#fff', border: '1.5px solid #4c9ffe', cursor: 'grab', pointerEvents: 'auto' }} />
                    </>
                  )}
                </div>
              )}

              {/* 인라인 텍스트 편집 */}
              {editing && (() => {
                const l = layers.find((x) => x.id === editing);
                if (!l) return null;
                const b = bboxOf(l, W, H);
                const fs = (l.size ?? 0.06) * S * scale;
                return (
                  <textarea
                    ref={editRef}
                    autoFocus
                    defaultValue={l.text ?? ''}
                    onFocus={() => begin()}
                    onBlur={(e) => { patchSel({}); apply((cur) => cur.map((x) => (x.id === editing ? { ...x, text: e.target.value } : x))); setEditing(null); }}
                    onKeyDown={(e) => { if (e.key === 'Escape') { (e.target as HTMLTextAreaElement).blur(); } e.stopPropagation(); }}
                    className="absolute resize-none outline-none"
                    style={{
                      left: b.x * stW - 4, top: b.y * stH - 4,
                      width: Math.max(120, b.w * stW + 40), height: Math.max(fs * 1.6, b.h * stH + 16),
                      fontFamily: FONT_STACK, fontSize: fs, fontWeight: l.weight ?? 700,
                      lineHeight: String(l.lineHeight ?? 1.25),
                      textAlign: l.align === 'start' ? 'left' : l.align === 'end' ? 'right' : 'center',
                      color: l.color, background: 'rgba(0,0,0,.35)', border: '1px dashed #4c9ffe',
                    }}
                  />
                );
              })()}
            </div>
          </div>
        </div>

        {/* ── 속성 패널 ── */}
        <div className="w-[248px] shrink-0 overflow-y-auto p-2.5"
             style={{ background: 'var(--surface)', borderLeft: '1px solid var(--line)' }}>
          {selIds.size > 1 ? (
            <div>
              <div className="label mb-2">{selIds.size}개 선택됨</div>
              <div className="flex gap-1.5 mb-2">
                <button className="btn flex-1 text-[12px]" onClick={duplicateSel}>⧉ 복제</button>
                <button className="btn flex-1 text-[12px]" style={{ color: 'var(--danger)' }} onClick={removeSel}>🗑 삭제</button>
              </div>
              <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
                드래그하면 <b style={{ color: 'var(--text-dim)' }}>묶음으로 함께</b> 움직입니다.<br />
                Shift+클릭으로 더하거나 뺄 수 있어요.<br />
                방향키 · Del · Ctrl+C/V/D 전부 묶음 적용.
              </div>
            </div>
          ) : tool === 'brush' && !selLayer ? (
            <div>
              <div className="label mb-1.5">✎ 브러시</div>
              <div className={row}>
                <span {...lbl}>굵기</span>
                <input className="flex-1" type="range" min={0.002} max={0.08} step={0.002} value={brushW}
                       onChange={(e) => setBrushW(Number(e.target.value))} />
              </div>
              <div className={row}>
                <span {...lbl}>색</span>
                <input type="color" value={brushColor} onChange={(e) => setBrushColor(e.target.value)}
                       style={{ width: 34, height: 24, padding: 0, border: '1px solid var(--line)', borderRadius: 6, background: 'none' }} />
                <input className={inputCls} style={inputStyle} value={brushColor}
                       onChange={(e) => setBrushColor(e.target.value)} />
              </div>
              <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
                캔버스를 드래그해 자유 곡선을 그립니다.<br />
                획마다 레이어가 되어 나중에 옮기고 지울 수 있어요.<br />
                <b style={{ color: 'var(--text-dim)' }}>Esc</b> 또는 V 로 선택 도구 복귀.
              </div>
            </div>
          ) : !selLayer ? (
            <div>
              <div className="label mb-1.5">배경 (사진)</div>
              {/*
               * 크기 = 비율 유지 확대/축소 하나로 통일 (사용자 확정 — "가로/세로 늘림이 아니라
               * 비율대로"). 축별 스트레치(zoomX/zoomY)는 데이터로는 남아 저장본 호환되지만
               * 슬라이더는 뺐다 — 필요하면 캔버스의 좌우/상하 핸들이 그 역할을 한다.
               */}
              <div className={row}>
                <span {...lbl}>크기 (비율)</span>
                <input className="flex-1" type="range"
                       min={fit.mode === 'cover' ? 1 : 0.2} max={3} step={0.02}
                       value={bgZoom}
                       onChange={(e) => patchFit({ zoom: Number(e.target.value) })} />
                <span className="text-[10.5px] tabular-nums w-[38px] text-right" style={{ color: 'var(--text-dim)' }}>
                  {Math.round(bgZoom * 100)}%
                </span>
              </div>
              <div className={row}>
                <span {...lbl}>가로 위치</span>
                <input className="flex-1" type="range" min={0} max={1} step={0.01} value={fit.fx}
                       disabled={!bgMovableX}
                       onChange={(e) => patchFit({ fx: Number(e.target.value) })} />
              </div>
              <div className={row}>
                <span {...lbl}>세로 위치</span>
                <input className="flex-1" type="range" min={0} max={1} step={0.01} value={fit.fy}
                       disabled={!bgMovableY}
                       onChange={(e) => patchFit({ fy: Number(e.target.value) })} />
              </div>
              <div className="text-[10px] mb-2" style={{ color: 'var(--text-mute)' }}>
                캔버스의 빈 곳을 드래그해도 배경이 움직입니다{fit.mode === 'cover' ? ' (크기를 100% 넘게 키우면)' : ''}.
              </div>

              <div className="label mb-1.5">배경 보정</div>
              {([['brightness', '밝기'], ['contrast', '대비'], ['saturate', '채도']] as const).map(([k, name]) => (
                <div className={row} key={k}>
                  <span {...lbl}>{name}</span>
                  <input className="flex-1" type="range" min={0.4} max={1.8} step={0.02}
                         value={fit.adjust?.[k] ?? 1}
                         onChange={(e) => {
                           const v = Number(e.target.value);
                           const next = { ...(fit.adjust ?? {}), [k]: v };
                           const allOne = (next.brightness ?? 1) === 1 && (next.contrast ?? 1) === 1 && (next.saturate ?? 1) === 1;
                           patchFit({ adjust: allOne ? undefined : next });
                         }} />
                  <span className="text-[10.5px] tabular-nums w-[38px] text-right" style={{ color: 'var(--text-dim)' }}>
                    {Math.round((fit.adjust?.[k] ?? 1) * 100)}%
                  </span>
                </div>
              ))}
              <button className="btn w-full text-[11px] mb-3"
                      onClick={() => patchFit({ zoom: undefined, zoomX: undefined, zoomY: undefined, panX: undefined, panY: undefined, fx: 0.5, fy: 0.5, adjust: undefined })}>
                배경 원래대로
              </button>

              <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
                <b style={{ color: 'var(--text-dim)' }}>단축키 (포토샵 세트)</b><br />
                · Shift+클릭 = 다중 선택 → 묶음 드래그<br />
                · Alt+드래그 = 복제해서 끌기<br />
                · Shift+드래그 = 수평/수직 고정 · Ctrl+드래그 = 스냅 끔<br />
                · 좌우 핸들 = 장평(텍스트)/스트레치(이미지)<br />
                · Ctrl+C/X/V · Ctrl+D · Del · 방향키(Shift ×10)<br />
                · Ctrl+[ ] = 순서 (+Shift 맨앞/뒤) · Ctrl+0/+/− = 줌<br />
                · T 텍스트 · R 사각형 · O 원 · U 아이콘 · P 이미지<br />
                · 더블클릭 = 텍스트 편집 · 레이어 행 드래그 = 순서
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center mb-2">
                <span className="label">{layerName(selLayer)}</span>
                <button className="chip ml-auto" title="복제 (Ctrl+D)" onClick={duplicateSel}>⧉</button>
                <button className="chip ml-1" title="삭제 (Del)" onClick={removeSel} style={{ color: 'var(--danger)' }}>🗑</button>
              </div>

              {/* 정렬 — 캔버스 기준 좌/중/우 · 상/중/하 */}
              <div className={row}>
                <span {...lbl}>정렬</span>
                {([['l', '⇤'], ['cx', '↔'], ['r', '⇥'], ['t', '⤒'], ['cy', '↕'], ['b', '⤓']] as const).map(([m, g]) => (
                  <button key={m} className="chip px-1.5" title={{ l: '왼쪽', cx: '가로 중앙', r: '오른쪽', t: '위', cy: '세로 중앙', b: '아래' }[m]}
                          onClick={() => alignSel(m)}>{g}</button>
                ))}
              </div>

              {/* 공통 — 위치·회전·불투명도 */}
              <div className={row}>
                <span {...lbl}>X %</span>
                <input className={inputCls} style={inputStyle} type="number" step={0.1} value={pct(num(selLayer.x, 0.5))}
                       onChange={(e) => patchSel({ x: Number(e.target.value) / 100 })} />
                <span {...lbl}>Y %</span>
                <input className={inputCls} style={inputStyle} type="number" step={0.1} value={pct(num(selLayer.y, 0.5))}
                       onChange={(e) => patchSel({ y: Number(e.target.value) / 100 })} />
              </div>
              <div className={row}>
                <span {...lbl}>회전°</span>
                <input className={inputCls} style={inputStyle} type="number" step={1} value={num(selLayer.rotate)}
                       onChange={(e) => patchSel({ rotate: Number(e.target.value) || undefined })} />
                <span {...lbl}>불투명</span>
                <input className="flex-1" type="range" min={0} max={1} step={0.01} value={num(selLayer.opacity, 1)}
                       onChange={(e) => patchSel({ opacity: Number(e.target.value) }, true)}
                       onPointerDown={begin} onPointerUp={commit} />
              </div>

              {/* 텍스트 */}
              {selLayer.kind === 'text' && (
                <>
                  <div className="label mt-2 mb-1">텍스트</div>
                  <textarea className={inputCls} style={{ ...inputStyle, minHeight: 56 }} value={selLayer.text ?? ''}
                            onFocus={begin} onBlur={commit}
                            onChange={(e) => patchSel({ text: e.target.value }, true)} />
                  <div className={row + ' mt-1.5'}>
                    <span {...lbl}>크기</span>
                    <input className="flex-1" type="range" min={0.02} max={0.3} step={0.002} value={num(selLayer.size, 0.06)}
                           onChange={(e) => patchSel({ size: Number(e.target.value) }, true)}
                           onPointerDown={begin} onPointerUp={commit} />
                    <input className="w-[58px] px-1 py-0.5 text-[11px] rounded-[6px]" style={inputStyle} type="number" step={0.002}
                           value={num(selLayer.size, 0.06)} onChange={(e) => patchSel({ size: Number(e.target.value) })} />
                  </div>
                  <div className={row}>
                    <span {...lbl}>굵기</span>
                    <select className={inputCls} style={inputStyle} value={num(selLayer.weight, 700)}
                            onChange={(e) => patchSel({ weight: Number(e.target.value) })}>
                      {[300, 400, 500, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}
                    </select>
                    <span {...lbl}>정렬</span>
                    <div className="flex gap-0.5">
                      {(['start', 'middle', 'end'] as const).map((a) => (
                        <button key={a} className="chip px-1.5" onClick={() => patchSel({ align: a })}
                                style={selLayer.align === a || (!selLayer.align && a === 'middle') ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                          {a === 'start' ? '⇤' : a === 'end' ? '⇥' : '↔'}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* 폰트 — 서버 보유(항상 적용) + PC 폰트(로컬 저장본 적용, 배포 서버엔 기본체 폴백) */}
                  <div className={row}>
                    <span {...lbl}>폰트</span>
                    <select className={inputCls} style={inputStyle} value={selLayer.font ?? ''}
                            onChange={(e) => patchSel({ font: e.target.value || undefined })}>
                      <option value="">기본 (배너 글꼴)</option>
                      {(p.serverFonts ?? []).map((f) => <option key={f} value={f}>{f}</option>)}
                      {localFonts.filter((f) => !(p.serverFonts ?? []).includes(f)).map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </div>
                  {!localFonts.length && (
                    <button className="btn w-full text-[11px] mb-1.5" onClick={loadLocalFonts}
                            title="크롬·엣지의 로컬 폰트 API — 권한 팝업이 한 번 뜹니다. 이 PC 에 깔린 폰트는 로컬 저장본에도 그대로 적용됩니다 (배포 서버에 없는 폰트는 거기선 기본체로 나옵니다).">
                      PC 폰트 불러오기
                    </button>
                  )}
                  {/* 장평 — 포토샵 Ctrl+T 좌우 변형. 캔버스의 좌우 핸들과 연동 */}
                  <div className={row}>
                    <span {...lbl}>장평</span>
                    <input className="flex-1" type="range" min={0.4} max={2.5} step={0.02}
                           value={selLayer.scaleX ?? 1}
                           onChange={(e) => { const v = Number(e.target.value); patchSel({ scaleX: v === 1 ? undefined : v }, true); }}
                           onPointerDown={begin} onPointerUp={commit} />
                    <span className="text-[10.5px] tabular-nums w-[38px] text-right" style={{ color: 'var(--text-dim)' }}>
                      {Math.round((selLayer.scaleX ?? 1) * 100)}%
                    </span>
                  </div>
                  <div className={row}>
                    <span {...lbl}>자간</span>
                    <input className={inputCls} style={inputStyle} type="number" step={0.005} value={num(selLayer.tracking)}
                           onChange={(e) => patchSel({ tracking: Number(e.target.value) })} />
                    <span {...lbl}>행간</span>
                    <input className={inputCls} style={inputStyle} type="number" step={0.05} value={num(selLayer.lineHeight, 1.25)}
                           onChange={(e) => patchSel({ lineHeight: Number(e.target.value) })} />
                  </div>
                  <div className={row}>
                    <span {...lbl}>색</span>
                    <input type="color" value={selLayer.color}
                           onChange={(e) => patchSel({ color: e.target.value }, true)}
                           onFocus={begin} onBlur={commit}
                           style={{ width: 34, height: 24, padding: 0, border: '1px solid var(--line)', borderRadius: 6, background: 'none' }} />
                    <input className={inputCls} style={inputStyle} value={selLayer.color}
                           onChange={(e) => patchSel({ color: e.target.value })} />
                  </div>
                  <div className={row}>
                    <span {...lbl}>곡선</span>
                    <input className="flex-1" type="range" min={-1} max={1} step={0.05} value={num(selLayer.curve)}
                           onChange={(e) => patchSel({ curve: Number(e.target.value) || undefined }, true)}
                           onPointerDown={begin} onPointerUp={commit} />
                    <label className="text-[10.5px] flex items-center gap-1" style={{ color: 'var(--text-mute)' }}>
                      <input type="checkbox" checked={!!selLayer.shadow} onChange={(e) => patchSel({ shadow: e.target.checked || undefined })} />
                      윤곽
                    </label>
                  </div>
                  {/* 커스텀 외곽선 — 두께(em)·색. 0 이면 없음 */}
                  <div className={row}>
                    <span {...lbl}>외곽선</span>
                    <input className="flex-1" type="range" min={0} max={0.15} step={0.005}
                           value={selLayer.textStroke?.width ?? 0}
                           onChange={(e) => {
                             const w = Number(e.target.value);
                             patchSel({ textStroke: w > 0 ? { width: w, color: selLayer.textStroke?.color ?? '#000000' } : undefined }, true);
                           }}
                           onPointerDown={begin} onPointerUp={commit} />
                    <input type="color" value={selLayer.textStroke?.color ?? '#000000'}
                           onChange={(e) => patchSel({ textStroke: { width: selLayer.textStroke?.width ?? 0.04, color: e.target.value } })}
                           style={{ width: 34, height: 24, padding: 0, border: '1px solid var(--line)', borderRadius: 6, background: 'none' }} />
                  </div>
                </>
              )}

              {/* 사각형·원 */}
              {selLayer.kind === 'rect' && (
                <>
                  <div className="label mt-2 mb-1">도형</div>
                  <div className={row}>
                    <span {...lbl}>가로 %</span>
                    <input className={inputCls} style={inputStyle} type="number" step={0.1} value={pct(num(selLayer.w, 0.3))}
                           onChange={(e) => patchSel({ w: Number(e.target.value) / 100 })} />
                    <span {...lbl}>세로 %</span>
                    <input className={inputCls} style={inputStyle} type="number" step={0.1} value={pct(num(selLayer.h, 0.1))}
                           onChange={(e) => patchSel({ h: Number(e.target.value) / 100 })} />
                  </div>
                  <div className={row}>
                    <span {...lbl}>모양</span>
                    {(['rect', 'ellipse'] as const).map((s) => (
                      <button key={s} className="chip" onClick={() => patchSel({ shape: s })}
                              style={(selLayer.shape ?? 'rect') === s ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                        {s === 'rect' ? '사각' : '원'}
                      </button>
                    ))}
                    <span {...lbl}>모서리</span>
                    <input className="flex-1" type="range" min={0} max={0.3} step={0.005} value={num(selLayer.radius)}
                           onChange={(e) => patchSel({ radius: Number(e.target.value) }, true)}
                           onPointerDown={begin} onPointerUp={commit} />
                  </div>
                  <div className={row}>
                    <span {...lbl}>색</span>
                    <input type="color" value={selLayer.color}
                           onChange={(e) => patchSel({ color: e.target.value }, true)}
                           onFocus={begin} onBlur={commit}
                           style={{ width: 34, height: 24, padding: 0, border: '1px solid var(--line)', borderRadius: 6, background: 'none' }} />
                    <input className={inputCls} style={inputStyle} value={selLayer.color}
                           onChange={(e) => patchSel({ color: e.target.value })} />
                  </div>
                  <div className={row}>
                    <span {...lbl}>테두리</span>
                    <input className={inputCls} style={inputStyle} type="number" step={0.001} min={0}
                           value={num(selLayer.border?.width)}
                           onChange={(e) => {
                             const w = Number(e.target.value);
                             patchSel({ border: w > 0 ? { width: w, color: selLayer.border?.color ?? '#1b1d21' } : undefined });
                           }} />
                    <input type="color" value={selLayer.border?.color ?? '#1b1d21'}
                           onChange={(e) => patchSel({ border: { width: selLayer.border?.width ?? 0.004, color: e.target.value } })}
                           style={{ width: 34, height: 24, padding: 0, border: '1px solid var(--line)', borderRadius: 6, background: 'none' }} />
                  </div>
                </>
              )}

              {/* 아이콘 */}
              {selLayer.kind === 'icon' && (
                <>
                  <div className="label mt-2 mb-1">아이콘</div>
                  <div className="grid grid-cols-7 gap-1 mb-1.5">
                    {Object.entries(ICONS).map(([k, ic]) => (
                      <button key={k} title={ic.label} onClick={() => patchSel({ icon: k })}
                              className="rounded-[6px] p-1"
                              style={{ border: '1px solid ' + (selLayer.icon === k ? 'var(--accent)' : 'var(--line)'), background: 'var(--surface-2)' }}>
                        <svg viewBox="0 0 24 24" width="16" height="16">
                          <path d={ic.path} fill={ic.fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2"
                                strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-dim)' }} />
                        </svg>
                      </button>
                    ))}
                  </div>
                  <div className={row}>
                    <span {...lbl}>크기</span>
                    <input className="flex-1" type="range" min={0.02} max={0.4} step={0.005} value={num(selLayer.size, 0.08)}
                           onChange={(e) => patchSel({ size: Number(e.target.value) }, true)}
                           onPointerDown={begin} onPointerUp={commit} />
                    <span {...lbl}>선굵기</span>
                    <input className={inputCls} style={inputStyle} type="number" step={0.01} value={num(selLayer.stroke, 0.09)}
                           onChange={(e) => patchSel({ stroke: Number(e.target.value) })} />
                  </div>
                  <div className={row}>
                    <span {...lbl}>색</span>
                    <input type="color" value={selLayer.color}
                           onChange={(e) => patchSel({ color: e.target.value }, true)}
                           onFocus={begin} onBlur={commit}
                           style={{ width: 34, height: 24, padding: 0, border: '1px solid var(--line)', borderRadius: 6, background: 'none' }} />
                    <input className={inputCls} style={inputStyle} value={selLayer.color}
                           onChange={(e) => patchSel({ color: e.target.value })} />
                  </div>
                </>
              )}

              {/* 이미지 */}
              {selLayer.kind === 'image' && (
                <>
                  <div className="label mt-2 mb-1">이미지</div>
                  <div className={row}>
                    <span {...lbl}>가로 %</span>
                    <input className="flex-1" type="range" min={0.03} max={1.5} step={0.005} value={num(selLayer.w, 0.25)}
                           onChange={(e) => patchSel({ w: Number(e.target.value) }, true)}
                           onPointerDown={begin} onPointerUp={commit} />
                  </div>
                  <div className={row}>
                    <span {...lbl}>세로 %</span>
                    <input className="flex-1" type="range" min={0.02} max={1.5} step={0.005}
                           value={selLayer.h ?? ((num(selLayer.w, 0.25) * W) / (selLayer.srcAspect ?? 1)) / H}
                           onChange={(e) => patchSel({ h: Number(e.target.value) }, true)}
                           onPointerDown={begin} onPointerUp={commit} />
                  </div>
                  {/* 수치로도 — 슬라이더로는 정확히 못 맞춘다 (캔버스 대비 %) */}
                  <div className={row}>
                    <span {...lbl}>수치</span>
                    <input type="number" min={3} max={150} step={1} value={Math.round(num(selLayer.w, 0.25) * 100)}
                           title="가로 크기 (캔버스 폭 대비 %)"
                           onChange={(e) => {
                             const v = Math.max(3, Math.min(150, Number(e.target.value) || 25)) / 100;
                             const keep = selLayer.h == null;   // 원본 비율이면 세로는 자동
                             patchSel(keep ? { w: v } : { w: v, h: (selLayer.h ?? 0) * (v / num(selLayer.w, 0.25)) });
                           }}
                           className={inputCls} style={{ ...inputStyle, width: 62 }} />
                    <span className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>% 가로</span>
                  </div>
                  {/* 슬롯형(cover) 이미지 — 칸은 그대로 두고 안의 사진만 확대·이동한다 */}
                  {selLayer.cover && (
                    <>
                      <div className={row}>
                        <span {...lbl}>안쪽 확대</span>
                        <input className="flex-1" type="range" min={0.4} max={3} step={0.02}
                               value={selLayer.srcZoom ?? 1}
                               onChange={(e) => patchSel({ srcZoom: Number(e.target.value) }, true)}
                               onPointerDown={begin} onPointerUp={commit} />
                        <span className="text-[10.5px] tabular-nums w-[38px] text-right" style={{ color: 'var(--text-dim)' }}>
                          {Math.round((selLayer.srcZoom ?? 1) * 100)}%
                        </span>
                      </div>
                      <div className={row}>
                        <span {...lbl}>보이는 곳 ↔</span>
                        <input className="flex-1" type="range" min={-0.5} max={1.5} step={0.02}
                               value={selLayer.srcFx ?? 0.5}
                               onChange={(e) => patchSel({ srcFx: Number(e.target.value) }, true)}
                               onPointerDown={begin} onPointerUp={commit} />
                      </div>
                      <div className={row}>
                        <span {...lbl}>보이는 곳 ↕</span>
                        <input className="flex-1" type="range" min={-0.5} max={1.5} step={0.02}
                               value={selLayer.srcFy ?? 0.5}
                               onChange={(e) => patchSel({ srcFy: Number(e.target.value) }, true)}
                               onPointerDown={begin} onPointerUp={commit} />
                      </div>
                      <div className="text-[10px] mb-1" style={{ color: 'var(--text-mute)' }}>
                        칸 크기는 그대로 두고 안의 사진만 움직입니다 — 넘치는 부분은 잘립니다.
                      </div>
                    </>
                  )}
                  <div className="flex gap-1.5">
                    <button className="btn flex-1 text-[12px]" onClick={() => patchSel({ h: undefined })}
                            title="비율 무시 스트레치를 풀고 원본 비율로">원본 비율</button>
                    <button className="btn flex-1 text-[12px]"
                            onClick={() => patchSel({ srcZoom: undefined, srcFx: undefined, srcFy: undefined })}
                            title="안쪽 확대·위치를 기본으로">안쪽 초기화</button>
                    <button className="btn flex-1 text-[12px]" onClick={() => pickImageFor(selLayer.id)}>교체…</button>
                  </div>
                </>
              )}

              {/* 블러/모자이크 영역 */}
              {selLayer.kind === 'blurpatch' && (
                <>
                  <div className="label mt-2 mb-1">가리기 영역</div>
                  <div className={row}>
                    <span {...lbl}>효과</span>
                    {(['blur', 'mosaic'] as const).map((ef) => (
                      <button key={ef} className="chip" onClick={() => patchSel({ effect: ef })}
                              style={(selLayer.effect ?? 'blur') === ef ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                        {ef === 'blur' ? '블러' : '모자이크'}
                      </button>
                    ))}
                  </div>
                  <div className={row}>
                    <span {...lbl}>강도</span>
                    <input className="flex-1" type="range" min={0.1} max={1} step={0.05} value={selLayer.strength ?? 0.5}
                           onChange={(e) => patchSel({ strength: Number(e.target.value) }, true)}
                           onPointerDown={begin} onPointerUp={commit} />
                  </div>
                  <div className={row}>
                    <span {...lbl}>가로 %</span>
                    <input className={inputCls} style={inputStyle} type="number" step={0.1} value={pct(num(selLayer.w, 0.26))}
                           onChange={(e) => patchSel({ w: Number(e.target.value) / 100 })} />
                    <span {...lbl}>세로 %</span>
                    <input className={inputCls} style={inputStyle} type="number" step={0.1} value={pct(num(selLayer.h, 0.2))}
                           onChange={(e) => patchSel({ h: Number(e.target.value) / 100 })} />
                  </div>
                  <div className="text-[10px] mb-1" style={{ color: 'var(--text-mute)' }}>
                    배경 사진에 적용됩니다 (위에 얹은 글자·이미지는 안 흐려짐). 모자이크는 저장본에서 정확히 픽셀화됩니다.
                  </div>
                </>
              )}

              {/* 드롭섀도 — 텍스트·도형 공통 */}
              {(selLayer.kind === 'text' || selLayer.kind === 'rect') && (
                <>
                  <div className="label mt-2.5 mb-1 flex items-center gap-2">
                    드롭섀도
                    <input type="checkbox" checked={!!selLayer.dropShadow}
                           onChange={(e) => patchSel({
                             dropShadow: e.target.checked
                               ? { dx: 0.03, dy: 0.05, blur: 0.08, color: '#000000', opacity: 0.45 }
                               : undefined,
                           })} />
                  </div>
                  {selLayer.dropShadow && (
                    <>
                      <div className={row}>
                        <span {...lbl}>X</span>
                        <input className="flex-1" type="range" min={-0.3} max={0.3} step={0.01} value={selLayer.dropShadow.dx}
                               onChange={(e) => patchSel({ dropShadow: { ...selLayer.dropShadow!, dx: Number(e.target.value) } }, true)}
                               onPointerDown={begin} onPointerUp={commit} />
                        <span {...lbl}>Y</span>
                        <input className="flex-1" type="range" min={-0.3} max={0.3} step={0.01} value={selLayer.dropShadow.dy}
                               onChange={(e) => patchSel({ dropShadow: { ...selLayer.dropShadow!, dy: Number(e.target.value) } }, true)}
                               onPointerDown={begin} onPointerUp={commit} />
                      </div>
                      <div className={row}>
                        <span {...lbl}>번짐</span>
                        <input className="flex-1" type="range" min={0} max={0.5} step={0.01} value={selLayer.dropShadow.blur}
                               onChange={(e) => patchSel({ dropShadow: { ...selLayer.dropShadow!, blur: Number(e.target.value) } }, true)}
                               onPointerDown={begin} onPointerUp={commit} />
                        <input type="color" value={selLayer.dropShadow.color}
                               onChange={(e) => patchSel({ dropShadow: { ...selLayer.dropShadow!, color: e.target.value } })}
                               style={{ width: 34, height: 24, padding: 0, border: '1px solid var(--line)', borderRadius: 6, background: 'none' }} />
                      </div>
                      <div className={row}>
                        <span {...lbl}>진하기</span>
                        <input className="flex-1" type="range" min={0} max={1} step={0.05} value={selLayer.dropShadow.opacity ?? 0.45}
                               onChange={(e) => patchSel({ dropShadow: { ...selLayer.dropShadow!, opacity: Number(e.target.value) } }, true)}
                               onPointerDown={begin} onPointerUp={commit} />
                      </div>
                    </>
                  )}
                </>
              )}
            </>
          )}

          {/* ── AI 도구 — 나노바나나 1회 호출 (실측 ₩230~314/장) ── */}
          <div className="mt-3 pt-2.5" style={{ borderTop: '1px solid var(--line)' }}>
            <div className="label mb-1.5">🪄 AI 도구</div>
            <button className="btn w-full text-[12px] mb-1.5"
                    disabled={!!aiBusy || !selLayer || selLayer.kind !== 'image'}
                    title="선택한 이미지 레이어를 배경에 '찍은 것처럼' 녹입니다 — 조명·그림자·가장자리 재계산. 성공하면 배경에 구워지고 레이어는 사라집니다."
                    onClick={() => runAi('merge')}>
              {aiBusy === 'merge' ? 'AI 합성 중…' : '두 이미지 자연 합성 (이미지 레이어 선택)'}
            </button>
            <button className="btn w-full text-[12px] mb-1.5"
                    disabled={!!aiBusy || !selLayer || (selLayer.kind !== 'rect' && selLayer.kind !== 'blurpatch')}
                    title="선택한 사각형/블러영역 안의 개체를 지우고 배경을 복원합니다. 성공하면 표시 사각형은 사라집니다."
                    onClick={() => runAi('erase')}>
              {aiBusy === 'erase' ? 'AI 지우는 중…' : '개체 지우개 (영역 사각형 선택)'}
            </button>
            <button className="btn w-full text-[12px]"
                    disabled={!!aiBusy}
                    title="배경 장면을 캔버스 규격까지 자연스럽게 연장합니다 (아웃페인트). 여백 채우기보다 자연스럽습니다."
                    onClick={() => runAi('outpaint')}>
              {aiBusy === 'outpaint' ? 'AI 연장 중…' : '아웃페인트로 캔버스 채우기'}
            </button>
            <div className="text-[9.5px] mt-1" style={{ color: 'var(--text-mute)' }}>
              결과는 새 배경으로 구워지고 변형은 초기화됩니다. 30~50초.
            </div>
          </div>
        </div>
      </div>

      {/* ── 미리보기 팝업 ── */}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,.85)' }}
             onClick={() => setPreview(null)}>
          <div className="max-w-[92vw] max-h-[92vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt="미리보기" className="max-w-full h-auto rounded-lg border" style={{ borderColor: 'var(--line-strong)' }} />
            <div className="flex gap-2 mt-2 justify-end">
              <button className="btn" onClick={() => setPreview(null)}>닫기</button>
              <button className="btn btn-primary" onClick={() => { setPreview(null); render(true); }}>이대로 저장</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
