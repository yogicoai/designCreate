import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // basic-ftp / sharp 는 CommonJS 네이티브 의존 — 번들링하면 Vercel 런타임에서 깨진다.
  serverExternalPackages: ['basic-ftp', 'sharp'],
  images: {
    // 모든 자산(제품 360뷰 · 모델 시트 · 포즈 레퍼 · 생성물)이 cafe24 호스팅.
    remotePatterns: [
      { protocol: 'https', hostname: 'yogibo.openhost.cafe24.com' },
      { protocol: 'https', hostname: 'yogibo.cafe24.com' },
    ],
  },
};

export default nextConfig;
