'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';

/*
 * 접힘 상태는 브라우저 저장소에 산다 — React 밖의 값이라 useSyncExternalStore 로 읽는다.
 * useEffect 안에서 setState 로 불러오면 첫 화면을 펼친 채로 한 번 그린 뒤 다시 그려서
 * 사이드바가 눈에 띄게 깜빡인다. 하이드레이션 동안에는 서버가 그린 값(펼침)을 쓰고,
 * 끝난 뒤에 저장된 값으로 넘어간다.
 */
const NAV_KEY = 'nav-collapsed';
const navListeners = new Set<() => void>();
let navCollapsed = (() => {
  try { return typeof window !== 'undefined' && window.localStorage.getItem(NAV_KEY) === '1'; }
  catch { return false; }          // 저장소가 막힌 브라우저면 펼친 채로 쓴다
})();

function subscribeNav(fn: () => void) {
  navListeners.add(fn);
  return () => { navListeners.delete(fn); };
}
function setNavCollapsed(next: boolean) {
  navCollapsed = next;
  try { window.localStorage.setItem(NAV_KEY, next ? '1' : '0'); } catch { /* 무시 */ }
  navListeners.forEach((fn) => fn());
}

/**
 * 좌측 내비게이션.
 * 상단 = 생성 작업 흐름 / 하단 = 자산 관리. MD 는 위쪽만 쓰고, 관리자가 아래쪽을 쓴다.
 *
 * 반응형: 좁은 화면(<1024px)에서는 상단 바 + 슬라이드 드로어로 접힌다.
 * 태블릿 세로나 노트북 분할 화면에서 고정 212px 가 본문을 눌러버리기 때문.
 *
 * 넓은 화면에서도 접을 수 있다. 배너 디자인처럼 가로가 넓어야 하는 화면
 * (1920x600 배너를 통째로 보는 곳)에서 212px 가 아깝기 때문이다.
 */
const NAV = [
  {
    group: '이미지 생성',
    items: [
      { href: '/', label: '대시보드', icon: '◆' },
      { href: '/create', label: '이미지 생성', icon: '✦' },
      { href: '/cuts', label: '생성이미지 갤러리', icon: '▣' },
    ],
  },
  {
    // 컷을 만든 다음 글자를 얹는 일 — 만드는 화면과 쌓인 것을 관리하는 화면으로 나눈다
    group: '디자인',
    items: [
      { href: '/design', label: '배너 디자인 생성', icon: '✎' },
      { href: '/design/manage', label: '배너 디자인 관리', icon: '▤' },
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

/**
 * 지금 보고 있는 항목 하나를 고른다.
 * 앞부분만 맞으면 켜는 방식이면 /design/manage 에서 /design 까지 같이 켜진다.
 * 가장 길게 맞는 것 하나만 남긴다.
 */
function activeHrefFor(path: string): string {
  let best = '';
  for (const it of NAV.flatMap((g) => g.items)) {
    const hit = path === it.href || (it.href !== '/' && path.startsWith(`${it.href}/`));
    if (hit && it.href.length > best.length) best = it.href;
  }
  return best;
}

/** 접기 버튼 — 접힌 상태에서는 이게 유일한 단서라 항상 보여야 한다 */
function ToggleButton({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={collapsed ? '메뉴 펼치기' : '메뉴 접기'}
      aria-expanded={!collapsed}
      title={collapsed ? '메뉴 펼치기' : '메뉴 접기'}
      className="shrink-0 w-7 h-7 flex items-center justify-center text-[12px]"
      style={{
        background: 'var(--surface-2)', border: '1px solid var(--line)',
        color: 'var(--text-mute)', cursor: 'pointer', borderRadius: 'var(--radius)',
      }}
    >
      {collapsed ? '»' : '«'}
    </button>
  );
}

function NavBody({
  path, onNavigate, collapsed, onToggle,
}: {
  path: string;
  onNavigate?: () => void;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const narrow = !!collapsed;
  const activeHref = activeHrefFor(path);
  return (
    <>
      <div className={`pt-4 pb-4 ${narrow ? 'px-2' : 'px-4'}`}>
        <div className="flex items-center gap-2">
          {/*
            공식 로고는 짙은 회색 + 시안이라 다크 배경에서 묻힌다.
            로고 자체를 리컬러하면 브랜드 훼손이므로, 밝은 플레이트를 깔고 원본을 그대로 얹는다.
            접었을 때는 아예 감춘다 — 52px 에 욱여넣으면 글자가 뭉개져서 로고 구실을 못 한다.
          */}
          {!narrow && (
            <Link href="/" className="block flex-1 min-w-0" onClick={onNavigate}>
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
          )}
          {onToggle && (
            <div className={narrow ? 'w-full flex justify-center' : ''}>
              <ToggleButton collapsed={narrow} onClick={onToggle} />
            </div>
          )}
        </div>
      </div>

      <nav className={`flex-1 pb-4 overflow-y-auto overflow-x-hidden ${narrow ? 'px-1.5' : 'px-2.5'}`}>
        {NAV.map((g) => (
          <div key={g.group} className="mb-5">
            {/* 접히면 글자 제목 대신 가는 선으로 무리를 나눈다 */}
            {narrow
              ? <div className="mx-2 mb-1.5" style={{ borderTop: '1px solid var(--line)' }} />
              : <div className="label px-2.5 mb-1.5">{g.group}</div>}
            {g.items.map((it) => {
              const active = it.href === activeHref;
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  onClick={onNavigate}
                  title={it.label}
                  className={`flex items-center rounded-lg text-[13px] font-medium transition-colors ${
                    narrow ? 'justify-center px-0 py-2.5' : 'gap-2.5 px-2.5 py-2'
                  }`}
                  style={{
                    background: active ? 'var(--accent-soft)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text-dim)',
                  }}
                >
                  <span className={`text-center text-[11px] opacity-80 ${narrow ? 'text-[13px]' : 'w-4'}`}>{it.icon}</span>
                  {!narrow && it.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

    </>
  );
}

export default function Sidebar() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  // 접은 상태를 기억한다 — 화면을 옮길 때마다 다시 접는 건 번거롭다
  const collapsed = useSyncExternalStore(subscribeNav, () => navCollapsed, () => false);
  const toggleCollapsed = () => setNavCollapsed(!navCollapsed);

  // ESC 로 드로어 닫기. 라우트 변경 시 닫는 건 각 Link 의 onNavigate 가 담당한다
  // (effect 에서 setState 하면 렌더 중 상태 변경 경고가 난다)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const current = NAV.flatMap((g) => g.items).find((it) => it.href === activeHrefFor(path));

  return (
    <>
      {/* 데스크톱 — 고정 사이드바 (접을 수 있다) */}
      <aside
        className={`hidden lg:flex shrink-0 flex-col border-r transition-[width] duration-200 ${
          collapsed ? 'w-[56px]' : 'w-[212px]'
        }`}
        style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
      >
        <NavBody path={path} collapsed={collapsed} onToggle={toggleCollapsed} />
      </aside>

      {/* 모바일·태블릿 — 상단 바 */}
      <header
        className="lg:hidden fixed top-0 inset-x-0 z-40 h-12 flex items-center gap-3 px-3 border-b"
        style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
      >
        <button
          onClick={() => setOpen(true)}
          aria-label="메뉴 열기"
          className="w-9 h-9 flex items-center justify-center text-[15px]"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text-dim)', cursor: 'pointer', borderRadius: 'var(--radius)' }}
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
