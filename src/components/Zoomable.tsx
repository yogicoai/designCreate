'use client';

import { useState, useEffect } from 'react';

/**
 * 클릭하면 전체화면으로 확대되는 이미지.
 * 시트(표정 8패널·턴어라운드 5패널)는 축소 상태로는 판별이 불가능해서 확대가 필수다.
 */
export default function Zoomable({
  src,
  alt,
  className,
  style,
  caption,
}: {
  src: string;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
  caption?: string;
}) {
  const [open, setOpen] = useState(false);

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

  return (
    <>
      {/* 외부 cafe24 호스트라 next/image 최적화 대신 img 사용 */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onClick={() => setOpen(true)}
        className={className}
        style={{ cursor: 'zoom-in', ...style }}
        title="클릭하면 크게 보기"
      />
      {open && (
        <div
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center p-6 gap-3"
          style={{ background: 'rgba(0,0,0,.88)', cursor: 'zoom-out' }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={alt} className="max-w-[96vw] max-h-[88vh] object-contain rounded-lg" />
          {caption && (
            <div className="text-[12px] text-center max-w-[70ch]" style={{ color: '#c8ccd4' }}>{caption}</div>
          )}
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
