'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 갤러리 컷 아래의 관리 버튼 — 내려받기 / 숨김 / 삭제.
 * 삭제는 이 앱이 생성한 컷만 (이관 컷은 youtube 자산이라 숨김만).
 *
 * 내려받기는 형식을 골라서 받는다: 웹 게시는 webp(가장 작다), 편집·인쇄 전달은 png,
 * 그대로면 jpg. 크기·화질은 안 건드린다 — 인쇄용(A1·A3)이 줄어들면 안 된다.
 */
export default function CutActions(
  { id, source, url, title }: { id: string; source: string; url?: string; title?: string },
) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  /** 내려받기 형식 고르기 열림 */
  const [open, setOpen] = useState(false);

  async function call(payload: Record<string, unknown>) {
    const res = await fetch('/api/cuts', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, ...payload }),
    });
    return res.json();
  }

  async function hide() {
    if (!window.confirm('이 컷을 갤러리에서 숨길까요? (파일과 기록은 유지)')) return;
    setBusy(true);
    try {
      const r = await call({});
      if (r.ok) router.refresh();
      else window.alert(r.error || '실패');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('완전히 삭제할까요? FTP 파일까지 지워지며 되돌릴 수 없습니다.')) return;
    setBusy(true);
    try {
      let r = await call({ hard: true });
      if (!r.ok && r.needsForce) {
        if (!window.confirm(`${r.error}\n\n그래도 삭제할까요?`)) return;
        r = await call({ hard: true, force: true });
      }
      if (r.ok) router.refresh();
      else window.alert(r.error || '실패');
    } finally {
      setBusy(false);
    }
  }

  /** 형식만 바꿔 내려받기 — 링크를 만들어 눌러야 파일로 저장된다 */
  function download(format: 'jpg' | 'webp' | 'png') {
    if (!url) return;
    const q = new URLSearchParams({ url, format, name: (title || 'yogibo').slice(0, 60) });
    const a = document.createElement('a');
    a.href = `/api/download?${q.toString()}`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setOpen(false);
  }

  const btn = (label: string, onClick: () => void, color: string) => (
    <button
      onClick={onClick}
      disabled={busy}
      className="text-[9.5px]"
      style={{ color, background: 'none', border: 'none', cursor: busy ? 'default' : 'pointer', padding: 0, opacity: busy ? 0.5 : 1 }}
    >
      {label}
    </button>
  );

  return (
    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
      {url && btn(open ? '닫기' : '↓ 저장', () => setOpen((c) => !c), 'var(--accent)')}
      {btn('숨김', hide, 'var(--text-mute)')}
      {source === 'imgcreate' && btn('삭제', remove, 'var(--danger)')}
      {open && url && (
        <div className="flex items-center gap-1.5 w-full mt-0.5">
          {(['jpg', 'webp', 'png'] as const).map((f) => (
            <button key={f} onClick={() => download(f)} className="text-[9.5px]"
                    title={f === 'webp' ? '웹 게시용 — 가장 작습니다'
                      : f === 'png' ? '편집·인쇄 전달용 — 손실 없음' : '저장된 그대로'}
                    style={{
                      color: 'var(--text-dim)', background: 'var(--surface-2)',
                      border: '1px solid var(--line)', borderRadius: 6, padding: '1px 6px', cursor: 'pointer',
                    }}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
