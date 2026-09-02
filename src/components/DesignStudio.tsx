'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ICONS, renderLayersToSvg, type DesignDoc, type DesignLayer } from '@/lib/design-render';
import { TEMPLATES, THEMES, findTheme } from '@/lib/banner-templates';
import { BANNER_SIZES, findSize, shapeOf, cropLoss } from '@/lib/banner-sizes';

/**
 * 배너 디자인 생성 — 간단한 포토샵.
 *
 * 화면이 곧 순서다: 컷 고르기 → 어디에 걸 배너인가 → 문구 → (선택) 다듬기.
 * 쓰는 사람이 디자이너가 아니라서, 세 번 만지면 완성되고 나머지는 접혀 있어야 한다.
 * 그래서 단계는 오른쪽 한 줄에 번호를 달아 세우고, 왼쪽은 결과만 크게 보여준다.
 *
 * 미리보기를 CSS 로 흉내내지 않고 **저장할 때와 똑같은 SVG** 를 그대로 띄운다.
 * 그래야 화면에서 본 것과 저장본이 어긋나지 않는다 (곡선 텍스트처럼
 * CSS 로는 재현 못 하는 연출이 있기 때문에도 필요하다).
 *
 * 좌표·크기는 전부 0~1 비율이라 어떤 해상도의 컷에 얹어도 같은 배치가 나온다.
 */

interface CutOption { id: string; url: string; label: string }
interface SavedTemplate { id: string; name: string; design: DesignDoc; updatedAt: string | null }

const uid = () => Math.random().toString(36).slice(2, 9);

/** 새 레이어의 기본값 — 만들자마자 화면 가운데에 보이게 */
function newLayer(kind: DesignLayer['kind'], color: string): DesignLayer {
  const base = { id: uid(), kind, x: 0.5, y: 0.5, color, opacity: 1 } as DesignLayer;
  if (kind === 'text') return { ...base, text: '새 문구', size: 0.06, weight: 700, tracking: 0, lineHeight: 1.25, align: 'middle', shadow: true, curve: 0 };
  if (kind === 'icon') return { ...base, icon: 'arrow', size: 0.06, stroke: 0.09 };
  if (kind === 'rect') return { ...base, w: 0.4, h: 0.1, radius: 0.05 };
  return { ...base, x: 0.5, y: 0.2, w: 1, h: 0.4, opacity: 0.5, direction: 'top' };
}

/** 자동 배치가 만든 레이어인가 — 손대지 않은 배치만 규격이 바뀔 때 다시 잡는다 */
const isAuto = (l: DesignLayer) => l.id.startsWith('auto-');

/**
 * 단계 카드.
 *
 * 이 화면은 순서대로 밟는 물건이라 번호를 붙이고 끝낸 단계는 표시한다.
 * 앞 단계를 안 끝냈으면 흐리게 죽여서, 어디부터 손대야 할지 헤매지 않게 한다.
 */
function Step({
  n, title, hint, done, disabled, open, onToggle, accent, children,
}: {
  n: number; title: string; hint?: string;
  done?: boolean; disabled?: boolean;
  open?: boolean; onToggle?: () => void;
  accent?: boolean;
  children: React.ReactNode;
}) {
  const collapsible = typeof open === 'boolean' && !!onToggle;
  const shown = collapsible ? open : true;
  return (
    <div className="card p-3 mb-3"
         style={{
           borderColor: accent ? 'var(--accent-dim)' : undefined,
           opacity: disabled ? 0.5 : 1,
           pointerEvents: disabled ? 'none' : undefined,
         }}>
      <div className={`flex items-center gap-2 ${shown ? 'mb-2' : ''}`}
           onClick={onToggle}
           style={{ cursor: collapsible ? 'pointer' : undefined }}>
        <span className="shrink-0 grid place-items-center rounded-full text-[10px] font-bold tabular-nums"
              style={{
                width: 18, height: 18,
                background: done ? 'var(--accent)' : 'var(--surface-3)',
                color: done ? '#fff' : 'var(--text-mute)',
              }}>
          {done ? '✓' : n}
        </span>
        <span className="label flex-1" style={{ color: 'var(--text-dim)' }}>{title}</span>
        {hint && <span className="text-[10.5px] tabular-nums" style={{ color: 'var(--text-mute)' }}>{hint}</span>}
        {collapsible && <span className="text-[10px]" style={{ color: 'var(--text-mute)' }}>{shown ? '▲' : '▼'}</span>}
      </div>
      {shown && children}
    </div>
  );
}

export default function DesignStudio({ cuts }: { cuts: CutOption[] }) {
  const [imageUrl, setImageUrl] = useState(cuts[0]?.url ?? '');
  const [themeId, setThemeId] = useState('dark');
  const [layers, setLayers] = useState<DesignLayer[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [templates, setTemplates] = useState<SavedTemplate[]>([]);
  const [busy, setBusy] = useState<'auto' | 'save' | 'tpl' | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [tweakOpen, setTweakOpen] = useState(false);
  // 원본 컷의 크기와 '걸릴 자리'의 규격은 다른 값이다. 둘을 섞으면 미리보기가 어긋난다
  const [src, setSrc] = useState({ w: 1000, h: 1000 });
  const [sizeId, setSizeId] = useState('');            // '' = 컷 크기 그대로
  const [fitMode, setFitMode] = useState<'cover' | 'blur'>('cover');
  const [fx, setFx] = useState(0.5);                   // 잘라낼 때 남길 가로 위치
  const [fy, setFy] = useState(0.45);                  // 세로 위치 — 인물이 아래면 올린다
  /*
   * 자동 배치 입력 — 이 화면의 기본 사용법이다.
   *
   * 기본값은 실제로 쓰는 자사몰 배너의 네 칸 구조를 그대로 채워둔다:
   *   눈썹(작게 한 줄) → 제목(크게) → 혜택 한 줄 → 버튼.
   * 빈칸에서 시작하면 무엇을 넣어야 하는지가 안 보인다.
   */
  const [autoEyebrow, setAutoEyebrow] = useState('함께 쓸 때 더 완성되는 요기보 조합');
  const [autoTitle, setAutoTitle] = useState('요기보 빈백·서포트 세트');
  const [autoSub, setAutoSub] = useState('상시할인 · 전 구성 무료배송 · 5% 추가 적립까지');
  const [autoCta, setAutoCta] = useState('세트 구매하기');
  const [picked, setPicked] = useState<{ where: string; light: boolean; sd: number; shape: string } | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const theme = findTheme(themeId);
  const sel = layers.find((l) => l.id === selected) ?? null;

  // 원본 컷의 실제 크기 — 얼마나 잘리는지 알려주려면 필요하다
  useEffect(() => {
    if (!imageUrl) return;
    const img = new window.Image();
    img.onload = () => setSrc({ w: img.naturalWidth || 1000, h: img.naturalHeight || 1000 });
    img.src = imageUrl;
  }, [imageUrl]);

  // 최종 규격. 고르지 않았으면 컷 크기를 그대로 쓴다
  const dims = useMemo(() => {
    if (!sizeId) return src;
    const b = findSize(sizeId);
    return { w: b.w, h: b.h };
  }, [sizeId, src]);

  const shape = shapeOf(dims.w, dims.h);
  // 규격과 컷의 비율이 다를 때만 '맞추는 방법'을 물어본다
  const needsFit = Math.abs(dims.w / dims.h - src.w / src.h) > 0.01;
  const loss = needsFit ? cropLoss(src.w, src.h, dims.w, dims.h) : 0;
  const fit = useMemo(() => ({ mode: fitMode, fx, fy }), [fitMode, fx, fy]);

  const design: DesignDoc = useMemo(
    () => ({ imageUrl, layers, size: { id: sizeId || undefined, w: dims.w, h: dims.h }, fit }),
    [imageUrl, layers, sizeId, dims, fit],
  );

  const loadTemplates = useCallback(async () => {
    const r = await fetch('/api/design');
    const j = await r.json();
    if (j.ok) setTemplates(j.templates ?? []);
  }, []);
  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  /** 저장할 때와 똑같은 SVG — 미리보기가 곧 결과다 */
  const svg = useMemo(() => renderLayersToSvg(design, dims.w, dims.h), [design, dims]);

  function patch(id: string, next: Partial<DesignLayer>) {
    setLayers((cur) => cur.map((l) => (l.id === id ? { ...l, ...next } : l)));
  }

  function applyTemplate(tplId: string) {
    const t = TEMPLATES.find((x) => x.id === tplId);
    if (!t) return;
    const th = findTheme(themeId);
    const decs: DesignLayer[] = t.decorations.map((d) => ({
      id: uid(),
      kind: d.kind === 'scrim' ? 'scrim' : 'rect',
      x: d.x + d.w / 2, y: d.y + d.h / 2, w: d.w, h: d.h,
      color: d.tone === 'scrim' ? th.scrim : d.tone === 'accent' ? th.accent : th.strong,
      opacity: d.opacity, radius: d.radius, direction: d.direction ?? 'top',
    }));
    const txts: DesignLayer[] = t.layers.map((x) => ({
      id: uid(), kind: 'text', x: x.x, y: x.y, text: x.placeholder,
      size: x.size, weight: x.weight, tracking: x.tracking, lineHeight: 1.25,
      align: x.align, shadow: true, curve: 0,
      color: x.tone === 'strong' ? th.strong : x.tone === 'soft' ? th.soft : th.accentText,
      opacity: 1,
    }));
    setLayers([...decs, ...txts]);
    setSelected(txts[0]?.id ?? null);
    setResult(null);
  }

  // ── 끌어서 옮기기 ──
  function onDown(e: React.PointerEvent, id: string) {
    const st = stageRef.current;
    if (!st) return;
    const l = layers.find((x) => x.id === id);
    if (!l) return;
    const r = st.getBoundingClientRect();
    dragRef.current = { id, dx: (e.clientX - r.left) / r.width - l.x, dy: (e.clientY - r.top) / r.height - l.y };
    setSelected(id);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onMove(e: React.PointerEvent) {
    const d = dragRef.current, st = stageRef.current;
    if (!d || !st) return;
    const r = st.getBoundingClientRect();
    patch(d.id, {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width - d.dx)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height - d.dy)),
    });
  }
  const onUp = () => { dragRef.current = null; };

  /**
   * 자동 배치 — 규격의 비율을 보고, 배경에서 비어 있는 곳에 읽히는 색으로 얹는다.
   * 디자이너가 아닌 사람이 쓰는 도구라 이게 기본 동선이다.
   * 결과가 마음에 안 들면 4단계에서 손으로 고치면 된다.
   */
  const autoLayout = useCallback(async (again = false) => {
    if (!imageUrl) { setErr('배경 컷을 골라주세요.'); return; }
    setBusy('auto'); setErr(''); setNote('');
    try {
      const r = await fetch('/api/design', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          auto: {
            imageUrl, eyebrow: autoEyebrow, title: autoTitle, subtitle: autoSub, cta: autoCta,
            size: { id: sizeId || undefined, w: dims.w, h: dims.h }, fit,
          },
        }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || '실패'); return; }
      setLayers(j.layers);
      setPicked(j.picked);
      setSelected(null);
      setResult(null);
      const kind = j.picked.shape === 'wide' ? '가로형' : j.picked.shape === 'tall' ? '세로형' : '정사각';
      setNote(`${again ? '규격이 바뀌어 다시 잡았습니다 — ' : ''}${kind} ${dims.w}×${dims.h}, `
        + `${j.picked.where} 여백에 배치 `
        + `(${j.picked.light ? '밝은 배경이라 짙은 글씨' : '어두운 배경이라 흰 글씨'}).`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }, [imageUrl, autoEyebrow, autoTitle, autoSub, autoCta, sizeId, dims, fit]);

  /*
   * 규격이나 자르기를 바꾸면 배치를 다시 잡는다.
   *
   * 좌표가 0~1 비율이라 규격이 바뀌어도 '깨지진' 않는다. 하지만 가로형과 정사각은
   * 애초에 배치 규칙이 다르다 — 가로형은 옆에 세우고 정사각은 위아래로 쌓는다.
   * 규격만 바꿔놓고 배치가 그대로면 쓰는 사람은 왜 어색한지 알 수가 없다.
   *
   * 손으로 옮긴 배치는 건드리지 않는다 (자동으로 만든 레이어만 다시 잡는다).
   * layers 를 의존성에 넣으면 자기가 부른 setLayers 때문에 무한히 돌기 때문에 ref 로 읽는다.
   */
  const layersRef = useRef(layers);
  const autoRef = useRef(autoLayout);
  // 렌더 중에 ref 를 건드리면 안 되므로 커밋 뒤에 최신값으로 맞춘다.
  // 아래 효과보다 먼저 선언돼 있어서 같은 커밋에서 항상 먼저 돈다
  useEffect(() => { layersRef.current = layers; autoRef.current = autoLayout; });
  useEffect(() => {
    const cur = layersRef.current;
    if (!imageUrl || cur.length === 0 || !cur.every(isAuto)) return;
    const t = setTimeout(() => { autoRef.current(true); }, 500);   // 슬라이더를 끄는 동안 매번 부르지 않게
    return () => clearTimeout(t);
  }, [sizeId, fitMode, fx, fy, imageUrl]);

  async function render(save: boolean) {
    if (!imageUrl) { setErr('배경 컷을 골라주세요.'); return; }
    setBusy('save'); setErr(''); setNote('');
    try {
      const r = await fetch('/api/design', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ design, save }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || '실패'); return; }
      if (save) { setNote('저장했습니다. 컷 갤러리에서 볼 수 있습니다.'); setResult(null); }
      else setResult(j.preview);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  async function saveTemplate() {
    const name = window.prompt('템플릿 이름을 지어주세요 (배경 없이 배치만 저장됩니다)');
    if (!name) return;
    setBusy('tpl');
    try {
      const r = await fetch('/api/design', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, design }),
      });
      const j = await r.json();
      if (j.ok) { setNote(`템플릿 "${name}" 저장됨`); loadTemplates(); }
      else setErr(j.error || '실패');
    } finally { setBusy(null); }
  }

  const num = (label: string, v: number, min: number, max: number, step: number, on: (n: number) => void, fmt?: (n: number) => string) => (
    <label className="block mb-2">
      <div className="flex justify-between text-[10.5px] mb-0.5" style={{ color: 'var(--text-mute)' }}>
        <span>{label}</span><span className="tabular-nums">{fmt ? fmt(v) : v.toFixed(3)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={v} className="w-full"
             onChange={(e) => on(Number(e.target.value))} />
    </label>
  );

  const sizeName = sizeId ? findSize(sizeId).label : '컷 크기 그대로';
  const shapeWord = shape === 'wide' ? '가로형' : shape === 'tall' ? '세로형' : '정사각';

  return (
    <div className="flex flex-col xl:flex-row gap-4">
      {/* ── 왼쪽: 결과만 크게 ── */}
      <div className="flex-1 min-w-0">
        <div className="card p-3">
          {/* 지금 무엇을 만들고 있는지 한 줄로 — 규격을 바꿔가며 쓰는 화면이라 필요하다 */}
          <div className="flex items-baseline justify-between gap-2 flex-wrap mb-2">
            <div className="label">미리보기 — 저장본과 같은 그림</div>
            <div className="text-[10.5px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
              {sizeName} · {dims.w}×{dims.h} · {shapeWord}
              {needsFit && fitMode === 'cover' && ` · 컷의 ${Math.round(loss * 100)}% 잘림`}
              {needsFit && fitMode === 'blur' && ' · 안 잘림'}
            </div>
          </div>

          <div
            ref={stageRef}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onUp}
            className="relative w-full select-none rounded-lg overflow-hidden"
            style={{ aspectRatio: `${dims.w} / ${dims.h}`, background: 'var(--surface-2)', touchAction: 'none' }}
          >
            {/*
              * 서버의 fitToSize 와 같은 계산을 CSS 로 한다.
              * cover = object-fit:cover + object-position(fx,fy),
              * blur  = 흐린 사본을 깔고 그 위에 통째로 얹기.
              * 두 계산이 어긋나면 화면에서 본 자리와 저장본이 달라진다.
              */}
            {imageUrl && fitMode === 'blur' && needsFit && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl} alt="" aria-hidden
                   className="absolute inset-0 w-full h-full object-cover"
                   style={{ filter: 'blur(18px) brightness(0.82)', transform: 'scale(1.1)' }} draggable={false} />
            )}
            {imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl} alt="배경" draggable={false}
                   className="absolute inset-0 w-full h-full"
                   style={{
                     objectFit: fitMode === 'blur' && needsFit ? 'contain' : 'cover',
                     objectPosition: `${Math.round(fx * 100)}% ${Math.round(fy * 100)}%`,
                   }} />
            )}
            {/* 저장본과 같은 SVG 를 그대로 얹는다 */}
            <div className="absolute inset-0 pointer-events-none"
                 dangerouslySetInnerHTML={{ __html: svg.replace('<svg ', '<svg style="width:100%;height:100%;display:block" ') }} />
            {/* 잡는 손잡이 — 레이어 중심에 투명한 점을 두고 그걸 끈다 */}
            {layers.map((l) => (
              <span key={l.id} onPointerDown={(e) => onDown(e, l.id)}
                    title={l.kind === 'text' ? (l.text ?? '') : l.kind}
                    className="absolute rounded-full"
                    style={{
                      left: `${l.x * 100}%`, top: `${l.y * 100}%`, transform: 'translate(-50%,-50%)',
                      width: 22, height: 22, cursor: 'move',
                      border: `2px solid ${selected === l.id ? 'var(--accent)' : 'rgba(255,255,255,.55)'}`,
                      background: selected === l.id ? 'rgba(226,80,60,.25)' : 'rgba(0,0,0,.25)',
                    }} />
            ))}
            {!imageUrl && (
              <div className="absolute inset-0 grid place-items-center text-[12px]" style={{ color: 'var(--text-mute)' }}>
                오른쪽 1번에서 배경 컷을 골라주세요.
              </div>
            )}
          </div>

          <div className="flex gap-2 mt-3 flex-wrap">
            <button className="btn btn-primary" onClick={() => render(true)} disabled={!!busy || !layers.length}>
              {busy === 'save' ? '저장 중…' : '완성 · 갤러리에 저장'}
            </button>
            <button className="btn" onClick={() => render(false)} disabled={!!busy || !layers.length}>실제 크기로 확인</button>
            <button className="btn" onClick={saveTemplate} disabled={!!busy || !layers.length}>템플릿으로 저장</button>
          </div>
          {note && <div className="text-[11px] mt-2" style={{ color: 'var(--ok)' }}>{note}</div>}
          {err && <div className="text-[11px] mt-2" style={{ color: 'var(--danger)' }}>{err}</div>}
          {result && (
            <div className="mt-3">
              <div className="label mb-1">실제 크기 렌더 (저장 전)</div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={result} alt="렌더 결과" className="w-full rounded-lg border" style={{ borderColor: 'var(--line-strong)' }} />
            </div>
          )}
        </div>
      </div>

      {/* ── 오른쪽: 밟는 순서 ── */}
      <aside className="w-full xl:w-[340px] shrink-0">
        <Step n={1} title="배경 컷 고르기" done={!!imageUrl}
              hint={imageUrl ? `${src.w}×${src.h}` : undefined}>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {cuts.map((c) => (
              <button key={c.id} onClick={() => { setImageUrl(c.url); setResult(null); }} title={c.label}
                      className="shrink-0 rounded-lg overflow-hidden border" style={{ padding: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.url} alt={c.label} loading="lazy" className="object-cover"
                     style={{ width: 58, height: 58, borderColor: 'var(--line)',
                              outline: c.url === imageUrl ? '2px solid var(--accent)' : 'none', outlineOffset: -2 }} />
              </button>
            ))}
            {cuts.length === 0 && (
              <span className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
                생성된 컷이 없습니다. 먼저 이미지를 만들어주세요.
              </span>
            )}
          </div>
        </Step>

        {/* 배너는 '어디에 걸리나'가 먼저 정해지는 물건이라 문구보다 규격이 먼저다 */}
        <Step n={2} title="어디에 걸 배너인가" done={!!sizeId} disabled={!imageUrl}>
          <select className="input py-1 text-[12px]" value={sizeId}
                  onChange={(e) => { setSizeId(e.target.value); setResult(null); }}>
            <option value="">컷 크기 그대로 ({src.w}×{src.h})</option>
            {['웹', '모바일', 'SNS'].map((g) => (
              <optgroup key={g} label={g}>
                {BANNER_SIZES.filter((b) => b.group === g).map((b) => (
                  <option key={b.id} value={b.id}>{b.label} · {b.w}×{b.h}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <div className="text-[10.5px] mt-1.5 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            {shape === 'wide' ? '가로형 — 문구를 비어 있는 한쪽 옆에 세웁니다.'
              : shape === 'tall' ? '세로형 — 위나 아래에 크게 쌓습니다.'
              : '정사각 — 비어 있는 위/아래에 쌓습니다.'}
          </div>

          {needsFit && (
            <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--line)' }}>
              <div className="label mb-1.5">컷이 이 규격과 비율이 달라요</div>
              <div className="flex gap-1.5 mb-1.5">
                <button className={`btn flex-1 ${fitMode === 'cover' ? 'btn-primary' : ''}`}
                        onClick={() => { setFitMode('cover'); setResult(null); }}>
                  잘라서 채우기
                </button>
                <button className={`btn flex-1 ${fitMode === 'blur' ? 'btn-primary' : ''}`}
                        onClick={() => { setFitMode('blur'); setResult(null); }}>
                  여백 채우기
                </button>
              </div>
              {fitMode === 'cover' ? (
                <>
                  {num('남길 위치 ↔', fx, 0, 1, 0.01, (n) => { setFx(n); setResult(null); },
                       (n) => `${Math.round(n * 100)}%`)}
                  {num('남길 위치 ↕', fy, 0, 1, 0.01, (n) => { setFy(n); setResult(null); },
                       (n) => `${Math.round(n * 100)}%`)}
                  <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
                    컷의 <b style={{ color: 'var(--warn)' }}>약 {Math.round(loss * 100)}%</b> 가 잘립니다.
                    인물이 잘리면 위 막대로 남길 곳을 옮기세요.
                  </div>
                </>
              ) : (
                <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
                  컷을 통째로 넣고 남는 자리는 같은 사진을 흐리게 깔아 채웁니다. 하나도 잘리지 않습니다.
                </div>
              )}
            </div>
          )}
        </Step>

        {/* 기본 동선 — 문구만 넣고 누르면 끝난다 */}
        <Step n={3} title="문구 넣고 자동 배치" accent disabled={!imageUrl}
              done={layers.length > 0 && layers.every(isAuto)}>
          <input className="input py-1 text-[11.5px] mb-1.5" value={autoEyebrow}
                 onChange={(e) => setAutoEyebrow(e.target.value)} placeholder="윗 문구 — 작게 한 줄 (선택)" />
          <input className="input py-1 text-[12px] mb-1.5" value={autoTitle}
                 onChange={(e) => setAutoTitle(e.target.value)} placeholder="제목 — 가장 크게" />
          <input className="input py-1 text-[11.5px] mb-1.5" value={autoSub}
                 onChange={(e) => setAutoSub(e.target.value)} placeholder="혜택 한 줄 (선택)" />
          <input className="input py-1 text-[11.5px] mb-2" value={autoCta}
                 onChange={(e) => setAutoCta(e.target.value)} placeholder="버튼 문구 (선택)" />
          <button className="btn btn-primary w-full" onClick={() => autoLayout(false)} disabled={!!busy || !imageUrl}>
            {busy === 'auto' ? '분석 중…' : '✨ 자동 배치'}
          </button>
          <div className="text-[10.5px] mt-1.5 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            규격의 비율에 맞는 배치를 고르고, 배경에서 <b>비어 있는 곳</b>에 글자를 놓습니다.
            배경 밝기에 따라 글자색과 그늘도 정합니다.
            {picked && <><br />이번엔 <b style={{ color: 'var(--text-dim)' }}>{picked.where}</b> 여백을 골랐습니다.
              규격을 바꾸면 알아서 다시 잡습니다.</>}
          </div>
        </Step>

        <Step n={4} title="손으로 다듬기 (선택)" open={tweakOpen} onToggle={() => setTweakOpen((v) => !v)}
              hint={layers.length ? `레이어 ${layers.length}` : undefined}>
          <div className="label mb-1.5">다른 배치로 바꾸기</div>
          <div className="flex flex-wrap gap-1.5 mb-1">
            {TEMPLATES.map((t) => (
              <button key={t.id} className="chip" title={t.hint} onClick={() => applyTemplate(t.id)}>{t.name}</button>
            ))}
          </div>
          {shape !== 'square' && (
            <div className="text-[10.5px] mb-2 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
              이 템플릿들은 정사각 기준으로 잡아둔 것이라 {shapeWord} 규격에서는 간격이 어색할 수 있습니다.
              자동 배치가 이 비율에 맞게 잡아줍니다.
            </div>
          )}

          <div className="label mb-1.5 mt-2">색 테마</div>
          <select className="input py-1 text-[11.5px]" value={themeId} onChange={(e) => setThemeId(e.target.value)}>
            {THEMES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>

          {templates.length > 0 && (
            <>
              <div className="label mt-3 mb-1.5">내 템플릿</div>
              <div className="flex flex-wrap gap-1.5">
                {templates.map((t) => (
                  <button key={t.id} className="chip"
                          onClick={() => { setLayers(t.design.layers.map((l) => ({ ...l, id: uid() }))); setResult(null); }}>
                    {t.name}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="flex items-center justify-between mt-3 mb-1.5">
            <div className="label">레이어</div>
            <div className="flex gap-1">
              {(['text', 'icon', 'rect', 'scrim'] as const).map((k) => (
                <button key={k} className="chip" title={`${k} 추가`}
                        onClick={() => { const l = newLayer(k, theme.strong); setLayers((c) => [...c, l]); setSelected(l.id); }}>
                  ＋{k === 'text' ? '글자' : k === 'icon' ? '아이콘' : k === 'rect' ? '도형' : '그늘'}
                </button>
              ))}
            </div>
          </div>
          {layers.length === 0 && (
            <div className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
              3번에서 자동 배치를 누르거나, ＋ 로 레이어를 추가하세요.
            </div>
          )}
          <div className="flex flex-col gap-1">
            {layers.map((l, i) => (
              <div key={l.id} className="flex items-center gap-1.5 p-1.5 rounded-lg text-[11px]"
                   style={{ background: selected === l.id ? 'var(--accent-soft)' : 'var(--surface-2)', cursor: 'pointer' }}
                   onClick={() => setSelected(l.id)}>
                <span className="w-3 h-3 rounded shrink-0" style={{ background: l.color }} />
                <span className="truncate flex-1" style={{ color: 'var(--text-dim)' }}>
                  {l.kind === 'text' ? (l.text || '(빈 글자)') : l.kind === 'icon' ? `아이콘 · ${ICONS[l.icon ?? '']?.label ?? l.icon}` : l.kind === 'rect' ? '도형' : '그늘'}
                </span>
                <button title="위로" onClick={(e) => { e.stopPropagation(); if (i === 0) return; setLayers((c) => { const n = [...c]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; }); }}
                        style={{ background: 'none', border: 'none', color: 'var(--text-mute)', cursor: 'pointer', padding: 0 }}>▲</button>
                <button title="삭제" onClick={(e) => { e.stopPropagation(); setLayers((c) => c.filter((x) => x.id !== l.id)); }}
                        style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: 0 }}>✕</button>
              </div>
            ))}
          </div>
        </Step>

        {sel && (
          <div className="card p-3">
            <div className="label mb-2">선택한 레이어</div>

            {sel.kind === 'text' && (
              <>
                <textarea className="input text-[12px] mb-2" style={{ height: 62 }} value={sel.text ?? ''}
                          placeholder="문구 (줄바꿈 가능)"
                          onChange={(e) => patch(sel.id, { text: e.target.value })} />
                {num('글자 크기', sel.size ?? 0.06, 0.015, 0.2, 0.002, (n) => patch(sel.id, { size: n }), (n) => `${(n * 100).toFixed(1)}%`)}
                {num('굵기', sel.weight ?? 700, 300, 900, 100, (n) => patch(sel.id, { weight: n }), (n) => String(n))}
                {num('자간', sel.tracking ?? 0, -0.05, 0.2, 0.005, (n) => patch(sel.id, { tracking: n }), (n) => n.toFixed(3))}
                {num('줄 간격', sel.lineHeight ?? 1.25, 0.9, 2, 0.05, (n) => patch(sel.id, { lineHeight: n }), (n) => n.toFixed(2))}
                {num('곡선 (반달)', sel.curve ?? 0, -1, 1, 0.02, (n) => patch(sel.id, { curve: n }), (n) => n.toFixed(2))}
                <div className="flex gap-1.5 mb-2">
                  {(['start', 'middle', 'end'] as const).map((a) => (
                    <button key={a} className="chip flex-1 justify-center"
                            style={sel.align === a ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
                            onClick={() => patch(sel.id, { align: a })}>
                      {a === 'start' ? '왼쪽' : a === 'middle' ? '가운데' : '오른쪽'}
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-1.5 text-[11px] mb-2" style={{ color: 'var(--text-dim)' }}>
                  <input type="checkbox" checked={!!sel.shadow} onChange={(e) => patch(sel.id, { shadow: e.target.checked })} />
                  글자 외곽 그림자 (밝은 배경에서 안 날아가게)
                </label>
              </>
            )}

            {sel.kind === 'icon' && (
              <>
                <div className="flex flex-wrap gap-1 mb-2">
                  {Object.entries(ICONS).map(([k, v]) => (
                    <button key={k} className="chip" title={v.label}
                            style={sel.icon === k ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
                            onClick={() => patch(sel.id, { icon: k })}>{v.label}</button>
                  ))}
                </div>
                {num('크기', sel.size ?? 0.06, 0.015, 0.25, 0.002, (n) => patch(sel.id, { size: n }), (n) => `${(n * 100).toFixed(1)}%`)}
                {num('선 굵기', sel.stroke ?? 0.09, 0.02, 0.2, 0.005, (n) => patch(sel.id, { stroke: n }), (n) => n.toFixed(3))}
              </>
            )}

            {(sel.kind === 'rect' || sel.kind === 'scrim') && (
              <>
                {num('가로', sel.w ?? 0.4, 0.05, 1, 0.01, (n) => patch(sel.id, { w: n }), (n) => `${(n * 100).toFixed(0)}%`)}
                {num('세로', sel.h ?? 0.1, 0.02, 1, 0.01, (n) => patch(sel.id, { h: n }), (n) => `${(n * 100).toFixed(0)}%`)}
                {sel.kind === 'rect' && num('모서리', sel.radius ?? 0, 0, 0.2, 0.005, (n) => patch(sel.id, { radius: n }), (n) => n.toFixed(3))}
                {/*
                  * 그늘 방향에 좌/우가 있어야 한다 — 가로형 배너의 자동 배치가
                  * 좌우 그라데이션을 만들기 때문에, 여기서 위/아래만 고를 수 있으면
                  * 손대는 순간 배치가 깨진다.
                  */}
                {sel.kind === 'scrim' && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {(['top', 'bottom', 'left', 'right', 'none'] as const).map((d) => (
                      <button key={d} className="chip justify-center"
                              style={{
                                ...(sel.direction === d ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}),
                                flex: '1 1 28%',
                              }}
                              onClick={() => patch(sel.id, { direction: d })}>
                        {d === 'top' ? '위' : d === 'bottom' ? '아래' : d === 'left' ? '왼쪽' : d === 'right' ? '오른쪽' : '균일'}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {num('불투명도', sel.opacity ?? 1, 0, 1, 0.02, (n) => patch(sel.id, { opacity: n }), (n) => `${(n * 100).toFixed(0)}%`)}
            {num('회전', sel.rotate ?? 0, -45, 45, 1, (n) => patch(sel.id, { rotate: n }), (n) => `${n}°`)}

            <div className="label mb-1 mt-2">색</div>
            <div className="flex items-center gap-2">
              <input type="color" value={sel.color} onChange={(e) => patch(sel.id, { color: e.target.value })}
                     style={{ width: 40, height: 28, padding: 0, border: '1px solid var(--line)', borderRadius: 6, background: 'none' }} />
              <div className="flex gap-1 flex-wrap">
                {[theme.strong, theme.soft, theme.accent, theme.accentText, theme.scrim].map((c) => (
                  <button key={c} onClick={() => patch(sel.id, { color: c })} title={c}
                          className="w-6 h-6 rounded" style={{ background: c, border: '1px solid var(--line)' }} />
                ))}
              </div>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
