'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * 좌측 내비게이션.
 * 상단 = 생성 작업 흐름 / 하단 = 자산 관리. MD 는 위쪽만 쓰고, 관리자가 아래쪽을 쓴다.
 *
 * 반응형: 좁은 화면(<1024px)에서는 상단 바 + 슬라이드 드로어로 접힌다.
 * 태블릿 세로나 노트북 분할 화면에서 고정 212px 가 본문을 눌러버리기 때문.
 */
const NAV = [
  {
    group: '생성',
    items: [
      { href: '/', label: '대시보드', icon: '◆' },
      { href: '/create', label: '이미지 생성', icon: '✦' },
      { href: '/cuts', label: '컷 갤러리', icon: '▣' },
    ],
  },
  {
    group: '자산 관리',
    items: [
      { href: '/references', label: '레퍼런스', icon: '▦' },
      { href: '/products', label: '제품 · 컬러', icon: '▤' },
      { href: '/talents', label: '전속 모델', icon: '☺' },
      { href: '/poses', label: '포즈 레퍼런스', icon: '▥' },
    ],
  },
  {
    // 자산이 아니라 시장을 보는 화면 — 우리가 만드는 것이 아니라 남들이 하는 것을 본다.
    // 생성에 쓰이지 않으므로 자산 관리와 섞지 않는다.
    group: '시장 조사',
    items: [
      { href: '/trends', label: '빈백 트렌드', icon: '◷' },
    ],
  },
];

function NavBody({ path, onNavigate }: { path: string; onNavigate?: () => void }) {
  return (
    <>
      <div className="px-4 pt-4 pb-4">
        <Link href="/" className="block" onClick={onNavigate}>
          {/*
            공식 로고는 짙은 회색 + 시안이라 다크 배경에서 묻힌다.
            로고 자체를 리컬러하면 브랜드 훼손이므로, 밝은 플레이트를 깔고 원본을 그대로 얹는다.
          */}
          <div className="rounded-lg px-3 py-2.5 flex items-center justify-center" style={{ background: '#f4f5f7' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://yogibo.kr/web/img/icon/logo3_on.png"
              alt="Yogibo"
              width={400}
              height={160}
              className="w-[92px] h-auto"
            />
          </div>
        </Link>
      </div>

      <nav className="flex-1 px-2.5 pb-4 overflow-y-auto">
        {NAV.map((g) => (
          <div key={g.group} className="mb-5">
            <div className="label px-2.5 mb-1.5">{g.group}</div>
            {g.items.map((it) => {
              const active = path === it.href || (it.href !== '/' && path.startsWith(it.href));
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  onClick={onNavigate}
                  className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] font-medium transition-colors"
                  style={{
                    background: active ? 'var(--accent-soft)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text-dim)',
                  }}
                >
                  <span className="w-4 text-center text-[11px] opacity-80">{it.icon}</span>
                  {it.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div
        className="px-5 py-3 border-t text-[10.5px] leading-relaxed"
        style={{ borderColor: 'var(--line)', color: 'var(--text-mute)' }}
      >
        나노바나나 · gemini-3-pro-image
        <br />
        2K · 약 ₩230~310/장
      </div>
    </>
  );
}

export default function Sidebar() {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  // ESC 로 드로어 닫기. 라우트 변경 시 닫는 건 각 Link 의 onNavigate 가 담당한다
  // (effect 에서 setState 하면 렌더 중 상태 변경 경고가 난다)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const current = NAV.flatMap((g) => g.items).find(
    (it) => path === it.href || (it.href !== '/' && path.startsWith(it.href)),
  );

  return (
    <>
      {/* 데스크톱 — 고정 사이드바 */}
      <aside
        className="hidden lg:flex w-[212px] shrink-0 flex-col border-r"
        style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
      >
        <NavBody path={path} />
      </aside>

      {/* 모바일·태블릿 — 상단 바 */}
      <header
        className="lg:hidden fixed top-0 inset-x-0 z-40 h-12 flex items-center gap-3 px-3 border-b"
        style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
      >
        <button
          onClick={() => setOpen(true)}
          aria-label="메뉴 열기"
          className="w-9 h-9 rounded-lg flex items-center justify-center text-[15px]"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text-dim)', cursor: 'pointer' }}
        >
          ☰
        </button>
        <div className="rounded px-2 py-1" style={{ background: '#f4f5f7' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="https://yogibo.kr/web/img/icon/logo3_on.png" alt="Yogibo" width={400} height={160} className="w-[54px] h-auto" />
        </div>
        <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-dim)' }}>
          {current?.label ?? ''}
        </span>
      </header>

      {/* 드로어 */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div
            className="flex flex-col w-[248px] max-w-[82vw] border-r"
            style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
          >
            <NavBody path={path} onNavigate={() => setOpen(false)} />
          </div>
          <div className="flex-1" onClick={() => setOpen(false)} style={{ background: 'rgba(0,0,0,.6)' }} />
        </div>
      )}
    </>
  );
}
