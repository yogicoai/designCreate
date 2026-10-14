'use client';

/**
 * PhotoCraft 창 — 오픈소스 포토샵 대체(PhotoCraft 웹 버전)를 전체 화면으로 띄운다.
 *
 * 포토샵 방식 편집기는 글자·도형을 얹는 도구라, 사진 자체를 고치는 일(지우기·보정·합성)은 못 한다.
 * 그 일을 PhotoCraft 에 맡긴다: 지금 배너를 그림으로 넘기고, 거기서 저장(Ctrl+S)하면 고친 그림이 돌아온다.
 * 주고받는 방법은 src/lib/photocraft-bridge.ts.
 *
 * PhotoCraft 는 아직 초기 알파다 — 메뉴는 영어이고(웹 버전에 한글 글꼴이 없다), 자동 저장이 없어
 * 창을 닫으면 작업이 사라진다. 그래서 닫을 때 한 번 묻는다.
 * 글자 도구의 기본 글꼴(Inter)은 한글이 □ 로 나온다 — public/photocraft/fonts 에 곁들인
 * Pretendard Variable 을 고르면 한글이 보인다(2026-10-13 확인).
 */

import { useEffect, useRef, useState } from 'react';
import {
  PHOTOCRAFT_URL, captureDownloads, dropFile, toBannerJpeg, waitForApp, type Captured,
} from '@/lib/photocraft-bridge';

interface Props {
  /** PhotoCraft 에 넘길 그림 (지금 배너) */
  image: Blob;
  /** 돌려받을 크기 — 배너 규격. 다르게 저장해 와도 이 크기로 맞춘다 */
  size: { w: number; h: number };
  /** 무엇을 넘겼는지 — 안내 문구에 쓴다 */
  what: string;
  /** 저장한 그림이 돌아왔을 때. 실패하면 던진다(창은 그대로 둔다) */
  onResult: (jpeg: Blob) => Promise<void>;
  onClose: () => void;
}

type Stage = 'loading' | 'ready' | 'returning' | 'failed';

export default function PhotoCraftModal(p: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [stage, setStage] = useState<Stage>('loading');
  const [err, setErr] = useState('');
  // 최신 props 를 이벤트 콜백에서 읽기 위한 통로 — iframe 연결은 한 번만 한다
  const latest = useRef(p);
  useEffect(() => { latest.current = p; });
  const busy = useRef(false);
  const release = useRef<(() => void) | null>(null);
  useEffect(() => () => release.current?.(), []);

  async function onFile(f: Captured) {
    if (busy.current) return;
    busy.current = true;
    setStage('returning'); setErr('');
    try {
      const jpeg = await toBannerJpeg(f, latest.current.size);
      await latest.current.onResult(jpeg);
    } catch (e) {
      setErr((e as Error).message);
      setStage('ready');
    } finally {
      busy.current = false;
    }
  }

  async function onLoad() {
    const frame = frameRef.current;
    if (!frame || release.current) return;
    release.current = captureDownloads(frame, (f) => { void onFile(f); });
    if (!(await waitForApp(frame))) {
      setStage('failed');
      setErr('PhotoCraft 가 뜨지 않았습니다 — 새로 고친 뒤 다시 열어 주세요.');
      return;
    }
    // 앱이 첫 화면을 그릴 틈을 준 뒤 그림을 넣는다
    await new Promise((r) => setTimeout(r, 600));
    if (!dropFile(frame, latest.current.image, 'banner.jpg')) {
      setStage('failed');
      setErr('그림을 넘기지 못했습니다.');
      return;
    }
    setStage('ready');
    frame.contentWindow?.focus();
  }

  function close() {
    if (stage === 'ready' && !window.confirm('PhotoCraft 를 닫을까요?\n저장(Ctrl+S)하지 않은 작업은 돌아오지 않고 사라집니다.')) return;
    p.onClose();
  }

  const hint = stage === 'loading' ? 'PhotoCraft 를 불러오는 중… (처음 한 번은 10MB 안팎을 받습니다)'
    : stage === 'returning' ? '고친 그림을 배너로 가져오는 중…'
    : stage === 'failed' ? ''
    : `${p.what} 넘겼습니다. 다 고쳤으면 PhotoCraft 안에서 Ctrl+S — 고친 그림이 배너로 돌아옵니다.`;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col" style={{ background: '#101216' }}>
      <div className="flex items-center gap-3 px-3 h-[46px] shrink-0"
           style={{ background: 'var(--surface)', borderBottom: '1px solid var(--line)' }}>
        <b className="text-[13px]">PhotoCraft</b>
        <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
          오픈소스 포토샵 대체 · 초기 알파 · 메뉴는 영어 · 자동 저장 없음 · 한글은 글꼴을 Pretendard Variable 로
        </span>
        {hint && <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>{hint}</span>}
        {err && <span className="text-[12px]" style={{ color: 'var(--danger)' }}>{err}</span>}
        <button className="btn text-[12px] ml-auto" onClick={close} disabled={stage === 'returning'}>
          닫기 (가져오지 않음)
        </button>
      </div>
      <iframe ref={frameRef} src={PHOTOCRAFT_URL} title="PhotoCraft 이미지 편집기" onLoad={() => { void onLoad(); }}
              allow="fullscreen; clipboard-read; clipboard-write"
              className="flex-1 w-full" style={{ border: 0 }} />
    </div>
  );
}
