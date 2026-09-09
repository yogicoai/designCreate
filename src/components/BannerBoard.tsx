'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useMemo } from 'react';

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
  /** 웹+모바일을 한 번에 만든 짝의 묶음 표식 */
  pairId: string | null;
  /** 수정으로 만들어진 판이면 원본 id */
  revisedFrom: string | null;
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

  /*
   * 웹·모바일을 한 번에 저장한 것은 한 게시글로 묶는다 — 목록에 같은 배너가
   * 두 줄로 나오면 몇 개를 만들었는지 세기가 어렵다. 묶음 표식(pairId)이 기준이고,
   * 없으면 그 배너 하나가 곧 한 묶음이다. 가로가 긴 쪽(웹)을 대표로 앞에 둔다.
   */
  const groups = useMemo(() => {
    const byKey = new Map<string, BannerRow[]>();
    for (const r of rows) {
      const k = r.pairId ? `p:${r.pairId}` : `i:${r.id}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(r);
    }
    return [...byKey.entries()].map(([key, list]) => ({
      key,
      rows: [...list].sort((a, b) => (b.width - b.height) - (a.width - a.height)),
    }));
  }, [rows]);

  /** 묶음 통째로 지우기 — 한쪽만 남으면 웹·모바일 짝이 깨진다 */
  async function removeGroup(list: BannerRow[]) {
    const what = list.length > 1 ? `"${list[0].title}" 의 웹·모바일 ${list.length}장을` : `"${list[0].title}" 을(를)`;
    if (!window.confirm(`${what} 지울까요?
이미지 파일까지 완전히 지워집니다.`)) return;
    for (const r of list) await remove(r, true, true);
  }

  async function remove(row: BannerRow, force = false, skipConfirm = false) {
    if (!force && !skipConfirm && !window.confirm(`"${row.title}" 을(를) 지울까요?\n이미지 파일까지 완전히 지워집니다.`)) return;
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
        {groups.map((g) => {
          const head = g.rows[0];
          const busyHere = g.rows.some((r) => busy === r.id);
          return (
            <div key={g.key} className="card p-2.5 flex items-center gap-3 flex-wrap">
              {/* 미리보기 — 짝이면 웹·모바일을 나란히 */}
              <div className="flex gap-1.5 shrink-0">
                {g.rows.map((row) => (
                  <button key={row.id} onClick={() => setZoom(row)} title={`크게 보기 — ${row.width}×${row.height}`}
                          className="rounded-lg overflow-hidden border relative"
                          style={{ padding: 0, borderColor: 'var(--line)' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={row.url} alt={row.title} loading="lazy"
                         style={{
                           width: row.width >= row.height ? 148 : 78, height: 84,
                           objectFit: 'cover', display: 'block', background: 'var(--surface-2)',
                         }} />
                    {g.rows.length > 1 && (
                      <span className="absolute bottom-0 left-0 right-0 text-[9px] py-0.5 text-center"
                            style={{ background: 'rgba(0,0,0,.6)', color: '#fff' }}>
                        {row.width >= row.height ? '웹' : '모바일'}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              <div className="flex-1 min-w-[220px]">
                <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text)' }}>{head.title}</div>
                <div className="text-[11px] mt-0.5 tabular-nums flex items-center gap-1.5 flex-wrap"
                     style={{ color: 'var(--text-mute)' }}>
                  <span>
                    {head.sizeLabel} · {g.rows.map((r) => `${r.width}×${r.height}`).join(' + ')} · {when(head.createdAt)}
                  </span>
                  {g.rows.length > 1 && (
                    <span className="chip" style={{ padding: '1px 7px', fontSize: 10, color: 'var(--accent)' }}
                          title="웹·모바일을 한 번에 저장한 묶음입니다">
                      웹+모바일
                    </span>
                  )}
                  {head.revisedFrom && (
                    <span className="chip" style={{ padding: '1px 7px', fontSize: 10, color: 'var(--info)' }}
                          title="저장된 배너를 수정해서 만든 판입니다. 원본은 그대로 남아 있습니다.">
                      수정본
                    </span>
                  )}
                </div>
                {head.baseUrl && (
                  <div className="text-[10.5px] mt-0.5 truncate" style={{ color: 'var(--text-mute)' }}>
                    배경 컷: {head.baseUrl.split('/').pop()}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                {/* 수정 — 짝이어도 설계도는 규격마다 있으니 각각 연다 */}
                {g.rows.filter((r) => r.editable).map((r) => (
                  <Link key={r.id} href={`/design?load=${r.id}`} className="btn">
                    수정{g.rows.length > 1 ? ` (${r.width >= r.height ? '웹' : '모바일'})` : ''}
                  </Link>
                ))}
                {!g.rows.some((r) => r.editable) && (
                  <span className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}
                        title="설계도가 없어 다시 열 수 없습니다">수정 불가</span>
                )}
                {g.rows.map((r) => (
                  <a key={r.id} href={r.url} target="_blank" rel="noreferrer" className="btn">
                    원본{g.rows.length > 1 ? ` (${r.width >= r.height ? '웹' : '모바일'})` : ''}
                  </a>
                ))}
                {/* 삭제는 묶음 통째로 — 한쪽만 남으면 짝이 깨진다 */}
                <button className="btn" onClick={() => removeGroup(g.rows)} disabled={busyHere}
                        style={{ color: 'var(--danger)' }}>
                  {busyHere ? '지우는 중…' : '삭제'}
                </button>
              </div>
            </div>
          );
        })}
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
