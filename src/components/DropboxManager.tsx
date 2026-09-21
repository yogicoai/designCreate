'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { thumbUrl } from '@/lib/thumb';
import type { DropboxAssetDoc, DropboxSummary } from '@/lib/queries';

/**
 * 자산 관리 > 드롭박스 — 팀 드롭박스에서 복사해 온 제품사진 보관함 겸 검수 화면.
 *
 * 레퍼런스와 다른 점: 여기 있는 사진은 **아직 제품이 확정되지 않았다.**
 * 드롭박스 폴더명이 정확하다는 보장이 없어서(실측: '슬림' 폴더의 41장이 파일명에 midi,
 * '롤 닷' 6장은 전부 miniroll) 폴더명을 라벨로 쓰지 않고 근거로만 남겼다.
 * 이 화면의 일은 그 근거를 보고 **사람이 제품 라벨(sub)을 확정하는 것**이다.
 *
 * 그래서 화면이 목록이 아니라 검수 도구에 가깝다:
 *   ① 어긋남(conflict) 부터 걸러 본다 — 폴더와 파일명이 다른 것들
 *   ② 여러 장을 한 번에 골라 라벨을 찍는다 — 같은 촬영분은 보통 같은 제품이다
 *   ③ 확정한 것과 안 한 것이 칩 숫자로 계속 보인다
 *
 * 원본(드롭박스)은 읽기 전용이다. 이 화면에는 원본을 건드리는 동작이 없고,
 * 지우기도 숨김뿐이다 — sourcePath 로 언제든 원본에 되돌아갈 수 있다.
 */

const PAGE = 200;

const STATUS_KR: Record<string, { label: string; desc: string; tone: string }> = {
  conflict: { label: '어긋남', desc: '폴더명과 파일명이 다르다 — 먼저 봐야 할 것', tone: 'var(--danger, #e5484d)' },
  'folder-only': { label: '단서없음', desc: '파일명이 카메라 일련번호라 폴더명 말고는 근거가 없다', tone: 'var(--text-mute)' },
  agree: { label: '일치', desc: '폴더명과 파일명이 같은 제품을 가리킨다', tone: 'var(--accent)' },
};

type Filters = { folder: string; status: string; labeled: string; q: string };

export default function DropboxManager({
  initial,
  initialSummary,
  products,
}: {
  initial: DropboxAssetDoc[];
  initialSummary: DropboxSummary;
  /** 확정 라벨로 고를 수 있는 제품 이름 — 제품·컬러 화면에 등록된 것 */
  products: string[];
}) {
  const [items, setItems] = useState<DropboxAssetDoc[]>(initial);
  const [summary, setSummary] = useState<DropboxSummary>(initialSummary);
  const [total, setTotal] = useState(initialSummary.total);
  const [filters, setFilters] = useState<Filters>({ folder: '', status: '', labeled: '', q: '' });
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState('');
  const [labelDraft, setLabelDraft] = useState('');

  /** 검색은 타이핑마다 부르면 안 된다 — 멈춘 뒤에 한 번만 */
  const [qInput, setQInput] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === qInput ? f : { ...f, q: qInput })), 350);
    return () => clearTimeout(t);
  }, [qInput]);

  const qs = useCallback((skip: number, withSummary = false) => {
    const p = new URLSearchParams({ skip: String(skip), limit: String(PAGE) });
    if (filters.folder) p.set('folder', filters.folder);
    if (filters.status) p.set('status', filters.status);
    if (filters.labeled) p.set('labeled', filters.labeled);
    if (filters.q) p.set('q', filters.q);
    if (withSummary) p.set('summary', '1');
    return p.toString();
  }, [filters]);

  // 필터가 바뀌면 처음부터 다시 받는다. 선택은 비운다 — 안 보이는 것이 선택된 채로 남으면
  // "3장 선택"이라 써 있는데 화면에 한 장도 없는 상태가 된다
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setPicked(new Set());
    fetch(`/api/dropbox?${qs(0, true)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (!alive || !j?.ok) return;
        setItems(j.assets ?? []);
        setTotal(j.total ?? 0);
        if (j.summary) setSummary(j.summary);
      })
      .catch(() => setMsg('목록을 불러오지 못했습니다.'))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [qs]);

  const loadMore = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/dropbox?${qs(items.length)}`, { cache: 'no-store' });
      const j = await r.json();
      if (j?.ok) setItems((prev) => [...prev, ...(j.assets ?? [])]);
    } finally { setLoading(false); }
  };

  const refreshSummary = async () => {
    const r = await fetch(`/api/dropbox?${qs(0, true)}&limit=1`, { cache: 'no-store' });
    const j = await r.json();
    if (j?.summary) setSummary(j.summary);
  };

  const toggle = (url: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  };

  /** 고른 것들에 제품 라벨을 찍는다. 빈 값이면 라벨을 지운다(미확정으로 되돌리기) */
  const applyLabel = async (sub: string | null) => {
    const urls = [...picked];
    if (!urls.length) return;
    setLoading(true);
    try {
      const r = await fetch('/api/dropbox', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls, sub }),
      });
      const j = await r.json();
      if (!j?.ok) { setMsg(j?.error ?? '저장하지 못했습니다.'); return; }
      setItems((prev) => prev.map((it) => (picked.has(it.url) ? { ...it, sub } : it)));
      setMsg(`${urls.length}장에 ${sub ? `「${sub}」 라벨을 붙였습니다.` : '라벨을 지웠습니다.'}`);
      setPicked(new Set());
      setLabelDraft('');
      refreshSummary();
    } finally { setLoading(false); }
  };

  const hidePicked = async () => {
    const urls = [...picked];
    if (!urls.length) return;
    setLoading(true);
    try {
      await fetch('/api/dropbox', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
      setItems((prev) => prev.filter((it) => !picked.has(it.url)));
      setTotal((t) => Math.max(0, t - urls.length));
      setMsg(`${urls.length}장을 숨겼습니다. 원본은 드롭박스에 그대로 있습니다.`);
      setPicked(new Set());
      refreshSummary();
    } finally { setLoading(false); }
  };

  /** 라벨 후보 — 등록된 제품 + 폴더명에서 본 것. 폴더명은 근거일 뿐이지만 후보로는 쓸모 있다 */
  const labelOptions = useMemo(() => {
    const set = new Set<string>(products);
    summary.byFolder.forEach((f) => { if (f.folder && f.folder !== '(없음)') set.add(f.folder); });
    return [...set].sort((a, b) => a.localeCompare(b, 'ko'));
  }, [products, summary]);

  const chip = (active: boolean) => ({
    background: active ? 'var(--accent-soft)' : 'var(--surface-2)',
    color: active ? 'var(--accent)' : 'var(--text-dim)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
  });

  const pct = summary.total ? Math.round((summary.labeled / summary.total) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* 진행률 — 이 화면의 목적은 라벨을 채우는 것이라 그 진척이 맨 위에 있어야 한다 */}
      <section className="rounded-xl p-4" style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}>
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-[15px] font-bold">제품 라벨 확정 {summary.labeled.toLocaleString()} / {summary.total.toLocaleString()}장</span>
          <span className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
            {pct}% · 어긋남 {(summary.byStatus.conflict ?? 0).toLocaleString()}장 · 단서없음 {(summary.byStatus['folder-only'] ?? 0).toLocaleString()}장 · 일치 {(summary.byStatus.agree ?? 0).toLocaleString()}장
          </span>
        </div>
        <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--surface-2)' }}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'var(--accent)' }} />
        </div>
        <p className="text-[12px] mt-2 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
          드롭박스 폴더명은 분류가 아니라 <b>근거</b>입니다 — 실제로 &lsquo;슬림&rsquo; 폴더의 41장이 파일명에 <code>midi</code>를 달고 있었고 &lsquo;롤 닷&rsquo; 6장은 전부 <code>miniroll</code>이었습니다.
          <b>어긋남</b>부터 확인하고, 같은 촬영분을 여러 장 골라 한 번에 라벨을 찍으세요.
        </p>
      </section>

      {/* 필터 */}
      <section className="space-y-2.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="label mr-1">폴더</span>
          <button onClick={() => setFilters((f) => ({ ...f, folder: '' }))}
                  className="text-[12px] px-2.5 py-1 rounded-full" style={chip(!filters.folder)}>
            전체 {summary.total.toLocaleString()}
          </button>
          {summary.byFolder.map((f) => (
            <button key={f.folder} onClick={() => setFilters((p) => ({ ...p, folder: f.folder }))}
                    title={`${f.total}장 · 라벨 확정 ${f.labeled}장${f.conflict ? ` · 어긋남 ${f.conflict}장` : ''}`}
                    className="text-[12px] px-2.5 py-1 rounded-full" style={chip(filters.folder === f.folder)}>
              {f.folder} {f.total}
              {f.conflict > 0 && <span className="ml-1" style={{ color: STATUS_KR.conflict.tone }}>●</span>}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="label mr-1">검수</span>
          <button onClick={() => setFilters((f) => ({ ...f, status: '' }))}
                  className="text-[12px] px-2.5 py-1 rounded-full" style={chip(!filters.status)}>전체</button>
          {(['conflict', 'folder-only', 'agree'] as const).map((s) => (
            <button key={s} onClick={() => setFilters((f) => ({ ...f, status: s }))} title={STATUS_KR[s].desc}
                    className="text-[12px] px-2.5 py-1 rounded-full" style={chip(filters.status === s)}>
              {STATUS_KR[s].label} {(summary.byStatus[s] ?? 0).toLocaleString()}
            </button>
          ))}

          <span className="label ml-3 mr-1">라벨</span>
          {[['', '전체'], ['no', '미확정'], ['yes', '확정됨']].map(([v, l]) => (
            <button key={v || 'all'} onClick={() => setFilters((f) => ({ ...f, labeled: v }))}
                    className="text-[12px] px-2.5 py-1 rounded-full" style={chip(filters.labeled === v)}>{l}</button>
          ))}

          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="파일명 · 원본경로 검색"
            className="ml-auto text-[12px] px-2.5 py-1.5 rounded-lg w-[220px]"
            style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
          />
        </div>
      </section>

      {/* 고른 것에 라벨 찍기 — 선택이 있을 때만 나온다 */}
      {picked.size > 0 && (
        <section className="rounded-xl p-3 flex items-center gap-2 flex-wrap sticky top-2 z-20"
                 style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)' }}>
          <span className="text-[13px] font-bold" style={{ color: 'var(--accent)' }}>{picked.size}장 선택</span>
          <input
            list="dropbox-label-options"
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            placeholder="제품 라벨 (예: 미디)"
            className="text-[12px] px-2.5 py-1.5 rounded-lg w-[200px]"
            style={{ background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text)' }}
          />
          <datalist id="dropbox-label-options">
            {labelOptions.map((o) => <option key={o} value={o} />)}
          </datalist>
          <button onClick={() => applyLabel(labelDraft.trim() || null)} disabled={loading || !labelDraft.trim()}
                  className="text-[12px] font-semibold px-3 py-1.5 rounded-lg"
                  style={{ background: 'var(--accent)', color: '#fff', opacity: loading || !labelDraft.trim() ? 0.5 : 1, cursor: 'pointer' }}>
            라벨 확정
          </button>
          <button onClick={() => applyLabel(null)} disabled={loading}
                  className="text-[12px] px-3 py-1.5 rounded-lg"
                  style={{ background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text-dim)', cursor: 'pointer' }}>
            라벨 지우기
          </button>
          <button onClick={hidePicked} disabled={loading}
                  className="text-[12px] px-3 py-1.5 rounded-lg"
                  style={{ background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text-dim)', cursor: 'pointer' }}>
            숨기기
          </button>
          <button onClick={() => setPicked(new Set())}
                  className="text-[12px] px-3 py-1.5 rounded-lg ml-auto"
                  style={{ background: 'transparent', border: '1px solid var(--line)', color: 'var(--text-mute)', cursor: 'pointer' }}>
            선택 해제
          </button>
        </section>
      )}

      {msg && (
        <div className="text-[12px] px-3 py-2 rounded-lg" style={{ background: 'var(--surface-2)', color: 'var(--text-dim)' }}>
          {msg}
        </div>
      )}

      <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-mute)' }}>
        <span>{total.toLocaleString()}장 중 {items.length.toLocaleString()}장 표시</span>
        {items.length > 0 && (
          <button onClick={() => setPicked(new Set(items.map((i) => i.url)))}
                  className="underline" style={{ cursor: 'pointer' }}>
            보이는 것 전부 선택
          </button>
        )}
      </div>

      {/* 목록 */}
      <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
        {items.map((it) => {
          const on = picked.has(it.url);
          const st = STATUS_KR[it.labelStatus] ?? STATUS_KR['folder-only'];
          return (
            <div key={it.url} className="rounded-lg overflow-hidden"
                 style={{ background: 'var(--surface)', border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`, outline: on ? '1px solid var(--accent)' : 'none' }}>
              {/* 타일 클릭 = 선택. 검수는 고르는 동작이 압도적으로 잦아서 확대보다 우선이다 */}
              <div className="relative">
                <button onClick={() => toggle(it.url)} className="block w-full" style={{ cursor: 'pointer' }}
                        aria-pressed={on} title={it.sourcePath}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={thumbUrl(it.url, 256)} alt={it.title} loading="lazy"
                       className="w-full aspect-square object-cover block"
                       style={{ background: 'var(--surface-2)', opacity: on ? 0.75 : 1 }} />
                </button>
                {on && (
                  <span className="absolute top-1.5 left-1.5 w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold pointer-events-none"
                        style={{ background: 'var(--accent)', color: '#fff' }}>✓</span>
                )}
                {/* 확대는 따로 — 원본이 장당 수 MB 라 새 탭에서 연다 */}
                <a href={it.url} target="_blank" rel="noreferrer" title="원본 크게 보기"
                   className="absolute top-1.5 right-1.5 w-6 h-6 rounded-md flex items-center justify-center text-[11px]"
                   style={{ background: 'rgba(0,0,0,.55)', color: '#fff' }}>⤢</a>
                {/* 확정 라벨이 있으면 그게 가장 중요한 정보라 사진 위에 얹는다 */}
                {it.sub && (
                  <span className="absolute bottom-1.5 left-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded pointer-events-none"
                        style={{ background: 'var(--accent)', color: '#fff' }}>{it.sub}</span>
                )}
              </div>
              <div className="px-2 py-1.5 space-y-1">
                <div className="text-[11px] truncate" title={it.title}>{it.title}</div>
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="text-[9.5px] px-1.5 py-[2px] rounded-full"
                        style={{ background: 'var(--surface-2)', color: 'var(--text-mute)' }} title="드롭박스 폴더명 — 근거일 뿐 분류가 아니다">
                    📁 {it.folderHint}
                  </span>
                  {it.filenameHint.length > 0 && (
                    <span className="text-[9.5px] px-1.5 py-[2px] rounded-full"
                          style={{ background: 'var(--surface-2)', color: 'var(--text-mute)' }} title="파일명에서 찾은 제품 토큰">
                      {it.filenameHint.join(', ')}
                    </span>
                  )}
                  <span className="text-[9.5px] px-1.5 py-[2px] rounded-full" title={st.desc}
                        style={{ background: 'var(--surface-2)', color: st.tone }}>
                    {st.label}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {items.length < total && (
        <div className="flex justify-center pt-2">
          <button onClick={loadMore} disabled={loading}
                  className="text-[13px] px-4 py-2 rounded-lg"
                  style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text-dim)', cursor: 'pointer' }}>
            {loading ? '불러오는 중…' : `${Math.min(PAGE, total - items.length)}장 더 보기`}
          </button>
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="text-[13px] py-10 text-center" style={{ color: 'var(--text-mute)' }}>
          조건에 맞는 사진이 없습니다.
        </div>
      )}
    </div>
  );
}
