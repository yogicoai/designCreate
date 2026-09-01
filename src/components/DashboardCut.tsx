'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 대시보드 '최근 생성 컷' 한 장.
 *
 * 클릭하면 갤러리로 이동하지 않고 그 자리에서 크게 보인다 — 방금 뽑은 걸 확인하러
 * 온 것이지 갤러리를 뒤지러 온 게 아니기 때문. 그래서 확인하다 이상하면
 * 팝업 안에서 바로 지울 수 있어야 흐름이 끊기지 않는다.
 *
 * 숨김 = 목록에서만 제외 (파일·기록 유지) / 삭제 = FTP 파일까지 제거.
 * 삭제는 이 앱이 생성한 컷만 — 이관 컷은 youtube 자산이라 숨김만 된다.
 */
export default function DashboardCut({
  id,
  url,
  label,
  sub,
  caption,
  source,
  refs = [],
}: {
  id: string;
  url: string;
  label: string;
  sub: string;
  caption: string;
  source: string;
  /** 이 컷을 만들 때 들어간 참조 — 팝업에서 작게 함께 보여준다 */
  refs?: { kind: string; title: string; url: string; swatchHex?: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  async function call(payload: Record<string, unknown>) {
    const res = await fetch('/api/cuts', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, ...payload }),
    });
    return res.json();
  }

  async function act(hard: boolean) {
    const msg = hard
      ? '완전히 삭제할까요? FTP 파일까지 지워지며 되돌릴 수 없습니다.'
      : '이 컷을 목록에서 숨길까요? (파일과 기록은 유지)';
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      let r = await call(hard ? { hard: true } : {});
      // 다른 컷의 베이스로 쓰였으면 409 — 알고도 지우겠다면 force
      if (!r.ok && r.needsForce) {
        if (!window.confirm(`${r.error}\n\n그래도 삭제할까요?`)) return;
        r = await call({ hard: true, force: true });
      }
      if (!r.ok) { window.alert(r.error || '실패'); return; }
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const popBtn = (text: string, onClick: () => void, color: string) => (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={busy}
      className="px-3 py-1.5 rounded-lg text-[12px] font-medium"
      style={{
        background: 'rgba(255,255,255,.12)',
        color,
        border: 'none',
        cursor: busy ? 'default' : 'pointer',
        opacity: busy ? 0.5 : 1,
      }}
    >
      {text}
    </button>
  );

  return (
    <>
      <div>
        {/* 외부 cafe24 호스트라 next/image 최적화 대신 img 를 쓴다 (URL 이 이미 최적 크기) */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={label}
          loading="lazy"
          onClick={() => setOpen(true)}
          title="클릭하면 크게 보기"
          className="w-full aspect-square object-cover rounded-lg border transition-colors"
          style={{ borderColor: 'var(--accent-dim)', background: 'var(--surface-2)', cursor: 'zoom-in' }}
        />
        <div className="mt-1.5 text-[11px] truncate" style={{ color: 'var(--text-dim)' }}>{label}</div>
        <div className="text-[9.5px]" style={{ color: 'var(--text-mute)' }}>{sub}</div>
      </div>

      {open && (
        <div
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center p-6 gap-3"
          style={{ background: 'rgba(0,0,0,.88)', cursor: 'zoom-out' }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={label} className="max-w-[96vw] max-h-[78vh] object-contain rounded-lg" />
          <div className="text-[12px] text-center max-w-[70ch] whitespace-pre-line" style={{ color: '#c8ccd4' }}>
            {caption}
          </div>
          {/* 무엇을 보고 만들었는지 — 결과 옆에 입력이 있어야 재현할 수 있다 */}
          {refs.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap justify-center max-w-[80vw]"
                 onClick={(e) => e.stopPropagation()}>
              <span className="text-[10px] mr-1" style={{ color: '#8b909a' }}>참조</span>
              {refs.slice(0, 10).map((r, i) =>
                r.url ? (
                  <a key={`${r.url}#${i}`} href={r.url} target="_blank" rel="noreferrer noopener" title={r.title}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={r.url} alt={r.title} loading="lazy" className="rounded border object-cover"
                         style={{ width: 34, height: 34, borderColor: 'rgba(255,255,255,.2)' }} />
                  </a>
                ) : (
                  <span key={`sw#${i}`} title={r.title} className="rounded border"
                        style={{ width: 34, height: 34, display: 'inline-block',
                                 background: r.swatchHex || '#333', borderColor: 'rgba(255,255,255,.2)' }} />
                ),
              )}
            </div>
          )}
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {popBtn('숨김', () => act(false), '#c8ccd4')}
            {source === 'imgcreate' && popBtn('삭제', () => act(true), '#ff8080')}
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); }}
            className="fixed top-5 right-6 w-10 h-10 rounded-full text-[20px] leading-none"
            style={{ background: 'rgba(255,255,255,.14)', color: '#fff', border: 'none', cursor: 'pointer' }}
            aria-label="닫기"
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}
