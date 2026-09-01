import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import Sidebar from '@/components/Sidebar';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'imgCreate — 자사몰 이미지 생성',
  description: '전속 모델 · 제품 · 레퍼런스를 조합해 나노바나나로 자사몰 이미지를 생성한다',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="ko" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex">
        <Sidebar />
        {/* 모바일에서는 상단 고정 바(h-12) 아래로 본문을 내린다 */}
        <main className="flex-1 min-w-0 overflow-x-hidden pt-12 lg:pt-0">{children}</main>
      </body>
    </html>
  );
}
