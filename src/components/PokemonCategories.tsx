'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * 포켓몬 첫 화면 — 카테고리(작업 묶음) 목록과 새 카테고리 만들기.
 * 카드를 누르면 그 카테고리(레퍼런스 등록 + 결과물)로 간다. 사이드바 '포켓몬' 아래에도 같은 목록이 붙는다.
 */

export interface CategorySummary {
  slug: string;
  name: string;
  brief?: string;
  createdAt: string;
  references: number;
  results: number;
  preview: string[];
}

const CHECK = { background: 'repeating-conic-gradient(#2a2e36 0% 25%, #353a45 0% 50%) 50% / 14px 14px' };

export default function PokemonCategories({ initial }: { initial: CategorySummary[] }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr('');
    const j = await fetch('/api/pokemon/categories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    }).then((r) => r.json()).catch(() => null);
    setBusy(false);
    if (!j?.ok) { setErr(j?.error || '만들지 못했습니다'); return; }
    router.push(`/automation/pokemon/${j.category.slug}`);
  }

  return (
    <div>
      {initial.length === 0 ? (
        <div className="card p-6 text-center text-[12px] mb-5" style={{ color: 'var(--text-mute)' }}>
          아직 카테고리가 없습니다. 아래에서 첫 카테고리를 만드세요.
        </div>
      ) : (
        <div className="grid gap-3.5 mb-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {initial.map((c) => (
            <Link key={c.slug} href={`/automation/pokemon/${c.slug}`} className="card p-3 block transition-colors hover:border-[var(--accent)]">
              <div className="grid grid-cols-4 gap-1.5">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="rounded-md overflow-hidden" style={{ ...CHECK, aspectRatio: '1 / 1' }}>
                    {c.preview[i] && (
                      // 로컬 API 가 주는 파일이라 next/image 최적화 대상이 아니다
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/pokemon/${c.preview[i]}?thumb=1`} alt="" className="w-full h-full object-contain" />
                    )}
                  </div>
                ))}
              </div>
              <div className="text-[14px] font-bold mt-2.5">📁 {c.name}</div>
              <div className="text-[11.5px] mt-0.5 tabular-nums" style={{ color: 'var(--text-mute)' }}>
                올린 이미지 {c.references} · 결과물 {c.results}
              </div>
              {c.brief && (
                <div className="text-[11px] mt-1.5 leading-relaxed line-clamp-2 whitespace-pre-line" style={{ color: 'var(--text-dim)' }}>
                  {c.brief}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}

      <div className="card p-3.5 max-w-[560px]">
        <div className="label mb-1.5">새 카테고리</div>
        <div className="flex gap-2">
          <input className="input flex-1" value={name} placeholder="예: 2차 스티커 제작"
                 onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
          <button type="button" className="btn btn-primary" onClick={create} disabled={busy || !name.trim()}>
            {busy ? '만드는 중…' : '만들기'}
          </button>
        </div>
        {err && <div className="text-[11.5px] mt-2" style={{ color: 'var(--danger)' }}>{err}</div>}
      </div>
    </div>
  );
}
