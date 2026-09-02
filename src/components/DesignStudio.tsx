'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ICONS, renderLayersToSvg, type DesignDoc, type DesignLayer } from '@/lib/design-render';
import { TEMPLATES, THEMES, findTheme } from '@/lib/banner-templates';

/**
 * 배너 디자인 생성 — 간단한 포토샵.
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

export default function DesignStudio({ cuts }: { cuts: CutOption[] }) {
  const [imageUrl, setImageUrl] = useState(cuts[0]?.url ?? '');
  const [themeId, setThemeId] = useState('dark');
  const [layers, setLayers] = useState<DesignLayer[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [templates, setTemplates] = useState<SavedTemplate[]>([]);
  const [busy, setBusy] = useState<'save' | 'tpl' | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [dims, setDims] = useState({ w: 1000, h: 1000 });
  // 자동 배치 입력 — 이 화면의 기본 사용법이다
  const [autoTitle, setAutoTitle] = useState('요기보 Week');
  const [autoSub, setAutoSub] = useState('보름달처럼 꽉 찬 휴식');
  const [autoCta, setAutoCta] = useState('마음을 전하는 선물 특가');
  const [picked, setPicked] = useState<{ where: string; light: boolean; sd: number } | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const theme = findTheme(themeId);
  const design: DesignDoc = useMemo(() => ({ imageUrl, layers }), [imageUrl, layers]);
  const sel = layers.find((l) => l.id === selected) ?? null;

  // 배경 컷의 실제 비율을 알아야 미리보기가 저장본과 같아진다
  useEffect(() => {
    if (!imageUrl) return;
    const img = new window.Image();
    img.onload = () => setDims({ w: img.naturalWidth || 1000, h: img.naturalHeight || 1000 });
    img.src = imageUrl;
  }, [imageUrl]);

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
   * 자동 배치 — 배경을 분석해 빈 곳에, 읽히는 색으로 얹는다.
   * 디자이너가 아닌 사람이 쓰는 도구라 이게 기본 동선이다.
   * 결과가 마음에 안 들면 아래에서 손으로 고치면 된다.
   */
  async function autoLayout() {
    if (!imageUrl) { setErr('배경 컷을 골라주세요.'); return; }
    setBusy('save'); setErr(''); setNote('');
    try {
      const r = await fetch('/api/design', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auto: { imageUrl, title: autoTitle, subtitle: autoSub, cta: autoCta } }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || '실패'); return; }
      setLayers(j.layers);
      setPicked(j.picked);
      setSelected(null);
      setResult(null);
      setNote(`${j.picked.where} 여백에 배치했습니다 (${j.picked.light ? '밝은 배경 → 짙은 글씨' : '어두운 배경 → 흰 글씨'}).`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

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

  return (
    <div className="flex flex-col xl:flex-row gap-4">
      {/* ── 무대 ── */}
      <div className="flex-1 min-w-0">
        <div className="card p-3 mb-3">
          <div className="label mb-1.5">배경 컷</div>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {cuts.map((c) => (
              <button key={c.id} onClick={() => { setImageUrl(c.url); setResult(null); }} title={c.label}
                      className="shrink-0 rounded-lg overflow-hidden border" style={{ padding: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.url} alt={c.label} loading="lazy" className="object-cover"
                     style={{ width: 62, height: 62, borderColor: 'var(--line)',
                              outline: c.url === imageUrl ? '2px solid var(--accent)' : 'none', outlineOffset: -2 }} />
              </button>
            ))}
            {cuts.length === 0 && (
              <span className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
                생성된 컷이 없습니다. 먼저 이미지를 만들어주세요.
              </span>
            )}
          </div>
        </div>

        <div className="card p-3">
          <div
            ref={stageRef}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onUp}
            className="relative w-full select-none rounded-lg overflow-hidden"
            style={{ aspectRatio: `${dims.w} / ${dims.h}`, background: 'var(--surface-2)', touchAction: 'none' }}
          >
            {imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl} alt="배경" className="absolute inset-0 w-full h-full object-cover" draggable={false} />
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
          </div>

          <div className="flex gap-2 mt-3 flex-wrap">
            <button className="btn" onClick={() => render(false)} disabled={!!busy}>미리보기 렌더</button>
            <button className="btn btn-primary" onClick={() => render(true)} disabled={!!busy}>
              {busy === 'save' ? '저장 중…' : '완성 · 갤러리에 저장'}
            </button>
            <button className="btn" onClick={saveTemplate} disabled={!!busy || !layers.length}>템플릿으로 저장</button>
          </div>
          {note && <div className="text-[11px] mt-2" style={{ color: 'var(--ok)' }}>{note}</div>}
          {err && <div className="text-[11px] mt-2" style={{ color: 'var(--danger)' }}>{err}</div>}
          {result && (
            <div className="mt-3">
              <div className="label mb-1">렌더 결과 (저장 전)</div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={result} alt="렌더 결과" className="w-full rounded-lg border" style={{ borderColor: 'var(--line-strong)' }} />
            </div>
          )}
        </div>
      </div>

      {/* ── 조작 ── */}
      <aside className="w-full xl:w-[330px] shrink-0">
        {/* 기본 동선 — 문구만 넣고 누르면 끝난다 */}
        <div className="card p-3 mb-3" style={{ borderColor: 'var(--accent-dim)' }}>
          <div className="label mb-1.5">1. 문구만 넣고 자동 배치</div>
          <input className="input py-1 text-[12px] mb-1.5" value={autoTitle}
                 onChange={(e) => setAutoTitle(e.target.value)} placeholder="제목" />
          <input className="input py-1 text-[11.5px] mb-1.5" value={autoSub}
                 onChange={(e) => setAutoSub(e.target.value)} placeholder="부제 (선택)" />
          <input className="input py-1 text-[11.5px] mb-2" value={autoCta}
                 onChange={(e) => setAutoCta(e.target.value)} placeholder="버튼 문구 (선택)" />
          <button className="btn btn-primary w-full" onClick={autoLayout} disabled={!!busy || !imageUrl}>
            {busy === 'save' ? '분석 중…' : '✨ 자동 배치'}
          </button>
          <div className="text-[10.5px] mt-1.5 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            배경에서 <b>비어 있는 곳</b>을 찾아 글자를 놓고, 배경 밝기에 맞춰 글자색과 그늘을 정합니다.
            {picked && <><br />이번엔 <b style={{ color: 'var(--text-dim)' }}>{picked.where}</b> 여백을 골랐습니다.</>}
          </div>
        </div>

        <div className="card p-3 mb-3">
          <div className="label mb-1.5">2. 다른 배치로 바꾸기 (선택)</div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {TEMPLATES.map((t) => (
              <button key={t.id} className="chip" title={t.hint} onClick={() => applyTemplate(t.id)}>{t.name}</button>
            ))}
          </div>
          <div className="label mb-1.5">색 테마</div>
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
        </div>

        <div className="card p-3 mb-3">
          <div className="flex items-center justify-between mb-1.5">
            <div className="label">3. 손으로 다듬기 (선택)</div>
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
              위에서 시작 배치를 고르거나, ＋ 로 레이어를 추가하세요.
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
        </div>

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
                {sel.kind === 'scrim' && (
                  <div className="flex gap-1.5 mb-2">
                    {(['top', 'bottom', 'none'] as const).map((d) => (
                      <button key={d} className="chip flex-1 justify-center"
                              style={sel.direction === d ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
                              onClick={() => patch(sel.id, { direction: d })}>
                        {d === 'top' ? '위' : d === 'bottom' ? '아래' : '균일'}
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
