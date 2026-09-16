'use client';

import { useMemo, useState } from 'react';
import { thumbUrl } from '@/lib/thumb';
import { KIND_LABEL, STATUS_LABEL, isComboSheet, comboLabelKr, lineKr, type AiProductSheet } from '@/lib/ai-products';

const lineName = (l: string) => lineKr(l) || '기타';

/**
 * 상단 탭 — 빈 제품만 찍은 컷 / 앉은·눌린 컷 / 두 제품을 겹쳐 놓은 조합.
 * 조합을 따로 뺀 이유(사용자 지시 2026-09-16): 조합 시트는 칸마다 품질이 크게 달라
 * 어느 칸을 쓰고 어느 칸을 뺄지 사람이 직접 고르는 자리가 필요하다.
 */
type View = 'shape' | 'usage' | 'combo';
const TABS: { view: View; label: string }[] = [
  { view: 'shape', label: '제품컷' },
  { view: 'usage', label: '앉은컷' },
  { view: 'combo', label: '조합' },
];
/** 탭이 맡는 시트인지 — 조합은 kind 와 상관없이 조합 탭으로 모은다 */
const inView = (s: AiProductSheet, v: View) => (v === 'combo' ? isComboSheet(s) : !isComboSheet(s) && s.kind === v);

/**
 * AI 생성 제품 시트 목록.
 *
 * 상단 탭(제품컷 / 앉은컷) → 제품 칩으로 거르고 → 제품 라인별로 묶어 보여준다.
 * 카드 하나 = 힉스필드로 한 번 뽑은 시트 한 장.
 * 위에 원본 시트, 아래에 칸별로 자른 사진. 누르면 크게 본다 — 형태는 작게 보면 판단이 안 된다.
 */
export default function AiProductsManager({ initial }: { initial: AiProductSheet[] }) {
  const [sheets, setSheets] = useState(initial);
  const [zoom, setZoom] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<View>('shape');
  const [line, setLine] = useState('');   // '' = 전체

  const inTab = useMemo(() => sheets.filter((s) => inView(s, tab)), [sheets, tab]);

  // 탭 안에 있는 제품만 칩으로 — 없는 제품 칩을 누르면 빈 화면이 된다
  const lines = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of inTab) m.set(s.line, (m.get(s.line) ?? 0) + 1);
    return [...m.entries()];
  }, [inTab]);

  // 탭을 바꿨는데 고른 제품이 그 탭에 없으면 전체로 본다
  const activeLine = line && lines.some(([l]) => l === line) ? line : '';

  const byLine = useMemo(() => {
    const m = new Map<string, AiProductSheet[]>();
    for (const s of inTab) {
      if (activeLine && s.line !== activeLine) continue;
      const k = s.line || '기타';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(s);
    }
    return [...m.entries()];
  }, [inTab, activeLine]);

  async function setStatus(s: AiProductSheet, status: 'approved' | 'review') {
    setBusy(s.id); setErr('');
    try {
      const res = await fetch('/api/ai-products', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: s.id, status }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || '바꾸지 못했습니다.');
      setSheets((prev) => prev.map((x) => (x.id === s.id ? j.sheet : x)));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  /**
   * 칸 하나를 생성에 쓸지 말지 바꾼다.
   * 칸 배열을 통째로 보내지 않고 키 하나만 보낸다 — 서버가 현재 배열 위에 그 칸만 고친다.
   */
  async function togglePanel(s: AiProductSheet, key: string, off: boolean) {
    setBusy(s.id); setErr('');
    try {
      const res = await fetch('/api/ai-products', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: s.id, panel: { key, off } }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || '바꾸지 못했습니다.');
      setSheets((prev) => prev.map((x) => (x.id === s.id ? j.sheet : x)));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function remove(s: AiProductSheet) {
    if (!confirm(`${s.title || s.line} 시트를 목록에서 뺄까요?`)) return;
    setBusy(s.id); setErr('');
    try {
      const res = await fetch(`/api/ai-products?id=${s.id}`, { method: 'DELETE' });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || '빼지 못했습니다.');
      setSheets((prev) => prev.filter((x) => x.id !== s.id));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  if (!sheets.length) {
    return (
      <div className="card p-8 text-center text-[12.5px]" style={{ color: 'var(--text-mute)' }}>
        아직 등록된 시트가 없습니다 — 대화에서 힉스필드로 제품 한 장에 여러 각도를 뽑아 여기 넣습니다.
      </div>
    );
  }

  return (
    <div>
      {/* 상단 탭 */}
      <div className="flex gap-1 mb-3 border-b" style={{ borderColor: 'var(--line)' }}>
        {TABS.map((t) => {
          const on = tab === t.view;
          const n = sheets.filter((s) => inView(s, t.view)).length;
          return (
            <button key={t.view} onClick={() => setTab(t.view)}
                    className="px-4 py-2 text-[13px] font-bold -mb-px"
                    style={{
                      borderBottom: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
                      color: on ? 'var(--text)' : 'var(--text-mute)',
                    }}>
              {t.label} <span className="text-[11px] font-normal" style={{ color: 'var(--text-mute)' }}>{n}</span>
            </button>
          );
        })}
      </div>

      {/* 제품별 */}
      {lines.length > 0 && (
        <div className="flex gap-1.5 flex-wrap mb-5">
          {[['', inTab.length] as [string, number], ...lines].map(([l, n]) => {
            const on = activeLine === l;
            return (
              <button key={l || 'all'} onClick={() => setLine(l)}
                      className="px-3 py-1 rounded-full text-[12px] border"
                      style={{
                        background: on ? 'var(--accent)' : 'var(--surface-2)',
                        borderColor: on ? 'var(--accent)' : 'var(--line)',
                        color: on ? '#fff' : 'var(--text-dim)',
                      }}>
                {l ? lineName(l) : '전체'} {n}
              </button>
            );
          })}
        </div>
      )}

      {byLine.length === 0 && (
        <div className="card p-8 text-center text-[12.5px]" style={{ color: 'var(--text-mute)' }}>
          이 탭에는 아직 시트가 없습니다.
        </div>
      )}

      {byLine.map(([lk, list]) => (
        <section key={lk} className="mb-8">
          <h2 className="h-section mb-3">{lineName(lk)}<span className="text-[12px] font-normal" style={{ color: 'var(--text-mute)' }}>· {list.length}장</span></h2>
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 520px), 1fr))' }}>
            {list.map((s) => {
              const approved = s.status === 'approved';
              return (
                <div key={s.id} className="card p-3.5" style={{ opacity: busy === s.id ? 0.6 : 1 }}>
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    {s.hex && <span className="w-3.5 h-3.5 rounded-full shrink-0" style={{ background: s.hex, border: '1px solid rgba(0,0,0,.15)' }} />}
                    <div className="text-[13px] font-bold min-w-0 truncate">{s.title || `${s.line} ${s.colorName}`}</div>
                    <span className="text-[10.5px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface-2)', color: 'var(--text-dim)' }}>
                      {KIND_LABEL[s.kind]}
                    </span>
                    {isComboSheet(s) && (
                      <span className="text-[10.5px] px-1.5 py-0.5 rounded font-bold"
                            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                        🧩 {comboLabelKr(s.comboLines ?? [])}
                      </span>
                    )}
                    <span className="text-[10.5px] px-1.5 py-0.5 rounded font-bold ml-auto"
                          style={{ background: approved ? 'var(--ok)' : 'var(--surface-2)', color: approved ? '#0b1a10' : 'var(--warn)' }}>
                      {STATUS_LABEL[s.status]}
                    </span>
                  </div>

                  {/*
                    * 시트 원본 — 칸이 전부 들어 있는 한 장.
                    * 썸네일(최대 384px)을 쓰면 카드 폭(500~900px)으로 늘어나 흐려진다.
                    * 형태를 눈으로 판단하는 화면이라 원본을 그대로 띄운다 — 카드 수가 적어 부담이 없다.
                    */}
                  {s.sheet && (
                    <button onClick={() => setZoom(s.sheet)} className="block w-full" style={{ padding: 0 }} title="크게 보기">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={s.sheet} alt={`${s.line} 시트`} loading="lazy" decoding="async"
                           className="w-full rounded-lg border"
                           style={{ borderColor: approved ? 'var(--ok)' : 'var(--line)' }} />
                    </button>
                  )}

                  {/* 칸별로 자른 것 — flex 로 두면 원본 폭 아래로 안 줄어 카드를 넘친다 */}
                  {s.panels.length > 0 && (
                    <div className="grid gap-1.5 mt-2" style={{ gridTemplateColumns: `repeat(${Math.min(s.panels.length, 6)}, minmax(0, 1fr))` }}>
                      {s.panels.map((p) => {
                        const off = !!p.off;
                        return (
                          <div key={p.url} className="min-w-0">
                            <button onClick={() => setZoom(p.url)} className="min-w-0 block text-left w-full" style={{ padding: 0 }}
                                    title={`크게 보기 — ${p.label}`}>
                              {/* 4칸 시트는 칸당 200px 넘게 커진다 — 256 이면 고해상도 화면에서 흐리다 */}
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={thumbUrl(p.url, 384)} alt={p.label} loading="lazy"
                                   className="w-full rounded border object-contain"
                                   style={{
                                     aspectRatio: '1/1', background: '#fff',
                                     borderColor: off ? 'var(--line)' : 'var(--ok)',
                                     opacity: off ? 0.32 : 1,
                                     filter: off ? 'grayscale(1)' : 'none',
                                   }} />
                              <div className="text-[10px] mt-0.5 truncate text-center" style={{ color: off ? 'var(--text-mute)' : 'var(--text-dim)' }}>{p.label}</div>
                            </button>
                            {/* 이 칸을 생성에 넣을지 — 끈 칸은 참조로도, 배치 각도 후보로도 안 들어간다 */}
                            <button onClick={() => togglePanel(s, p.key, !off)} disabled={busy === s.id}
                                    className="w-full mt-0.5 rounded text-[10px] py-0.5 border"
                                    title={off ? '생성에 다시 쓰기' : '생성에서 빼기'}
                                    style={{
                                      borderColor: off ? 'var(--line)' : 'var(--ok)',
                                      color: off ? 'var(--text-mute)' : 'var(--ok)',
                                      background: 'transparent',
                                    }}>
                              {off ? '제외됨' : '사용중'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {s.check && (
                    <div className="text-[11px] mt-2 leading-relaxed whitespace-pre-line" style={{ color: 'var(--text-dim)' }}>
                      {s.check}
                    </div>
                  )}

                  <div className="flex items-center gap-2 mt-2.5 flex-wrap">
                    {approved ? (
                      <button className="btn text-[11px]" disabled={busy === s.id} onClick={() => setStatus(s, 'review')}>검증중으로 되돌리기</button>
                    ) : (
                      <button className="btn btn-primary text-[11px]" disabled={busy === s.id} onClick={() => setStatus(s, 'approved')}>형태 기준으로 승인</button>
                    )}
                    <a href={s.sheet} target="_blank" rel="noreferrer" className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>원본 보기</a>
                    <button className="text-[10.5px] ml-auto" style={{ color: 'var(--danger)' }} disabled={busy === s.id} onClick={() => remove(s)}>빼기</button>
                  </div>
                  <div className="text-[10px] mt-1.5" style={{ color: 'var(--text-mute)' }}>
                    {[s.model, s.credits ? `${s.credits}크레딧` : '', s.createdAt ? s.createdAt.slice(0, 10) : ''].filter(Boolean).join(' · ')}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {err && <div className="text-[11.5px] mt-3" style={{ color: 'var(--danger)' }}>{err}</div>}

      {zoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
             style={{ background: 'rgba(0,0,0,.82)' }} onClick={() => setZoom('')}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom} alt="크게 보기" onClick={(e) => e.stopPropagation()}
               style={{ maxWidth: '96vw', maxHeight: '92vh', objectFit: 'contain', borderRadius: 10, background: '#fff' }} />
          <button onClick={() => setZoom('')} className="absolute top-3 right-4 text-[22px]"
                  style={{ color: '#fff' }} aria-label="닫기">×</button>
        </div>
      )}
    </div>
  );
}
