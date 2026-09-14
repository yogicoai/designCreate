'use client';

import { useMemo, useState } from 'react';
import { thumbUrl } from '@/lib/thumb';
import { KIND_LABEL, STATUS_LABEL, type AiProductSheet } from '@/lib/ai-products';

/**
 * AI 생성 제품 시트 목록.
 *
 * 제품 라인별로 묶어 보여준다. 카드 하나 = 힉스필드로 한 번 뽑은 시트 한 장.
 * 위에 원본 시트, 아래에 칸별로 자른 사진. 누르면 크게 본다 — 형태는 작게 보면 판단이 안 된다.
 */
export default function AiProductsManager({ initial }: { initial: AiProductSheet[] }) {
  const [sheets, setSheets] = useState(initial);
  const [zoom, setZoom] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const byLine = useMemo(() => {
    const m = new Map<string, AiProductSheet[]>();
    for (const s of sheets) {
      const k = s.line || '기타';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(s);
    }
    return [...m.entries()];
  }, [sheets]);

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
      {byLine.map(([line, list]) => (
        <section key={line} className="mb-8">
          <h2 className="h-section mb-3">{line} <span className="text-[12px] font-normal" style={{ color: 'var(--text-mute)' }}>· {list.length}장</span></h2>
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
                    <span className="text-[10.5px] px-1.5 py-0.5 rounded font-bold ml-auto"
                          style={{ background: approved ? 'var(--ok)' : 'var(--surface-2)', color: approved ? '#0b1a10' : 'var(--warn)' }}>
                      {STATUS_LABEL[s.status]}
                    </span>
                  </div>

                  {/* 시트 원본 — 칸이 전부 들어 있는 한 장 */}
                  {s.sheet && (
                    <button onClick={() => setZoom(s.sheet)} className="block w-full" style={{ padding: 0 }} title="크게 보기">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={thumbUrl(s.sheet, 384)} alt={`${s.line} 시트`} className="w-full rounded-lg border"
                           style={{ borderColor: approved ? 'var(--ok)' : 'var(--line)' }} />
                    </button>
                  )}

                  {/* 칸별로 자른 것 — flex 로 두면 원본 폭 아래로 안 줄어 카드를 넘친다 */}
                  {s.panels.length > 0 && (
                    <div className="grid gap-1.5 mt-2" style={{ gridTemplateColumns: `repeat(${Math.min(s.panels.length, 6)}, minmax(0, 1fr))` }}>
                      {s.panels.map((p) => (
                        <button key={p.url} onClick={() => setZoom(p.url)} className="min-w-0 block text-left" style={{ padding: 0 }}
                                title={`크게 보기 — ${p.label}`}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={thumbUrl(p.url, 256)} alt={p.label} loading="lazy"
                               className="w-full rounded border object-contain"
                               style={{ aspectRatio: '1/1', background: '#fff', borderColor: 'var(--line)' }} />
                          <div className="text-[10px] mt-0.5 truncate text-center" style={{ color: 'var(--text-dim)' }}>{p.label}</div>
                        </button>
                      ))}
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
