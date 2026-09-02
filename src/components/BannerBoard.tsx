'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * 배너 디자인 관리 게시판.
 *
 * 저장한 배너는 설계도(design)를 통째로 안고 있다. 그래서 목록에서 바로
 * 다시 열어 고칠 수 있다 — 새로 만드는 게 아니라 그때 그 배치 그대로 열린다.
 *
 * 삭제는 컷 갤러리와 같은 규칙을 쓴다: 완전 삭제는 FTP 파일까지 지우고,
 * 다른 컷의 배경으로 쓰였으면 막았다가 확인을 받고 지운다.
 */

export interface BannerRow {
  id: string;
  url: string;
  title: string;
  spec: string;
  width: number;
  height: number;
  sizeLabel: string;
  createdAt: string;
  /** 이 배너가 어떤 컷 위에 얹혔는지 */
  baseUrl: string | null;
  editable: boolean;
}

function when(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function BannerBoard({ rows }: { rows: BannerRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [zoom, setZoom] = useState<BannerRow | null>(null);

  async function remove(row: BannerRow, force = false) {
    if (!force && !window.confirm(`"${row.title}" 을(를) 지울까요?\n이미지 파일까지 완전히 지워집니다.`)) return;
    setBusy(row.id); setErr('');
    try {
      const r = await fetch('/api/cuts', {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: row.id, hard: true, force }),
      });
      const j = await r.json();
      if (r.status === 409) {
        // 다른 컷이 이 배너를 배경으로 쓰고 있다 — 지울지 한 번 더 묻는다
        const n = j.usedIn ?? '몇';
        if (window.confirm(`다른 컷 ${n}개가 이 이미지를 배경으로 쓰고 있습니다.\n그래도 지울까요?`)) {
          await remove(row, true);
        }
        return;
      }
      if (!j.ok) { setErr(j.error || '삭제 실패'); return; }
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  }

  if (rows.length === 0) {
    return (
      <div className="card p-6 text-center">
        <div className="text-[13px] mb-1" style={{ color: 'var(--text-dim)' }}>저장된 배너가 없습니다.</div>
        <div className="text-[11.5px] mb-3" style={{ color: 'var(--text-mute)' }}>
          배너 디자인 생성에서 <b>완성 · 갤러리에 저장</b> 을 누르면 여기에 쌓입니다.
        </div>
        <Link href="/design" className="btn btn-primary inline-block">배너 만들러 가기</Link>
      </div>
    );
  }

  return (
    <>
      {err && <div className="card p-2.5 mb-3 text-[11.5px]" style={{ color: 'var(--danger)' }}>{err}</div>}

      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <div key={row.id} className="card p-2.5 flex items-center gap-3">
            {/* 미리보기 — 배너는 가로로 길어서 목록에서도 넓게 보여야 알아본다 */}
            <button onClick={() => setZoom(row)} title="크게 보기"
                    className="shrink-0 rounded-lg overflow-hidden border" style={{ padding: 0, borderColor: 'var(--line)' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={row.url} alt={row.title} loading="lazy"
                   style={{ width: 148, height: 84, objectFit: 'cover', display: 'block', background: 'var(--surface-2)' }} />
            </button>

            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text)' }}>{row.title}</div>
              <div className="text-[11px] mt-0.5 tabular-nums" style={{ color: 'var(--text-mute)' }}>
                {row.sizeLabel} · {row.width}×{row.height} · {when(row.createdAt)}
              </div>
              {row.baseUrl && (
                <div className="text-[10.5px] mt-0.5 truncate" style={{ color: 'var(--text-mute)' }}>
                  배경 컷: {row.baseUrl.split('/').pop()}
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {row.editable
                ? <Link href={`/design?load=${row.id}`} className="btn">수정</Link>
                : <span className="text-[10.5px]" style={{ color: 'var(--text-mute)' }} title="설계도가 없어 다시 열 수 없습니다">
                    수정 불가
                  </span>}
              <a href={row.url} target="_blank" rel="noreferrer" className="btn">원본</a>
              <button className="btn" onClick={() => remove(row)} disabled={busy === row.id}
                      style={{ color: 'var(--danger)' }}>
                {busy === row.id ? '지우는 중…' : '삭제'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* 크게 보기 — 배너는 실제 비율로 봐야 판단이 된다 */}
      {zoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
             style={{ background: 'rgba(0,0,0,.75)' }} onClick={() => setZoom(null)}>
          <div className="max-w-[min(1200px,94vw)] max-h-[90vh] overflow-auto rounded-lg"
               onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={zoom.url} alt={zoom.title} className="block w-full h-auto" />
          </div>
        </div>
      )}
    </>
  );
}
