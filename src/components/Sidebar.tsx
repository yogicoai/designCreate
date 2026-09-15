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
    // 영상은 시트(요청서)까지 앱에서 만들고 렌더는 오너가 힉스필드에서 돌린다.
    // 만드는 화면과 완성본이 쌓이는 화면으로 나눈다 — 디자인 무리와 같은 결.
    group: '영상 제작',
    items: [
      { href: '/video', label: '영상 스토리보드', icon: '🎬' },
      // 어떤 방식으로 만들지 — 실제로 두 방식을 돌려보고 정한 근거를 남겨둔 문서
      { href: '/video/proposal', label: '영상 스토리보드 제안', icon: '📄' },
      /*
       * 영상 제작물 — 완성 영상이 쌓이는 곳 (예전 "영상 갤러리").
       * 2026-09-09 에 메뉴에서 숨겼다가 2026-09-15 사용자 요청으로 이름을 바꿔 다시 연다
       * — 대화에서 힉스필드로 만든 영상을 여기 저장한다.
       */
      { href: '/video/gallery', label: '영상 제작물', icon: '▶' },
    ],
  },
  {
    group: '자산 관리',
    items: [
      { href: '/references', label: '레퍼런스', icon: '▦' },
      { href: '/products', label: '제품 · 컬러', icon: '▤' },
      // 제품 하나를 여러 각도로 한 장에 뽑아 잘라둔 형태 기준 — 공식 사진끼리 모양이 안 맞는 문제의 대책
      // badge — 새로 생긴 메뉴라는 표시 (사용자 요청 2026-09-14). 익숙해지면 이 값만 지우면 된다
      { href: '/ai-products', label: 'AI 생성 제품', icon: '◈', badge: 'N' },
      { href: '/talents', label: '전속 모델', icon: '☺' },
      { href: '/poses', label: '포즈 레퍼런스', icon: '▥' },
      { href: '/model-refs', label: '모델 레퍼런스 등록', icon: '☻' },
    ],
  },
  {
    // 자산을 재료로 콘텐츠를 양산하는 화면들 — 지금은 수동 실행, 확정되면 예약이 붙는다
    group: '자동화',
    items: [
      { href: '/automation/guide', label: 'SNS 자동화 설명서', icon: '📘' },
      { href: '/automation/sns', label: 'SNS 인물 자동화', icon: '⚡' },
      { href: '/automation/sns-product', label: 'SNS 제품 자동화', icon: '📦' },
      { href: '/automation/gallery', label: '자동화 생성이미지', icon: '▦' },
    ],
  },
  /*
   * 시장 조사 — 사용자 요청으로 일단 메뉴에서 숨김 (2026-09-03).
   * 화면(/trends)과 데이터는 그대로 살아 있어서 주소로는 들어가지고,
   * 다시 보이려면 아래 주석만 풀면 된다.
   */
  // {
  //   group: '시장 조사',
  //   items: [
  //     { href: '/trends', label: '빈백 트렌드', icon: '◷' },
  //   ],
  // },
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
  path, onNavigate, collapsed, onToggle, badges = {},
}: {
  path: string;
  onNavigate?: () => void;
  collapsed?: boolean;
  onToggle?: () => void;
  /** 메뉴 주소 → 배지 글자 — 하루 안에 새 데이터가 들어온 메뉴 (/api/nav-badges) */
  badges?: Record<string, string>;
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
              // 고정 배지(새 메뉴) 또는 서버가 알려준 "새 데이터" 배지
              const badge = ('badge' in it && it.badge) || badges[it.href] || '';
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  onClick={onNavigate}
                  title={it.label}
                  className={`relative flex items-center rounded-lg text-[13px] font-medium transition-colors ${
                    narrow ? 'justify-center px-0 py-2.5' : 'gap-2.5 px-2.5 py-2'
                  }`}
                  style={{
                    background: active ? 'var(--accent-soft)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text-dim)',
                  }}
                >
                  <span className={`text-center text-[11px] opacity-80 ${narrow ? 'text-[13px]' : 'w-4'}`}>{it.icon}</span>
                  {!narrow && it.label}
                  {!narrow && badge && (
                    <span className="ml-auto text-[9.5px] font-bold leading-none px-1.5 py-[3px] rounded-full"
                          style={{ background: 'var(--accent)', color: '#fff' }}>
                      {badge}
                    </span>
                  )}
                  {/* 접혔을 때는 아이콘 옆 작은 점으로만 */}
                  {narrow && badge && (
                    <span className="absolute w-[6px] h-[6px] rounded-full translate-x-[10px] -translate-y-[8px]"
                          style={{ background: 'var(--accent)' }} aria-label="새 항목" />
                  )}
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

  /*
   * 새 데이터 배지 — 모델 레퍼런스가 새로 등록되면 하루 동안 N (사용자 요청 2026-09-15).
   * 레이아웃은 화면을 옮겨도 다시 그려지지 않아서, 주소가 바뀔 때마다 다시 묻는다
   * (방금 등록하고 다른 화면으로 가면 바로 뜨고, 하루가 지나면 사라진다).
   */
  const [badges, setBadges] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    fetch('/api/nav-badges', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (alive && j?.badges) setBadges(j.badges); })
      .catch(() => { /* 배지는 부가 정보 — 실패해도 메뉴는 그대로 */ });
    return () => { alive = false; };
  }, [path]);

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
        <NavBody path={path} collapsed={collapsed} onToggle={toggleCollapsed} badges={badges} />
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
            <NavBody path={path} onNavigate={() => setOpen(false)} badges={badges} />
          </div>
          <div className="flex-1" onClick={() => setOpen(false)} style={{ background: 'rgba(0,0,0,.6)' }} />
        </div>
      )}
    </>
  );
}
