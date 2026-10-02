'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PokemonCategory, PokemonItem } from '@/lib/pokemon-store';

/**
 * 포켓몬 카테고리 화면 — 작업 조건 · 컨셉 레퍼런스 · 사용 이미지 · 그 아래 결과물 (사용자 결정 2026-10-02).
 *
 * 컨셉 레퍼런스 = 따라 할 분위기·구도, 사용 이미지 = 결과물에 그대로 들어갈 것(제품 사진·캐릭터 — 형태 그대로).
 * 결과물 = 대화(Claude)가 그걸 보고 힉스필드 등으로 만든 것. 사용자와 Claude 둘만 본다.
 *
 * 카드의 #코드(id 끝 4자리)를 누르면 복사된다 — 대화에 붙여 넣으면 그 이미지를 가리킨다.
 * 결과물 카드는 어떤 레퍼런스·사용 이미지에서 나왔는지, 어떤 모델로 몇 크레딧 들었는지 보인다.
 * 배경은 체크무늬가 기본 — 스티커의 투명 부분과 흰 테두리가 보이게. 흰색·검정으로 바꿔 볼 수 있다.
 */

type Bg = 'check' | 'white' | 'black';
const BG: Record<Bg, React.CSSProperties> = {
  check: { background: 'repeating-conic-gradient(#2a2e36 0% 25%, #353a45 0% 50%) 50% / 18px 18px' },
  white: { background: '#ffffff' },
  black: { background: '#08090b' },
};
const BG_LABEL: Record<Bg, string> = { check: '체크', white: '흰색', black: '검정' };

type QueueEntry = { file: File; url: string };

const MODEL_KR: Record<string, string> = {
  nano_banana_pro: '나노바나나 프로', nano_banana_2: '나노바나나 2', gpt_image_2_5: 'GPT Image 2.5',
  seedance_2_5: 'Seedance 2.5', outpaint: '아웃페인트', soul_2: 'Soul 2',
};
const TOOL_KR: Record<string, string> = { higgsfield: '힉스필드', code: '코드' };

const short = (id: string) => id.slice(-4);
const fileUrl = (id: string, q = '') => `/api/pokemon/${id}${q}`;
const sizeLabel = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
const IMAGE_NAME = /\.(png|jpe?g|webp|gif|avif|heic|heif|tiff?)$/i;
const ACTIVE = { borderColor: 'var(--accent)', color: 'var(--accent)' };
const GRID = { gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' };

function when(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function genLabel(it: PokemonItem): string {
  if (!it.gen) return '';
  const parts = [TOOL_KR[it.gen.tool] ?? it.gen.tool];
  if (it.gen.model) parts.push(MODEL_KR[it.gen.model] ?? it.gen.model);
  if (it.gen.credits !== undefined) parts.push(`${it.gen.credits}크레딧`);
  return parts.join(' · ');
}

/**
 * 올리는 칸 두 개 (사용자 요청 10/2 — 2차 컨셉샷):
 *   컨셉 레퍼런스(kind=reference) — 따라 할 분위기·구도. 결과물에 그대로 들어가지 않는다.
 *   사용 이미지(kind=upload)     — 결과물에 그대로 들어가야 하는 것(제품 사진·캐릭터). 형태를 바꾸지 않는다.
 */
type UpKind = 'reference' | 'upload';
const UP_ORDER: UpKind[] = ['reference', 'upload'];
const UP: Record<UpKind, { title: string; hint: string; memo: string; cardMemo: string; empty: string }> = {
  reference: {
    title: '컨셉 레퍼런스',
    hint: '원하는 컨셉 · 분위기 · 구도 — 결과물에 그대로 들어가지는 않음',
    memo: '메모 (선택 · 이번에 올리는 이미지 전부에 붙습니다) — 예: 이 배경·조명 느낌으로',
    cardMemo: '무엇을 참고할지 — 예: 이 구도 · 색감 · 소품',
    empty: '아직 올린 컨셉 레퍼런스가 없습니다.',
  },
  upload: {
    title: '사용 이미지',
    hint: '결과물에 그대로 들어가야 하는 이미지 — 제품 사진 · 캐릭터 등 (형태 그대로 씀)',
    memo: '메모 (선택 · 이번에 올리는 이미지 전부에 붙습니다) — 예: 냅엑스 피카츄 버전',
    cardMemo: '무엇인지 — 예: 냅엑스 피카츄 · 정면',
    empty: '아직 올린 사용 이미지가 없습니다.',
  },
};
const NONE: Record<UpKind, string> = { reference: '', upload: '' };

export default function PokemonBoard({ initial, category }: { initial: PokemonItem[]; category: PokemonCategory }) {
  const [items, setItems] = useState<PokemonItem[]>(initial);
  const [brief, setBrief] = useState(category.brief ?? '');
  // 칸마다 올리기 대기열 — 미리보기 주소(브라우저 안 임시 주소)를 같이 들고 있다가 빼거나 다 올리면 정리한다
  const [queues, setQueues] = useState<Record<UpKind, QueueEntry[]>>({ reference: [], upload: [] });
  const [notes, setNotes] = useState<Record<UpKind, string>>(NONE);
  const [busy, setBusy] = useState<Record<UpKind, string>>(NONE);
  const [errs, setErrs] = useState<Record<UpKind, string>>(NONE);
  const [active, setActive] = useState<UpKind>('reference');     // Ctrl+V 가 들어갈 칸(마지막으로 손댄 칸)
  const [bg, setBg] = useState<Bg>('check');
  const [view, setView] = useState<PokemonItem | null>(null);
  const [flash, setFlash] = useState('');
  const [copied, setCopied] = useState('');

  const byKind = useMemo(() => ({
    reference: items.filter((i) => i.kind === 'reference'),
    upload: items.filter((i) => i.kind === 'upload'),
  }), [items]);
  const results = useMemo(() => items.filter((i) => i.kind === 'result'), [items]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  async function reload() {
    const j = await (await fetch(`/api/pokemon?category=${category.slug}`, { cache: 'no-store' })).json().catch(() => null);
    if (j?.ok) setItems(j.items);
  }

  const addFiles = useCallback((kind: UpKind, files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/') || IMAGE_NAME.test(f.name));
    if (imgs.length) {
      setQueues((q) => ({ ...q, [kind]: [...q[kind], ...imgs.map((file) => ({ file, url: URL.createObjectURL(file) }))] }));
    }
  }, []);

  // Ctrl+V — 캡처한 이미지를 마지막으로 손댄 칸으로. 글자만 붙여 넣을 때는 손대지 않는다.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      const stamp = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      addFiles(active, files.map((f, i) => new File([f],
        `붙여넣기_${stamp}${files.length > 1 ? `_${i + 1}` : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles, active]);

  // 크게 보기 — Esc 로 닫기
  useEffect(() => {
    if (!view) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setView(null); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [view]);

  async function upload(kind: UpKind) {
    const queue = queues[kind];
    if (!queue.length || busy[kind]) return;
    setErrs((e) => ({ ...e, [kind]: '' }));
    let ok = 0;
    for (let i = 0; i < queue.length; i++) {
      setBusy((b) => ({ ...b, [kind]: `${i + 1}/${queue.length} 올리는 중…` }));
      const fd = new FormData();
      fd.append('file', queue[i].file);
      fd.append('note', notes[kind]);
      fd.append('kind', kind);
      fd.append('category', category.slug);
      const j = await fetch('/api/pokemon', { method: 'POST', body: fd }).then((r) => r.json()).catch(() => ({ ok: false, error: '응답을 읽지 못했습니다' }));
      if (!j.ok) { setErrs((e) => ({ ...e, [kind]: `${queue[i].file.name} — ${j.error}` })); break; }
      ok++;
    }
    queue.slice(0, ok).forEach((q) => URL.revokeObjectURL(q.url));
    setQueues((q) => ({ ...q, [kind]: q[kind].slice(ok) }));          // 실패한 것부터는 대기열에 남긴다
    if (ok === queue.length) setNotes((n) => ({ ...n, [kind]: '' }));
    setBusy((b) => ({ ...b, [kind]: '' }));
    await reload();
  }

  function dropQueued(kind: UpKind, i?: number) {
    const list = queues[kind];
    (i === undefined ? list : [list[i]]).forEach((e) => URL.revokeObjectURL(e.url));
    setQueues((q) => ({ ...q, [kind]: i === undefined ? [] : q[kind].filter((_, k) => k !== i) }));
  }

  async function saveBrief(text: string) {
    const j = await fetch('/api/pokemon/categories', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: category.slug, brief: text }),
    }).then((r) => r.json()).catch(() => null);
    if (j?.ok) setBrief(j.category.brief ?? '');
    return !!j?.ok;
  }

  async function saveNote(id: string, text: string) {
    const j = await fetch(fileUrl(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: text }) })
      .then((r) => r.json()).catch(() => null);
    if (j?.ok) setItems((list) => list.map((x) => (x.id === id ? j.item : x)));
    return !!j?.ok;
  }

  async function remove(it: PokemonItem) {
    if (!confirm(`"${it.name}" 을(를) 지울까요?\n파일은 pokemon/_trash 로 옮겨져 되살릴 수 있습니다.`)) return;
    await fetch(fileUrl(it.id), { method: 'DELETE' });
    if (view?.id === it.id) setView(null);
    await reload();
  }

  async function copyCode(id: string) {
    try {
      await navigator.clipboard.writeText(`#${short(id)}`);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? '' : c)), 1400);
    } catch { /* 복사 거부 — 코드는 화면에 보인다 */ }
  }

  function jumpTo(id: string) {
    document.getElementById(`pk-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(id);
    setTimeout(() => setFlash((f) => (f === id ? '' : f)), 1600);
  }

  function card(it: PokemonItem) {
    const isResult = it.kind === 'result';
    const kids = isResult ? [] : results.filter((r) => r.sourceIds.includes(it.id));
    const gen = genLabel(it);
    return (
      <div key={it.id} id={`pk-${it.id}`} className="card p-2.5 transition-shadow"
           style={flash === it.id ? { boxShadow: '0 0 0 2px var(--accent)' } : undefined}>
        <button type="button" onClick={() => setView(it)} className="block w-full rounded-lg overflow-hidden"
                style={{ ...BG[bg], aspectRatio: '1 / 1', cursor: 'zoom-in' }} title="크게 보기">
          {/* 로컬 API 가 주는 파일이라 next/image 최적화 대상이 아니다 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={fileUrl(it.id, '?thumb=1')} alt={it.name} loading="lazy" className="w-full h-full object-contain" />
        </button>

        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          <button type="button" className="chip font-mono" onClick={() => copyCode(it.id)}
                  title="눌러서 복사 — 대화에 붙여 넣으면 이 이미지를 가리킵니다"
                  style={copied === it.id ? ACTIVE : undefined}>
            {copied === it.id ? '복사됨' : `#${short(it.id)}`}
          </button>
          {it.transparent && <span className="chip" style={{ color: 'var(--info)' }}>투명 배경</span>}
          <span className="ml-auto text-[10.5px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
            {it.width}×{it.height} · {sizeLabel(it.bytes)}
          </span>
        </div>

        <div className="text-[12px] font-bold mt-1.5 truncate" title={it.name}>{it.name}</div>
        {gen && <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--text-dim)' }}>{gen}</div>}

        {isResult && it.sourceIds.length > 0 && (
          <div className="flex items-center gap-1 mt-1.5 flex-wrap text-[10.5px]" style={{ color: 'var(--text-mute)' }}>
            출처
            {it.sourceIds.map((s) => (
              byId.has(s)
                ? <button key={s} type="button" className="chip font-mono" onClick={() => jumpTo(s)} title={byId.get(s)?.name}>#{short(s)}</button>
                : <span key={s} className="font-mono" title="지운 이미지입니다">#{short(s)}(지움)</span>
            ))}
          </div>
        )}

        <NoteField key={`${it.id}-${it.updatedAt}`} initial={it.note} onSave={(t) => saveNote(it.id, t)}
                   placeholder={isResult ? '설명' : UP[it.kind === 'upload' ? 'upload' : 'reference'].cardMemo} />

        {kids.length > 0 && (
          <div className="mt-2">
            <div className="label mb-1">결과물 {kids.length}</div>
            <div className="flex gap-1.5 flex-wrap">
              {kids.map((k) => (
                <button key={k.id} type="button" onClick={() => jumpTo(k.id)} title={k.name}
                        className="w-11 h-11 rounded-md overflow-hidden" style={BG[bg]}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={fileUrl(k.id, '?thumb=1')} alt={k.name} className="w-full h-full object-contain" />
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2.5 mt-2 text-[10.5px]">
          <span className="tabular-nums" style={{ color: 'var(--text-mute)' }}>{when(it.createdAt)}</span>
          <div className="flex-1" />
          <a href={fileUrl(it.id, '?download=1')} style={{ color: 'var(--text-mute)' }}>받기</a>
          <button type="button" onClick={() => remove(it)} style={{ color: 'var(--danger)' }}>지우기</button>
        </div>
      </div>
    );
  }

  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div>
      {/* 작업 조건 */}
      <BriefCard brief={brief} onSave={saveBrief} />

      {/* 바로 가기 · 미리보기 배경 */}
      <div className="flex items-center gap-1.5 mb-4 flex-wrap">
        {UP_ORDER.map((k) => (
          <button key={k} type="button" className="chip" onClick={() => jump(`sec-${k}`)}>{UP[k].title} {byKind[k].length}</button>
        ))}
        <button type="button" className="chip" onClick={() => jump('sec-result')}>결과물 {results.length}</button>
        <div className="flex-1" />
        <span className="label mr-1">미리보기 배경</span>
        {(Object.keys(BG) as Bg[]).map((b) => (
          <button key={b} type="button" className="chip" onClick={() => setBg(b)} style={bg === b ? ACTIVE : undefined}>
            {BG_LABEL[b]}
          </button>
        ))}
      </div>

      {UP_ORDER.map((k) => (
        <section key={k} id={`sec-${k}`} className="mb-9 scroll-mt-4">
          <div className="flex items-baseline gap-2 mb-2.5 flex-wrap">
            <h2 className="text-[15px] font-bold">{UP[k].title} <span className="font-normal" style={{ color: 'var(--text-mute)' }}>{byKind[k].length}</span></h2>
            <span className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>{UP[k].hint}</span>
          </div>
          <UploadPanel title={UP[k].title} memo={UP[k].memo} isActive={active === k} onActivate={() => setActive(k)}
                       queue={queues[k]} note={notes[k]} busy={busy[k]} err={errs[k]} bg={BG[bg]}
                       onAdd={(f) => addFiles(k, f)}
                       onRemove={(i) => dropQueued(k, i)}
                       onClear={() => dropQueued(k)}
                       onNote={(t) => setNotes((n) => ({ ...n, [k]: t }))} onUpload={() => upload(k)} />
          {byKind[k].length === 0 ? (
            <div className="card p-6 text-center text-[12px]" style={{ color: 'var(--text-mute)' }}>{UP[k].empty}</div>
          ) : (
            <div className="grid gap-3.5" style={GRID}>{byKind[k].map(card)}</div>
          )}
        </section>
      ))}

      <section id="sec-result" className="mb-9 scroll-mt-4">
        <div className="flex items-baseline gap-2 mb-2.5 flex-wrap">
          <h2 className="text-[15px] font-bold">결과물 <span className="font-normal" style={{ color: 'var(--text-mute)' }}>{results.length}</span></h2>
          <span className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>컨셉 레퍼런스·사용 이미지를 보고 힉스필드 등으로 만든 것</span>
        </div>
        {results.length === 0 ? (
          <div className="card p-6 text-center text-[12px]" style={{ color: 'var(--text-mute)' }}>
            결과물이 생기면 여기에 쌓이고, 쓰인 이미지 카드에도 이어져 보입니다.
          </div>
        ) : (
          <div className="grid gap-3.5" style={GRID}>{results.map(card)}</div>
        )}
      </section>

      {view && (
        <div onClick={() => setView(null)} className="fixed inset-0 z-[60] flex flex-col items-center justify-center p-6"
             style={{ background: 'rgba(0,0,0,.86)' }}>
          <div className="rounded-lg overflow-hidden max-w-full" style={{ ...BG[bg], maxHeight: '78vh' }} onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={fileUrl(view.id)} alt={view.name} className="block max-w-full object-contain" style={{ maxHeight: '78vh' }} />
          </div>
          <div className="mt-3 text-[12.5px] text-center max-w-[760px]" style={{ color: '#e5e7eb' }} onClick={(e) => e.stopPropagation()}>
            <b>{view.kind === 'result' ? '결과물' : UP[view.kind === 'upload' ? 'upload' : 'reference'].title} #{short(view.id)}</b> · {view.name} · {view.width}×{view.height}
            {genLabel(view) && <span style={{ color: '#a3aab8' }}> · {genLabel(view)}</span>}
            {view.note && <div className="mt-1 whitespace-pre-line" style={{ color: '#a3aab8' }}>{view.note}</div>}
            {view.gen?.prompt && (
              <details className="mt-1.5 text-left">
                <summary className="cursor-pointer text-[11.5px]" style={{ color: '#a3aab8' }}>프롬프트 보기</summary>
                <div className="mt-1 text-[11px] leading-relaxed whitespace-pre-line max-h-[18vh] overflow-y-auto" style={{ color: '#a3aab8' }}>{view.gen.prompt}</div>
              </details>
            )}
            <div className="mt-1 text-[11px]" style={{ color: '#6f7686' }}>바깥을 누르거나 Esc 로 닫기</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 작업 조건 — 카테고리마다 하나. 결과물을 만들 때 기준이 된다 */
function BriefCard({ brief, onSave }: { brief: string; onSave: (t: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(brief);
  const [state, setState] = useState<'' | 'saving' | 'error'>('');
  return (
    <div className="card p-3.5 mb-5">
      <div className="flex items-center gap-2">
        <div className="text-[13px] font-bold">작업 조건</div>
        <div className="flex-1" />
        {!editing && (
          <button type="button" className="chip" onClick={() => { setText(brief); setEditing(true); }}>{brief ? '고치기' : '적기'}</button>
        )}
      </div>
      {editing ? (
        <div className="mt-2">
          <textarea className="input w-full text-[12px] leading-relaxed" rows={Math.min(16, Math.max(5, text.split('\n').length + 1))}
                    value={text} onChange={(e) => setText(e.target.value)}
                    placeholder="예: A5 한 장 · 모든 캐릭터에 흰 아웃라인 · 요기보 로고 · 빈백 라운저/맥스/드롭/피라미드" />
          <div className="flex items-center gap-2 mt-2">
            <button type="button" className="btn btn-primary" disabled={state === 'saving'}
                    onClick={async () => {
                      setState('saving');
                      if (await onSave(text)) { setState(''); setEditing(false); } else setState('error');
                    }}>
              {state === 'saving' ? '저장 중…' : '저장'}
            </button>
            <button type="button" className="chip" onClick={() => { setEditing(false); setState(''); }}>취소</button>
            {state === 'error' && <span className="text-[11.5px]" style={{ color: 'var(--danger)' }}>저장하지 못했습니다</span>}
          </div>
        </div>
      ) : brief ? (
        <div className="text-[12.5px] mt-2 leading-relaxed whitespace-pre-line" style={{ color: 'var(--text-dim)' }}>{brief}</div>
      ) : (
        <div className="text-[12px] mt-1.5" style={{ color: 'var(--text-mute)' }}>
          이 카테고리의 조건(크기·필수 요소·버전 등)을 적어 두면 결과물을 만들 때 기준으로 씁니다.
        </div>
      )}
    </div>
  );
}

/** 올리기 칸 — 끌어다 놓기 · 눌러서 고르기 · Ctrl+V(마지막으로 손댄 칸으로) */
function UploadPanel(props: {
  title: string;
  memo: string;
  isActive: boolean;
  onActivate: () => void;
  queue: QueueEntry[];
  note: string;
  busy: string;
  err: string;
  bg: React.CSSProperties;
  onAdd: (files: File[]) => void;
  onRemove: (i: number) => void;
  onClear: () => void;
  onNote: (t: string) => void;
  onUpload: () => void;
}) {
  const { queue, note, busy, err, bg } = props;
  const pick = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  return (
    <div className="card p-3 mb-3.5" onPointerEnter={props.onActivate} onFocus={props.onActivate}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => pick.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') pick.current?.click(); }}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); props.onAdd([...e.dataTransfer.files]); }}
        className="rounded-lg px-4 py-4 text-center text-[12.5px] cursor-pointer"
        style={{
          border: `1.5px dashed ${drag ? 'var(--accent)' : 'var(--line)'}`,
          background: drag ? 'var(--accent-soft)' : 'var(--surface-2)',
          color: 'var(--text-dim)',
        }}
      >
        <b>{props.title}</b> 올리기 — 끌어다 놓거나 눌러서 고르세요 · <b>Ctrl+V</b> 로 캡처를 바로 붙여 넣어도 됩니다
        {props.isActive && <span className="ml-1.5 chip" style={{ ...ACTIVE, padding: '1px 7px' }}>Ctrl+V 는 이 칸</span>}
        <div className="text-[11px] mt-1" style={{ color: 'var(--text-mute)' }}>원본 그대로 저장합니다(줄이거나 다시 압축하지 않음) · PNG 투명 배경 유지</div>
        <input ref={pick} type="file" accept="image/*" multiple hidden
               onChange={(e) => { props.onAdd([...(e.target.files ?? [])]); e.target.value = ''; }} />
      </div>

      {queue.length > 0 && (
        <div className="mt-3">
          <div className="flex gap-2 flex-wrap">
            {queue.map((q, i) => (
              <QueueThumb key={q.url} name={q.file.name} url={q.url} bg={bg} onRemove={busy ? undefined : () => props.onRemove(i)} />
            ))}
          </div>
          <textarea className="input w-full mt-3" rows={2} value={note} onChange={(e) => props.onNote(e.target.value)}
                    placeholder={props.memo} />
          <div className="flex items-center gap-2.5 mt-2.5">
            <button type="button" className="btn btn-primary" onClick={props.onUpload} disabled={!!busy}>
              {busy || `${props.title} ${queue.length}장 올리기`}
            </button>
            {!busy && <button type="button" className="chip" onClick={props.onClear}>비우기</button>}
          </div>
        </div>
      )}
      {err && <div className="text-[11.5px] mt-2" style={{ color: 'var(--danger)' }}>{err}</div>}
    </div>
  );
}

/** 메모 칸 — 칸을 벗어나면 저장한다 */
function NoteField({ initial, onSave, placeholder }: { initial: string; onSave: (t: string) => Promise<boolean>; placeholder: string }) {
  const [text, setText] = useState(initial);
  const [state, setState] = useState<'' | 'saving' | 'saved' | 'error'>('');
  return (
    <div className="mt-1.5">
      <textarea
        className="input w-full text-[11.5px] leading-relaxed"
        rows={text ? Math.min(6, Math.max(2, text.split('\n').length + 1)) : 2}
        value={text}
        placeholder={placeholder}
        onChange={(e) => { setText(e.target.value); setState(''); }}
        onBlur={async () => {
          if (text.trim() === initial.trim()) return;
          setState('saving');
          setState((await onSave(text)) ? 'saved' : 'error');
        }}
      />
      {state && (
        <div className="text-[10.5px] mt-0.5" style={{ color: state === 'error' ? 'var(--danger)' : 'var(--text-mute)' }}>
          {state === 'saving' ? '저장 중…' : state === 'saved' ? '저장됨' : '저장하지 못했습니다'}
        </div>
      )}
    </div>
  );
}

/** 올리기 전 대기열 미리보기 */
function QueueThumb({ name, url, bg, onRemove }: { name: string; url: string; bg: React.CSSProperties; onRemove?: () => void }) {
  return (
    <div className="relative w-20" title={name}>
      <div className="w-20 h-20 rounded-md overflow-hidden" style={bg}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={name} className="w-full h-full object-contain" />
      </div>
      <div className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--text-mute)' }}>{name}</div>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label="빼기"
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full text-[11px] leading-none"
                style={{ background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text-dim)' }}>
          ×
        </button>
      )}
    </div>
  );
}
