'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 갤러리 컷 아래의 관리 버튼 — 숨김 / 삭제.
 * 삭제는 이 앱이 생성한 컷만 (이관 컷은 youtube 자산이라 숨김만).
 */
export default function CutActions({ id, source }: { id: string; source: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

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
    <div className="flex items-center gap-2 mt-0.5">
      {btn('숨김', hide, 'var(--text-mute)')}
      {source === 'imgcreate' && btn('삭제', remove, 'var(--danger)')}
    </div>
  );
}
