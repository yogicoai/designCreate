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

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function TrendBoard() {
  const [configured, setConfigured] = useState(true);
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

      {/* ── 찾기 ── */}
      <div className="card p-4 mb-4">
        <div className="label mb-2">1. 찾기</div>
        <div className="flex gap-2 mb-2 flex-wrap">
          <input
            className="input flex-1" style={{ minWidth: 220 }}
            value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
            placeholder="예: 빈백 / 빈백소파 / 빈백 인테리어 — 빈백 관련 검색어를 넣으세요"
            disabled={!configured}
          />
          <button className="btn btn-primary" onClick={search} disabled={!configured || busy === 'search' || !q.trim()}>
            {busy === 'search' ? '찾는 중…' : '검색'}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button key={p} className="chip" onClick={() => setQ(p)} disabled={!configured}>{p}</button>
          ))}
        </div>
        {note && <div className="text-[11px] mt-2" style={{ color: 'var(--ok)' }}>{note}</div>}
        {err && <div className="text-[11px] mt-2" style={{ color: 'var(--danger)' }}>{err}</div>}
      </div>

      {/* ── 결과에서 고르기 ── */}
      {found.length > 0 && (
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

      {/* ── 월별 보드 ── */}
      <div className="flex items-center gap-1.5 mb-3 flex-wrap">
        <span className="label mr-1">월별</span>
        <button className="chip" onClick={() => setMonth('')}
                style={!month ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>전체</button>
        {months.map((m) => (
          <button key={m} className="chip" onClick={() => setMonth(m === month ? '' : m)}
                  style={month === m ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>{m}</button>
        ))}
      </div>

      {saved.length === 0 ? (
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
      )}
    </div>
  );
}
