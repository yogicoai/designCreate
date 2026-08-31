'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * 좌측 내비게이션.
 * 상단 = 생성 작업 흐름 / 하단 = 자산 관리. MD 는 위쪽만 쓰고, 관리자가 아래쪽을 쓴다.
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
      { href: '/rules', label: '생성 규칙', icon: '✓' },
    ],
  },
];

export default function Sidebar() {
  const path = usePathname();

  return (
    <aside
      className="w-[212px] shrink-0 flex flex-col border-r"
      style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
    >
      <div className="px-4 pt-4 pb-4">
        <Link href="/" className="block">
          {/*
            공식 로고는 짙은 회색 + 시안이라 다크 배경에서 묻힌다.
            로고 자체를 리컬러하면 브랜드 훼손이므로, 밝은 플레이트를 깔고 원본을 그대로 얹는다.
            외부 호스트(yogibo.kr)라 next/image 최적화 대신 img 를 쓴다.
          */}
          <div
            className="rounded-lg px-3 py-2.5 flex items-center justify-center"
            style={{ background: '#f4f5f7' }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://yogibo.kr/web/img/icon/logo3_on.png"
              alt="Yogibo"
              width={400}
              height={160}
              className="w-[92px] h-auto"
            />
          </div>
          <div className="text-[10.5px] mt-2 text-center" style={{ color: 'var(--text-mute)' }}>
            자사몰 이미지 생성
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

      <div className="px-5 py-3 border-t text-[10.5px] leading-relaxed" style={{ borderColor: 'var(--line)', color: 'var(--text-mute)' }}>
        나노바나나 · gemini-3-pro-image
        <br />
        2K · 약 ₩188/장
      </div>
    </aside>
  );
}
