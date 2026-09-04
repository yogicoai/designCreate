'use client';

import { useState, useEffect } from 'react';
import { thumbUrl } from '@/lib/thumb';

/**
 * 클릭하면 전체화면으로 확대되는 이미지.
 * 시트(표정 8패널·턴어라운드 5패널)는 축소 상태로는 판별이 불가능해서 확대가 필수다.
 *
 * 목록 표시는 저화질 썸네일(프록시 축소)로 부르고, 확대했을 때만 원본을 부른다 —
 * 원본이 장당 수 MB 라 목록에서 그대로 부르면 페이지가 기어간다 (사용자 확인).
 */
export default function Zoomable({
  src,
  alt,
  className,
  style,
  caption,
  action,
  thumbW = 256,
}: {
  src: string;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
  caption?: string;
  /** 팝업 안에 표시할 액션 버튼 (예: "이번 작업에 추가") — 누르면 실행 후 닫힌다 */
  action?: { label: string; onClick: () => void; disabled?: boolean };
  /** 목록 썸네일 폭 — 카드가 크면 384 로 */
  thumbW?: 128 | 256 | 384;
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
        src={thumbUrl(src, thumbW)}
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
            <div className="text-[12px] text-center max-w-[70ch] whitespace-pre-line" style={{ color: '#c8ccd4' }}>{caption}</div>
          )}
          {action && (
            <button
              onClick={(e) => { e.stopPropagation(); if (action.disabled) return; action.onClick(); setOpen(false); }}
              disabled={action.disabled}
              className="btn btn-primary"
              style={action.disabled ? { opacity: 0.5, cursor: 'default' } : {}}
            >
              {action.label}
            </button>
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
