'use client';

import { useState } from 'react';
import type { SeriesResult, SeriesTile } from '@/lib/series-check';

/**
 * 시리즈 일관성 — 같은 전속 모델의 최근 컷에서 얼굴만 잘라 나란히 놓는다 (점검 2026-10-02 8번, 로컬 전용 화면).
 *
 * 얼굴 검사는 컷마다 시트와 대조할 뿐, 컷끼리는 안 본다. 상품 페이지에는 이 얼굴들이 나란히 걸리므로
 * 사람이 한눈에 보는 게 가장 정확하다 — 그래서 먼저 보여 주고, 「서로 대조」 를 누르면 비전이 튀는 컷을 짚는다(가벼운 호출 1회).
 */

export interface SeriesRow {
  code: string;
  tiles: SeriesTile[];
  last: SeriesResult | null;
}

const VERDICT_KR: Record<string, string> = { ok: '시트와 일치', weak: '애매', drift: '시트와 어긋남' };

export default function SeriesStrips({ rows }: { rows: SeriesRow[] }) {
  const [results, setResults] = useState<Record<string, SeriesResult | null>>(() => Object.fromEntries(rows.map((r) => [r.code, r.last])));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');

  async function run(code: string) {
    setBusy(code); setErr('');
    try {
      const res = await fetch('/api/qc/series', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ talent: code }) });
      const json = await res.json();
      if (json.ok) setResults((cur) => ({ ...cur, [code]: json.result }));
      else setErr(`${code}: ${json.error || '실패'}`);
    } catch (e) {
      setErr(`${code}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  if (!rows.length) {
    return <div className="text-[12px]" style={{ color: 'var(--text-mute)' }}>얼굴 위치가 기록된 컷이 2장 이상인 모델이 아직 없습니다.</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      {err && <div className="text-[11.5px]" style={{ color: 'var(--danger)' }}>{err}</div>}
      {rows.map((row) => {
        const r = results[row.code];
        // 저장된 판정이 지금 보이는 컷 묶음과 같을 때만 표시한다 — 컷이 바뀌었으면 다시 물어야 한다
        const fresh = !!r && r.cutIds.join(',') === row.tiles.map((t) => t.id).join(',');
        const out = new Set(fresh ? r!.outliers : []);
        return (
          <div key={row.code} className="flex gap-3 items-start flex-wrap">
            <div className="w-[64px] shrink-0 pt-1">
              <div className="text-[12.5px] font-bold">{row.code}</div>
              <div className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>{row.tiles.length}컷</div>
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {row.tiles.map((t) => (
                <a key={t.id} href={t.url} target="_blank" rel="noreferrer"
                   title={`${t.createdAt.slice(0, 10)} · ${VERDICT_KR[t.verdict] ?? t.verdict}${out.has(t.id) ? ' · 다른 컷들과 다른 사람으로 보임' : ''}`}
                   className="block rounded-lg overflow-hidden"
                   style={{
                     width: 84, height: 84,
                     outline: out.has(t.id) ? '3px solid var(--danger)' : t.verdict === 'drift' ? '2px solid var(--warn)' : '1px solid var(--border)',
                     outlineOffset: -1,
                   }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/qc/head?id=${t.id}&code=${encodeURIComponent(row.code)}`} alt="" width={84} height={84} loading="lazy"
                       style={{ width: 84, height: 84, objectFit: 'cover', display: 'block' }} />
                </a>
              ))}
            </div>
            <div className="min-w-[180px] flex-1 pt-1">
              <button className="chip" onClick={() => run(row.code)} disabled={busy !== null}>
                {busy === row.code ? '대조 중…' : fresh ? '다시 대조' : '서로 대조'}
              </button>
              {fresh && (
                <div className="text-[11px] mt-1.5 leading-relaxed" style={{ color: out.size ? 'var(--danger)' : 'var(--ok)' }}>
                  {out.size ? `${out.size}컷이 다른 사람으로 보입니다 — ${r!.note}` : `한 사람으로 보입니다${r!.note && r!.note !== 'consistent' ? ` — ${r!.note}` : ''}`}
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>
        노란 테두리 = 시트와 어긋남(컷별 검사) · 빨간 테두리 = 다른 컷들과 다른 사람으로 보임(서로 대조). 누르면 원본 컷.
      </div>
    </div>
  );
}
