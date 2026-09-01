'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * 시즌 트렌드 참고 보드.
 *
 * "작년 이맘때 어떤 디자인이 돌았나" 를 월별로 쌓아두고 보는 화면.
 * 원본 이미지는 우리 서버에 보관하지 않는다 — 썸네일과 출처 링크만 담는다.
 * 그래서 생성 레퍼런스 보관함과도 분리돼 있고, 생성 화면에는 뜨지 않는다.
 */

interface Found {
  link: string;
  thumbnail: string;
  title: string;
  sizeWidth: number;
  sizeHeight: number;
  saved?: boolean;
}
interface Saved {
  id: string;
  thumb: string;
  sourceUrl: string;
  title: string;
  keyword: string;
  month: string;
  width: number;
  height: number;
  collectedAt: string | null;
}

/*
 * 자주 쓰는 검색어 — 매번 타이핑하지 않게.
 * 우리는 빈백 회사다. 일반 디자인·배너 검색어는 우리 제품과 무관한 결과만 끌고 오므로 넣지 않는다.
 * 전부 빈백을 중심에 두고, 쓰임새(거실·침실·키즈·게이밍·캠핑)로 갈래를 낸다.
 */
const PRESETS = [
  '빈백소파', '빈백 인테리어', '빈백 거실', '요기보',
  '빈백 침대', '키즈 빈백', '게이밍 빈백', '캠핑 빈백',
  '좌식소파 인테리어', '빈백 원룸',
];

interface Promo {
  id?: string;
  title: string; link: string; desc: string; date: string;
  source: string; kind: 'blog' | 'cafe';
  brand: string; discount: number; price: number; copy: string[];
  isOurs?: boolean; saved?: boolean; keyword?: string; month?: string;
}

/** 이벤트·특가 검색어 — 할인 표기가 붙은 글이 잘 걸리는 조합 */
const PROMO_PRESETS = ['빈백 할인 특가', '빈백소파 세일', '빈백 이벤트', '빈백 공동구매', '빈백 최저가'];

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function TrendBoard() {
  const [tab, setTab] = useState<'image' | 'promo'>('image');
  const [configured, setConfigured] = useState(true);
  const [promos, setPromos] = useState<Promo[]>([]);
  const [foundPromos, setFoundPromos] = useState<Promo[]>([]);
  const [pickedPromos, setPickedPromos] = useState<Set<string>>(new Set());
  // 요기보는 우리 브랜드라 경쟁사 분석에서 기본으로 뺀다
  const [showOurs, setShowOurs] = useState(false);
  /** 업체별 대표 이미지 — 검색 후 한 번 더 불러온다 (저장하지 않음) */
  const [brandImgs, setBrandImgs] = useState<Record<string, { link: string; thumbnail: string }[]>>({});
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState('');
  const [saved, setSaved] = useState<Saved[]>([]);

  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saveMonth, setSaveMonth] = useState(thisMonth());
  const [busy, setBusy] = useState<'search' | 'save' | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async (m: string) => {
    const res = await fetch(`/api/trends${m ? `?month=${m}` : ''}`);
    const j = await res.json();
    if (!j.ok) { setErr(j.error || '불러오기 실패'); return; }
    setConfigured(j.configured);
    setMonths(j.months ?? []);
    setSaved(j.items ?? []);
    setPromos(j.promos ?? []);
  }, []);
  useEffect(() => { load(month); }, [load, month]);

  async function search() {
    const query = q.trim();
    if (!query) return;
    setBusy('search'); setErr(''); setNote(''); setPicked(new Set());
    try {
      const res = await fetch('/api/trends', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: query, display: 48 }),
      });
      const j = await res.json();
      if (!j.ok) { setErr(j.error || '검색 실패'); setFound([]); return; }
      setFound(j.items ?? []);
      if (!j.items?.length) setNote('결과가 없습니다. 다른 검색어를 써보세요.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function keep() {
    const items = found.filter((f) => picked.has(f.link));
    if (!items.length) return;
    setBusy('save'); setErr('');
    try {
      const res = await fetch('/api/trends', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items, month: saveMonth, keyword: q.trim() }),
      });
      const j = await res.json();
      if (!j.ok) { setErr(j.error || '담기 실패'); return; }
      setNote(`${j.saved}장 담았습니다${j.failed ? ` (${j.failed}장 실패)` : ''} · ${j.month}`);
      setFound((cur) => cur.map((f) => (picked.has(f.link) ? { ...f, saved: true } : f)));
      setPicked(new Set());
      load(month);
    } finally {
      setBusy(null);
    }
  }

  async function searchPromo() {
    const query = q.trim();
    if (!query) return;
    setBusy('search'); setErr(''); setNote(''); setPickedPromos(new Set());
    try {
      const res = await fetch('/api/trends', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'promo', q: query, display: 40 }),
      });
      const j = await res.json();
      if (!j.ok) { setErr(j.error || '검색 실패'); setFoundPromos([]); return; }
      setFoundPromos(j.posts ?? []);
      if (!j.posts?.length) setNote('결과가 없습니다.');
      // 잡힌 업체들의 대표 이미지를 이어서 불러온다 — "어떤 비주얼을 쓰나" 가 같이 보여야 한다
      const brands = [...new Set((j.posts ?? []).filter((x: Promo) => !x.isOurs && x.brand).map((x: Promo) => x.brand))];
      if (brands.length) {
        fetch('/api/trends', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'brandimg', brands }),
        })
          .then((r) => r.json())
          .then((bj) => { if (bj.ok) setBrandImgs(bj.brandImages ?? {}); })
          .catch(() => {});
      }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  async function keepPromo() {
    const picks = foundPromos.filter((p) => pickedPromos.has(p.link));
    if (!picks.length) return;
    setBusy('save'); setErr('');
    try {
      const res = await fetch('/api/trends', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ posts: picks, month: saveMonth, keyword: q.trim() }),
      });
      const j = await res.json();
      if (!j.ok) { setErr(j.error || '담기 실패'); return; }
      setNote(`${j.saved}건 담았습니다.`);
      setFoundPromos((cur) => cur.map((p) => (pickedPromos.has(p.link) ? { ...p, saved: true } : p)));
      setPickedPromos(new Set());
      load(month);
    } finally { setBusy(null); }
  }

  async function removePromo(id: string) {
    if (!window.confirm('이 기록을 지울까요?')) return;
    const res = await fetch('/api/trends', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, kind: 'promo' }),
    });
    if ((await res.json()).ok) setPromos((cur) => cur.filter((x) => x.id !== id));
  }

  /** 업체별로 묶는다 — "어느 업체가 언제 얼마에 뭘 했나" 가 이 화면의 목적이다 */
  function byBrand(list: Promo[]): [string, Promo[]][] {
    const m = new Map<string, Promo[]>();
    for (const p of list) {
      if (!showOurs && p.isOurs) continue;
      const b = p.brand || '(미상)';
      if (!m.has(b)) m.set(b, []);
      m.get(b)!.push(p);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }

  async function remove(id: string) {
    if (!window.confirm('이 참고 이미지를 보드에서 지울까요?')) return;
    const res = await fetch('/api/trends', {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
    });
    if ((await res.json()).ok) setSaved((cur) => cur.filter((x) => x.id !== id));
  }

  const toggle = (link: string) =>
    setPicked((cur) => {
      const n = new Set(cur);
      if (n.has(link)) n.delete(link); else n.add(link);
      return n;
    });

  return (
    <div>
      {!configured && (
        <div className="card p-4 mb-4" style={{ borderColor: 'var(--warn)' }}>
          <div className="text-[13px] font-bold mb-1" style={{ color: 'var(--warn)' }}>네이버 검색 API 키가 없습니다</div>
          <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
            developers.naver.com 에서 애플리케이션을 등록하고 <b>검색</b> API 를 체크한 뒤,
            <code className="mx-1 px-1 rounded" style={{ background: 'var(--surface-2)' }}>NAVER_CLIENT_ID</code>
            <code className="mx-1 px-1 rounded" style={{ background: 'var(--surface-2)' }}>NAVER_CLIENT_SECRET</code>
            을 .env.local 에 넣어주세요. 무료이고 하루 25,000회까지 됩니다.
            <br />저장된 보드는 키 없이도 볼 수 있습니다.
          </div>
        </div>
      )}

      {/* 탭 — 이미지 보드와 이벤트 기록은 성격이 달라 화면을 나눈다 */}
      <div className="flex gap-1.5 mb-4">
        {([['image', '연출 이미지'], ['promo', '이벤트 · 특가']] as const).map(([v, l]) => (
          <button key={v} onClick={() => { setTab(v); setNote(''); setErr(''); }} className="chip"
                  style={tab === v ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
            {l}
          </button>
        ))}
      </div>

      {/* ── 찾기 ── */}
      <div className="card p-4 mb-4">
        <div className="label mb-2">1. 찾기</div>
        <div className="flex gap-2 mb-2 flex-wrap">
          <input
            className="input flex-1" style={{ minWidth: 220 }}
            value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') (tab === 'promo' ? searchPromo() : search()); }}
            placeholder="예: 빈백 / 빈백소파 / 빈백 인테리어 — 빈백 관련 검색어를 넣으세요"
            disabled={!configured}
          />
          <button className="btn btn-primary" onClick={tab === 'promo' ? searchPromo : search}
                  disabled={!configured || busy === 'search' || !q.trim()}>
            {busy === 'search' ? '찾는 중…' : '검색'}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(tab === 'promo' ? PROMO_PRESETS : PRESETS).map((p) => (
            <button key={p} className="chip" onClick={() => setQ(p)} disabled={!configured}>{p}</button>
          ))}
        </div>
        {note && <div className="text-[11px] mt-2" style={{ color: 'var(--ok)' }}>{note}</div>}
        {err && <div className="text-[11px] mt-2" style={{ color: 'var(--danger)' }}>{err}</div>}
      </div>

      {/* ── 결과에서 고르기 (연출 이미지) ── */}
      {tab === 'image' && found.length > 0 && (
        <div className="card p-4 mb-4">
          <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
            <div className="label">
              2. 담을 것만 고르세요{' '}
              <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>
                — 고른 것만 저장됩니다. 원본은 받지 않고 썸네일과 출처만 남습니다.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>월</span>
              <input className="input py-1 text-[11px]" style={{ width: 100 }} value={saveMonth}
                     onChange={(e) => setSaveMonth(e.target.value)} placeholder="YYYY-MM" />
              <button className="btn btn-primary text-[12px]" onClick={keep} disabled={!picked.size || busy === 'save'}>
                {busy === 'save' ? '담는 중…' : `${picked.size}장 담기`}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2.5">
            {found.map((f) => {
              const on = picked.has(f.link);
              return (
                <div key={f.link}>
                  <button onClick={() => toggle(f.link)} className="block w-full rounded-lg overflow-hidden border relative"
                          style={{ padding: 0, borderColor: on ? 'var(--accent)' : 'var(--line)', borderWidth: on ? 2 : 1, background: 'var(--surface-2)' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={f.thumbnail} alt={f.title} loading="lazy" className="w-full object-cover" style={{ aspectRatio: '1/1' }} />
                    {on && (
                      <span className="absolute top-1 left-1 w-5 h-5 rounded-full text-[11px] flex items-center justify-center"
                            style={{ background: 'var(--accent)', color: '#fff' }}>✓</span>
                    )}
                    {f.saved && !on && (
                      <span className="absolute top-1 right-1 px-1 rounded text-[9px]"
                            style={{ background: 'rgba(0,0,0,.6)', color: '#9fe0a8' }}>담김</span>
                    )}
                  </button>
                  <div className="text-[9.5px] mt-1 truncate" style={{ color: 'var(--text-mute)' }}>
                    {f.sizeWidth}×{f.sizeHeight}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 이벤트·특가: 검색 결과 (업체별) ── */}
      {tab === 'promo' && foundPromos.length > 0 && (
        <div className="card p-4 mb-4">
          <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
            <div className="label">
              2. 담을 것만 고르세요{' '}
              <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>
                — 업체별로 묶었습니다. 게시일이 있으면 그 달로 정리됩니다.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[11px] flex items-center gap-1" style={{ color: 'var(--text-mute)' }}>
                <input type="checkbox" checked={showOurs} onChange={(e) => setShowOurs(e.target.checked)} />
                요기보(자사) 포함
              </label>
              <button className="btn btn-primary text-[12px]" onClick={keepPromo}
                      disabled={!pickedPromos.size || busy === 'save'}>
                {busy === 'save' ? '담는 중…' : `${pickedPromos.size}건 담기`}
              </button>
            </div>
          </div>

          {byBrand(foundPromos).map(([brand, list]) => {
            const ds = list.map((x) => x.discount).filter(Boolean);
            const ps = list.map((x) => x.price).filter(Boolean);
            return (
              <div key={brand} className="mb-3">
                <div className="text-[12px] font-bold mb-1.5 flex items-center gap-2 flex-wrap">
                  <span>{brand}</span>
                  <span className="text-[10.5px] font-normal" style={{ color: 'var(--text-mute)' }}>{list.length}건</span>
                  {ds.length > 0 && <span className="chip" style={{ color: 'var(--warn)' }}>할인 {Math.min(...ds)}~{Math.max(...ds)}%</span>}
                  {ps.length > 0 && <span className="chip" style={{ color: 'var(--info)' }}>{Math.min(...ps)}~{Math.max(...ps)}만원</span>}
                </div>
                {(() => {
                  // 이 업체가 반복해서 쓰는 문구 — 브랜드가 무엇을 소구하는지가 여기 드러난다
                  const all = [...new Set(list.flatMap((x) => x.copy ?? []))].slice(0, 8);
                  return all.length > 0 ? (
                    <div className="text-[10.5px] mb-1.5" style={{ color: 'var(--accent)' }}>
                      쓰는 문구: {all.join(' · ')}
                    </div>
                  ) : null;
                })()}
                {(brandImgs[brand] ?? []).length > 0 && (
                  <div className="flex gap-1.5 mb-1.5 overflow-x-auto pb-1">
                    {(brandImgs[brand] ?? []).map((im) => (
                      <a key={im.link} href={im.link} target="_blank" rel="noreferrer noopener" className="shrink-0">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={im.thumbnail} alt={brand} loading="lazy"
                             className="rounded-lg border object-cover"
                             style={{ width: 74, height: 74, borderColor: 'var(--line)' }} />
                      </a>
                    ))}
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  {list.map((pp) => {
                    const on = pickedPromos.has(pp.link);
                    return (
                      <div key={pp.link} className="flex items-start gap-2 p-2 rounded-lg"
                           style={{ background: on ? 'var(--accent-soft)' : 'var(--surface-2)' }}>
                        <input type="checkbox" checked={on} className="mt-0.5"
                               onChange={() => setPickedPromos((c) => {
                                 const n = new Set(c);
                                 if (n.has(pp.link)) n.delete(pp.link); else n.add(pp.link);
                                 return n;
                               })} />
                        <div className="min-w-0 flex-1">
                          <a href={pp.link} target="_blank" rel="noreferrer noopener"
                             className="text-[11.5px] block truncate" style={{ color: 'var(--text-dim)' }}>{pp.title}</a>
                          <div className="flex items-center gap-1.5 flex-wrap mt-0.5 text-[10px]" style={{ color: 'var(--text-mute)' }}>
                            <span>{pp.date || '날짜없음'}</span>
                            <span>· {pp.kind === 'cafe' ? '카페' : '블로그'}</span>
                            {pp.discount > 0 && <span style={{ color: 'var(--warn)' }}>· {pp.discount}%</span>}
                            {pp.price > 0 && <span style={{ color: 'var(--info)' }}>· {pp.price}만원</span>}
                            {pp.saved && <span style={{ color: 'var(--ok)' }}>· 담김</span>}
                          </div>
                          {pp.copy.length > 0 && (
                            <div className="text-[10px] mt-0.5" style={{ color: 'var(--accent)' }}>
                              카피: {pp.copy.join(' · ')}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── 이벤트·특가: 담아둔 기록 (업체별) ── */}
      {tab === 'promo' && (
        promos.length === 0 ? (
          <div className="card p-8 text-center text-[13px]" style={{ color: 'var(--text-dim)' }}>
            아직 담아둔 이벤트 기록이 없습니다. 위에서 검색해 담아보세요.
          </div>
        ) : (
          <div className="card p-4">
            <div className="label mb-2">담아둔 기록 — 업체별</div>
            {byBrand(promos).map(([brand, list]) => (
              <div key={brand} className="mb-3">
                <div className="text-[12px] font-bold mb-1.5">
                  {brand} <span className="text-[10.5px] font-normal" style={{ color: 'var(--text-mute)' }}>{list.length}건</span>
                </div>
                {list.map((pp) => (
                  <div key={pp.id} className="flex items-start gap-2 p-2 rounded-lg mb-1" style={{ background: 'var(--surface-2)' }}>
                    <div className="min-w-0 flex-1">
                      <a href={pp.link} target="_blank" rel="noreferrer noopener"
                         className="text-[11.5px] block truncate" style={{ color: 'var(--text-dim)' }}>{pp.title}</a>
                      <div className="flex items-center gap-1.5 flex-wrap mt-0.5 text-[10px]" style={{ color: 'var(--text-mute)' }}>
                        <span>{pp.date || pp.month}</span>
                        {pp.discount > 0 && <span style={{ color: 'var(--warn)' }}>· {pp.discount}%</span>}
                        {pp.price > 0 && <span style={{ color: 'var(--info)' }}>· {pp.price}만원</span>}
                      </div>
                      {pp.copy?.length > 0 && (
                        <div className="text-[10px] mt-0.5" style={{ color: 'var(--accent)' }}>카피: {pp.copy.join(' · ')}</div>
                      )}
                    </div>
                    <button onClick={() => removePromo(pp.id!)}
                            style={{ color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 10 }}>
                      삭제
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )
      )}

      {/* ── 월별 보드 ── */}
      {tab === 'image' && (
      <div className="flex items-center gap-1.5 mb-3 flex-wrap">
        <span className="label mr-1">월별</span>
        <button className="chip" onClick={() => setMonth('')}
                style={!month ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>전체</button>
        {months.map((m) => (
          <button key={m} className="chip" onClick={() => setMonth(m === month ? '' : m)}
                  style={month === m ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>{m}</button>
        ))}
      </div>
      )}

      {tab === 'image' && (saved.length === 0 ? (
        <div className="card p-8 text-center text-[13px]" style={{ color: 'var(--text-dim)' }}>
          아직 담아둔 참고 이미지가 없습니다. 위에서 검색해 마음에 드는 것만 담아보세요.
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
          {saved.map((s) => (
            <div key={s.id}>
              <a href={s.sourceUrl} target="_blank" rel="noreferrer noopener" title={`${s.title}\n출처 보기`}
                 className="block rounded-lg overflow-hidden border" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.thumb} alt={s.title} loading="lazy" className="w-full object-cover" style={{ aspectRatio: '1/1' }} />
              </a>
              <div className="text-[9.5px] mt-1 truncate" style={{ color: 'var(--text-dim)' }}>{s.keyword || s.title}</div>
              <div className="flex items-center gap-2 text-[9px]" style={{ color: 'var(--text-mute)' }}>
                <span>{s.month}</span>
                <button onClick={() => remove(s.id)} className="ml-auto"
                        style={{ color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 9 }}>
                  삭제
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
