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
  const [tab, setTab] = useState<'image' | 'promo' | 'copy'>('image');
  const [configured, setConfigured] = useState(true);
  const [promos, setPromos] = useState<Promo[]>([]);
  const [foundPromos, setFoundPromos] = useState<Promo[]>([]);
  const [pickedPromos, setPickedPromos] = useState<Set<string>>(new Set());
  // 요기보는 우리 브랜드라 경쟁사 분석에서 기본으로 뺀다
  const [showOurs, setShowOurs] = useState(false);
  /** 업체별 대표 이미지 — 검색 후 한 번 더 불러온다 (저장하지 않음) */
  const [brandImgs, setBrandImgs] = useState<Record<string, Found[]>>({});
  /** 업체 이미지 중 담을 것 — 이 화면의 결과물은 결국 이미지다 */
  const [pickedBrandImgs, setPickedBrandImgs] = useState<Set<string>>(new Set());
  const [brands, setBrands] = useState<string[]>([]);
  const [loadingImgs, setLoadingImgs] = useState(false);
  /** 크게 보기 팝업 — 새 창으로 튕기지 않고 이 자리에서 확인한다 */
  const [zoom, setZoom] = useState<{ src: string; label: string; href: string } | null>(null);
  const [copyData, setCopyData] = useState<{
    month: number;
    season: { label: string; angle: string; keywords: string[] };
    suggestions: string[];
    harvested: { phrase: string; count: number }[];
    median: number;
    sampled: number;
    monthFiltered: boolean;
    years: string[];
    totalFetched: number;
  } | null>(null);
  const [copyMonth, setCopyMonth] = useState(new Date().getMonth() + 1);
  const [copied, setCopied] = useState('');
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
    setBrands(j.brands ?? []);
  }, []);
  useEffect(() => { load(month); }, [load, month]);

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(null); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [zoom]);

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

  /*
   * 이벤트·특가 탭을 열면 검색을 기다리지 않고 추적 업체 이미지를 먼저 띄운다.
   * 이 화면의 주인공은 이미지다 — 빈 화면에서 검색어부터 치게 만들 이유가 없다.
   */
  useEffect(() => {
    if (tab !== 'promo' || !configured) return;
    if (!brands.length || Object.keys(brandImgs).length) return;
    setLoadingImgs(true);
    fetch('/api/trends', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'brandimg', brands }),
    })
      .then((r) => r.json())
      .then((j) => { if (j.ok) setBrandImgs(j.brandImages ?? {}); })
      .catch(() => {})
      .finally(() => setLoadingImgs(false));
  }, [tab, configured, brands, brandImgs]);

  useEffect(() => {
    if (tab !== 'copy' || !configured) return;
    if (copyData && copyData.month === copyMonth) return;
    fetch('/api/trends', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'copy', month: copyMonth }),
    })
      .then((r) => r.json())
      .then((j) => { if (j.ok) setCopyData(j); })
      .catch(() => {});
  }, [tab, configured, copyMonth, copyData]);

  /** 문구를 이미지 검색 씨앗으로 — 이 화면에서 가장 쓸모 있는 동선이다 */
  function seedImageSearch(phrase: string) {
    setQ(`빈백 ${phrase}`.slice(0, 60));
    setTab('image');
    window.setTimeout(() => search(), 0);
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

  /** 업체 이미지를 월별 이미지 보드로 담는다 — 두 탭을 잇는 지점 */
  async function keepBrandImgs() {
    const all = Object.values(brandImgs).flat();
    const picks = all.filter((x) => pickedBrandImgs.has(x.link));
    if (!picks.length) return;
    setBusy('save'); setErr('');
    try {
      const res = await fetch('/api/trends', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: picks, month: saveMonth, keyword: q.trim() || '경쟁사' }),
      });
      const j = await res.json();
      if (!j.ok) { setErr(j.error || '담기 실패'); return; }
      setNote(`이미지 ${j.saved}장을 ${j.month} 보드에 담았습니다.`);
      setPickedBrandImgs(new Set());
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
        {([['image', '연출 이미지'], ['promo', '이벤트 · 특가'], ['copy', '문구 추천']] as const).map(([v, l]) => (
          <button key={v} onClick={() => { setTab(v); setNote(''); setErr(''); }} className="chip"
                  style={tab === v ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
            {l}
          </button>
        ))}
      </div>

      {/* ── 찾기 ── */}
      {tab !== 'copy' && (
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
      )}

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
      {tab === 'promo' && (foundPromos.length > 0 || Object.keys(brandImgs).length > 0) && (
        <div className="card p-4 mb-4">
          <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
            <div className="label">
              2. 업체별 — 이미지를 골라 담으세요{' '}
              <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>
                — 담은 이미지는 &apos;연출 이미지&apos; 탭의 월별 보드로 갑니다.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[11px] flex items-center gap-1" style={{ color: 'var(--text-mute)' }}>
                <input type="checkbox" checked={showOurs} onChange={(e) => setShowOurs(e.target.checked)} />
                요기보(자사) 포함
              </label>
              <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>월</span>
              <input className="input py-1 text-[11px]" style={{ width: 96 }} value={saveMonth}
                     onChange={(e) => setSaveMonth(e.target.value)} placeholder="YYYY-MM" />
              <button className="btn btn-primary text-[12px]" onClick={keepBrandImgs}
                      disabled={!pickedBrandImgs.size || busy === 'save'}>
                {busy === 'save' ? '담는 중…' : `이미지 ${pickedBrandImgs.size}장 담기`}
              </button>
              <button className="btn text-[12px]" onClick={keepPromo}
                      disabled={!pickedPromos.size || busy === 'save'}>
                글 {pickedPromos.size}건
              </button>
            </div>
          </div>

          {loadingImgs && (
            <div className="text-[11px] mb-2" style={{ color: 'var(--text-mute)' }}>업체 이미지를 불러오는 중…</div>
          )}

          {(byBrand(foundPromos).length
            ? byBrand(foundPromos)
            : brands.map((b) => [b, [] as Promo[]] as [string, Promo[]])
          ).map(([brand, list]) => {
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
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-2">
                    {(brandImgs[brand] ?? []).map((im) => {
                      const on = pickedBrandImgs.has(im.link);
                      return (
                        <button key={im.link} className="rounded-lg overflow-hidden border relative block w-full"
                                style={{ padding: 0, background: 'var(--surface-2)',
                                         borderColor: on ? 'var(--accent)' : 'var(--line)', borderWidth: on ? 2 : 1 }}
                                onClick={() => setZoom({ src: im.thumbnail, label: brand, href: im.link })}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={im.thumbnail} alt={brand} loading="lazy"
                               className="w-full object-cover" style={{ aspectRatio: '1/1', cursor: 'zoom-in' }} />
                          {/* 담기 선택은 배지로 분리 — 이미지 클릭은 크게 보기여야 자연스럽다 */}
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation();
                              setPickedBrandImgs((c) => {
                                const n = new Set(c);
                                if (n.has(im.link)) n.delete(im.link); else n.add(im.link);
                                return n;
                              });
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.click(); }}
                            className="absolute top-1 left-1 w-5 h-5 rounded-full text-[11px] flex items-center justify-center"
                            style={{
                              background: on ? 'var(--accent)' : 'rgba(0,0,0,.45)',
                              color: '#fff', cursor: 'pointer',
                            }}
                            title={on ? '담기 취소' : '담을 이미지로 선택'}
                          >
                            {on ? '✓' : '+'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <details>
                  <summary className="text-[10.5px] cursor-pointer mb-1" style={{ color: 'var(--text-mute)' }}>
                    관련 글 {list.length}건 보기
                  </summary>
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
                </details>
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

      {/* ── 문구 추천 ── */}
      {tab === 'copy' && (
        <>
          <div className="card p-4 mb-4">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <span className="label">월</span>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <button key={m} className="chip" onClick={() => setCopyMonth(m)}
                        style={copyMonth === m ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                  {m}월
                </button>
              ))}
            </div>
            {copyData && (
              <div className="text-[12px]">
                <b>{copyData.season.label}</b>
                <span className="ml-2" style={{ color: 'var(--text-dim)' }}>{copyData.season.angle}</span>
                <div className="text-[10.5px] mt-1 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
                  검색어 <b style={{ color: 'var(--text-dim)' }}>{copyData.season.keywords.join(' · ')}</b>
                  {' → 네이버 블로그·카페 '}{copyData.totalFetched}건 중{' '}
                  {copyData.monthFiltered ? (
                    <>
                      <b style={{ color: 'var(--text-dim)' }}>{copyMonth}월에 올라온 {copyData.sampled}건</b>
                      {copyData.years.length > 0 && ` (${copyData.years.join('·')}년)`}
                    </>
                  ) : (
                    <>
                      <b style={{ color: 'var(--warn)' }}>{copyData.sampled}건 전체</b>
                      {` — ${copyMonth}월 글이 10건 미만이라 월 구분 없이 집계했습니다`}
                    </>
                  )}
                  <br />
                  경쟁사 할인 중앙값 <b style={{ color: 'var(--warn)' }}>{copyData.median || '—'}%</b>
                  {' — 이벤트·특가 탭에 담아둔 기록에서 계산합니다.'}
                </div>
              </div>
            )}
          </div>

          {!copyData ? (
            <div className="card p-8 text-center text-[13px]" style={{ color: 'var(--text-dim)' }}>
              문구를 모으는 중…
            </div>
          ) : (
            <>
              <div className="card p-4 mb-4">
                <div className="label mb-1">추천 문구</div>
                <div className="text-[10.5px] mb-2 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
                  이건 <b style={{ color: 'var(--text-dim)' }}>수집이 아니라 제안</b>입니다 — 시즌에 맞춰 만든 문장이고,
                  숫자(<b style={{ color: 'var(--warn)' }}>{copyData.median || '—'}%</b>)만 경쟁사 실측값입니다.
                  <br />클릭하면 복사, <b>이미지 찾기</b>를 누르면 그 문구로 레퍼런스를 검색합니다.
                </div>
                <div className="flex flex-col gap-1.5">
                  {copyData.suggestions.map((x) => (
                    <div key={x} className="flex items-center gap-2 p-2 rounded-lg" style={{ background: 'var(--surface-2)' }}>
                      <button className="text-[12px] text-left flex-1 min-w-0"
                              style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: 0 }}
                              onClick={() => { navigator.clipboard?.writeText(x); setCopied(x); window.setTimeout(() => setCopied(''), 1500); }}>
                        {x}
                      </button>
                      {copied === x && <span className="text-[10px] shrink-0" style={{ color: 'var(--ok)' }}>복사됨 ✓</span>}
                      <button className="chip shrink-0" onClick={() => seedImageSearch(x.split(/[·,]/)[0].trim())}>
                        이미지 찾기
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="card p-4">
                <div className="label mb-1">
                  {copyMonth}월에 실제로 많이 쓰인 표현
                </div>
                <div className="text-[10.5px] mb-2 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
                  집계 기준: 위 검색어로 모은 글의 제목·요약에서 판촉 표현을 뽑아,
                  <b style={{ color: 'var(--text-dim)' }}> 한 글에 한 번만</b> 세고
                  <b style={{ color: 'var(--text-dim)' }}> 2회 이상</b> 나온 것만 남깁니다.
                  띄어쓰기만 다른 말은 합칩니다. 옆의 숫자가 등장 글 수입니다.
                  <br />업종을 가리지 않은 표본이라 빈백 업계 밖 표현도 섞입니다 — 참고용으로 보세요.
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {copyData.harvested.map((h) => (
                    <button key={h.phrase} className="chip" title="이 표현으로 이미지 검색"
                            onClick={() => seedImageSearch(h.phrase)}>
                      {h.phrase} <span style={{ color: 'var(--text-mute)' }}>{h.count}</span>
                    </button>
                  ))}
                  {copyData.harvested.length === 0 && (
                    <span className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
                      반복 등장한 표현이 없습니다.
                    </span>
                  )}
                </div>
              </div>
            </>
          )}
        </>
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
              <button onClick={() => setZoom({ src: s.thumb, label: s.keyword || s.title, href: s.sourceUrl })}
                      title="클릭하면 크게 보기"
                      className="block w-full rounded-lg overflow-hidden border"
                      style={{ padding: 0, borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.thumb} alt={s.title} loading="lazy" className="w-full object-cover"
                     style={{ aspectRatio: '1/1', cursor: 'zoom-in' }} />
              </button>
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

      {/* 크게 보기 — 새 창으로 튕기면 흐름이 끊긴다. 출처로 가는 길은 팝업 안에 둔다. */}
      {zoom && (
        <div onClick={() => setZoom(null)}
             className="fixed inset-0 z-50 flex flex-col items-center justify-center p-6 gap-3"
             style={{ background: 'rgba(0,0,0,.88)', cursor: 'zoom-out' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom.src} alt={zoom.label} className="max-w-[92vw] max-h-[80vh] object-contain rounded-lg" />
          <div className="text-[12px]" style={{ color: '#c8ccd4' }}>{zoom.label}</div>
          <a href={zoom.href} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}
             className="px-3 py-1.5 rounded-lg text-[12px]"
             style={{ background: 'rgba(255,255,255,.14)', color: '#fff', textDecoration: 'none' }}>
            출처 사이트 열기 ↗
          </a>
          <button onClick={(e) => { e.stopPropagation(); setZoom(null); }}
                  className="fixed top-5 right-6 w-10 h-10 rounded-full text-[20px] leading-none"
                  style={{ background: 'rgba(255,255,255,.14)', color: '#fff', border: 'none', cursor: 'pointer' }}
                  aria-label="닫기">✕</button>
        </div>
      )}
    </div>
  );
}
