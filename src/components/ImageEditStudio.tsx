'use client';

/**
 * 포토샵 — 오픈소스 PhotoCraft(포토샵 대체, MIT/Apache-2.0)를 화면 가득 띄운 이미지 편집기.
 *
 * 사용자 요청 2026-10-14: "따로 빼서 항목으로 · 이미지 편집하기로 · 이건 정말 포토샵 기능 사용하게 · 이름은 포토샵이라고".
 * 레이어·선택·브러시·보정 같은 편집은 전부 PhotoCraft 안에서 한다. 이 화면은 그 바깥 도구줄에서
 *   · 생성이미지 갤러리 · 내 PC 그림 불러오기 (끌어다 놓기 흉내 — photocraft-bridge)
 *   · 저장 · 내보내기 — PhotoCraft 에 Ctrl+S 를 시켜 지금 그림을 받아 PNG·JPG·PSD 로 내려받거나 갤러리에 새 컷으로 저장
 *   · AI — 포토샵(Firefly)의 AI 기능을 같은 이름·같은 쓰임으로: 생성형 채우기 · 제거 도구 · 조화(합성) · 생성형 확장 ·
 *     배경 생성 · 배경 제거 (사용자 요청 2026-10-14: "포토샵에서 제공하는 AI 합성 관련된 기능들을 최대한 비슷하게").
 *     선택은 붓·상자로 칠하고, 변형을 1~3장 받아 골라 연다(포토샵처럼). 처리는 /api/image-edit/ai — 칠한 곳 밖은 원본 픽셀 그대로.
 *     결과는 PhotoCraft 에 새 문서(탭)로 연다 — 원래 문서는 그대로 남는다.
 * 를 맡는다. PhotoCraft 안쪽(메뉴·선택 영역·레이어)은 미리 만들어진 프로그램이라 손댈 수 없다 — AI 버튼이 바깥에 있는 이유.
 *
 * PhotoCraft 는 초기 알파다: 메뉴는 영어, 자동 저장 없음(떠날 때 묻는다), 한글 글자는 글꼴을 Pretendard Variable 로 골라야 보인다.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { thumbUrl } from '@/lib/thumb';
import {
  PHOTOCRAFT_URL, canvasToBlob, captureDownloads, dropFile, focusEditor, guardTabFloat, requestSave, toCanvas, waitForApp, type Captured,
} from '@/lib/photocraft-bridge';

export interface EditCut { id: string; url: string; title: string; createdAt: string }

/*
 * 도구줄 아이콘 — 그림 문자(🪄 등)는 Windows 10 기본 글꼴에 없어 네모(□)로 나왔다(사용자 지적 2026-10-14: "아이콘 좀 잡아줘").
 * 어느 PC 에서나 똑같이 보이게 선 아이콘(SVG, Lucide 모양 — ISC 라이선스)으로 그린다. 색은 글자색을 따른다.
 */
const ICON_PATHS = {
  brush: ['m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08', 'M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z'],
  image: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'm21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21'],
  folder: ['m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2'],
  save: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
  fill: ['M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z', 'M20 3v4', 'M22 5h-4'],
  remove: ['m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21', 'M22 21H7', 'm5 11 9 9'],
  harmonize: ['m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z', 'm22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65', 'm22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65'],
  expand: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'],
  background: ['m8 3 4 8 5-5 5 15H2L8 3z'],
  cutout: ['M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M20 4 8.12 15.88', 'M14.47 14.48 20 20', 'M8.12 8.12 12 12'],
} as const;
type IconName = keyof typeof ICON_PATHS;

function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {ICON_PATHS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

type AiOp = 'fill' | 'remove' | 'harmonize' | 'expand' | 'background' | 'cutout';
type Want = 'save' | AiOp;
interface Shot {
  canvas: HTMLCanvasElement;
  captured: Captured;
  /** 미리보기 그림 주소(objectURL) */
  preview: string;
  /** 문서 이름(확장자 없이) */
  name: string;
  /** 갤러리에서 불러온 문서면 그 컷 id — 넣을 때 파일 이름을 cut_<id> 로 붙여 두고 저장본 이름에서 다시 읽는다 */
  fromCut: string;
}
/** 그림 기준 0~1 상자 */
interface Box { x0: number; y0: number; x1: number; y1: number }
interface AiResult { url: string; width: number; height: number; type: string }

/** 포토샵 한국어판 이름 그대로 */
const AI_ORDER: AiOp[] = ['fill', 'remove', 'harmonize', 'expand', 'background', 'cutout'];
const AI_LABEL: Record<AiOp, string> = {
  fill: '생성형 채우기', remove: '제거 도구', harmonize: '조화(합성)', expand: '생성형 확장', background: '배경 생성', cutout: '배경 제거',
};
const AI_GUIDE: Record<AiOp, string> = {
  fill: '바꿀 곳을 붓이나 상자로 칠하고 그곳에 그릴 것을 적으세요. 비워 두면 칠한 곳을 지웁니다. 참조 이미지를 넣으면 그 물건을 그려 넣습니다. 칠한 곳 밖은 원본 그대로입니다.',
  remove: '지울 물건을 붓으로 넉넉하게 덮어 칠하세요. 칠한 곳만 뒤 배경으로 채우고 나머지는 원본 그대로입니다.',
  harmonize: '합성할 이미지를 넣고 끌어서 자리를 잡고 크기를 맞추세요(마우스 휠로도 크기 조절). 조명·색·그림자·가장자리를 장면에 맞추고, 제품 모양은 바꾸지 않게 지시합니다. 배경이 투명한 PNG 누끼가 가장 자연스럽습니다.',
  expand: '새 비율과 원본을 둘 자리를 고르세요. 원본은 그대로 두고 바깥만 장면을 이어 그립니다. 바깥에 무엇을 그릴지 적어도 됩니다.',
  background: '남길 피사체(사람·제품)를 붓으로 칠하고 새 배경을 적으세요. 칠한 피사체는 원본 그대로 두고 나머지를 새로 그립니다.',
  cutout: '사람·제품만 남기고 배경을 투명하게 만든 PNG 를 만듭니다. 시험 기능이라 머리카락 같은 가는 가장자리는 거칠 수 있습니다 — 제품 누끼는 드롭박스의 스튜디오 원본이 더 정확합니다.',
};
const AI_PLACEHOLDER: Partial<Record<AiOp, string>> = {
  fill: '무엇을 그릴까요? 예: 창가에 놓인 몬스테라 화분 (비우면 지우기)',
  harmonize: '추가 지시 (선택) — 예: 왼쪽 창문에서 들어오는 빛',
  expand: '바깥에 그릴 것 (선택) — 예: 같은 거실이 이어지게',
  background: '새 배경 — 예: 햇살 드는 밝은 거실, 원목 바닥',
};
/** 선택 칠 색 — 서버가 AI 에게 보여 주는 색과 맞춘다 */
const SEL_COLOR: Partial<Record<AiOp, string>> = { fill: '#2b8cff', remove: '#ff1f4f', background: '#22d46a' };
const RATIOS: [string, number, number][] = [['1:1', 1, 1], ['4:5', 4, 5], ['3:4', 3, 4], ['9:16', 9, 16], ['16:9', 16, 9], ['4:3', 4, 3]];
const MAX_POST = 3.9 * 1024 * 1024;                     // Vercel 본문 4.5MB 안쪽
const won = (n: number) => `₩${n.toLocaleString('ko-KR')}`;
const CHECKER = 'repeating-conic-gradient(#3a3d45 0% 25%, #2a2c33 0% 50%) 50% / 16px 16px';

function downloadBlob(blob: Blob, name: string) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 5000);
}

/** 서버로 보낼 그림을 cafe24 에 올린다 — 배너 편집기와 같은 /api/upload (보관함에는 넣지 않는다) */
async function upload(blob: Blob, title: string): Promise<string> {
  const fd = new FormData();
  fd.append('file', new File([blob], 'photoshop.jpg', { type: blob.type || 'image/jpeg' }));
  fd.append('title', title);
  fd.append('register', '0');
  const r = await fetch('/api/upload', { method: 'POST', body: fd });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || '업로드 실패');
  return j.url as string;
}

/** 우리 서버(cafe24)의 그림을 같은 출처로 받아 온다 — PhotoCraft 에 넣으려면 같은 출처의 파일이어야 한다 */
async function fetchOurs(url: string): Promise<Blob> {
  const r = await fetch(`/api/download?url=${encodeURIComponent(url)}&format=png`);
  if (!r.ok) throw new Error(`그림을 받지 못했습니다 (${r.status})`);
  return r.blob();
}

/** 칠한 판(색 = 선택) → 흑백 선택 그림(흰색 = 선택)을 W×H 로 */
function maskFromCanvas(src: HTMLCanvasElement, W: number, H: number): string {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    const v = p[i + 3] > 24 ? 255 : 0;
    p[i] = v; p[i + 1] = v; p[i + 2] = v; p[i + 3] = 255;
  }
  ctx.putImageData(d, 0, 0);
  return c.toDataURL('image/png');
}

function maskFromRect(W: number, H: number, x: number, y: number, w: number, h: number): string {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x, y, w, h);
  return c.toDataURL('image/png');
}

export default function ImageEditStudio({ cuts }: { cuts: EditCut[] }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [picker, setPicker] = useState(false);
  const [shot, setShot] = useState<Shot | null>(null);
  const [want, setWant] = useState<Want | null>(null);
  const pending = useRef<Want | null>(null);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const release = useRef<(() => void) | null>(null);
  /** 무언가 열거나 고쳤나 — 떠날 때 한 번 묻는다(자동 저장이 없어서) */
  const touched = useRef(false);
  const titles = useMemo(() => new Map(cuts.map((c) => [c.id, c.title])), [cuts]);

  useEffect(() => () => release.current?.(), []);

  /*
   * iframe 주소는 화면이 붙은(hydration) 뒤에 넣는다 — 서버 HTML 에 주소를 실어 두면 PhotoCraft 가 그보다 먼저 다 떠서
   * load 신호(onLoad)를 놓치고 도구줄이 「불러오는 중」에 멈춘다(2026-10-14 시험에서 확인).
   */
  useEffect(() => {
    const f = frameRef.current;
    if (f && !f.getAttribute('src')) f.src = PHOTOCRAFT_URL;
  }, []);

  // 다른 메뉴로 가거나 창을 닫을 때 — 작업이 사라진다는 것을 한 번 묻는다
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => { if (touched.current) e.preventDefault(); };
    const onClick = (e: MouseEvent) => {
      if (!touched.current) return;
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      const href = a.getAttribute('href') || '';
      if (!href.startsWith('/') || href === '/image-edit' || href.startsWith('/image-edit?') || href.startsWith('/image-edit#')) return;
      if (!window.confirm('포토샵을 떠날까요?\n저장하지 않은 작업은 사라집니다 (자동 저장 없음).')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onBefore);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBefore);
      document.removeEventListener('click', onClick, true);
    };
  }, []);

  /** PhotoCraft 가 저장(Ctrl+S)·내보내기를 했다 — 우리가 시킨 것이면 그 용도로, 사용자가 직접 누른 것이면 저장 창으로 */
  async function onCaptured(f: Captured) {
    if (waitTimer.current) clearTimeout(waitTimer.current);
    const w = pending.current ?? 'save';
    pending.current = null;
    setBusy('');
    try {
      const canvas = await toCanvas(f);
      const preview = URL.createObjectURL(await canvasToBlob(canvas, 'image/jpeg', 1600, 0.9));
      const name = f.name.replace(/\.[a-z0-9]+$/i, '') || 'photoshop';
      const fromCut = /^cut_([0-9a-f]{24})/.exec(name)?.[1] ?? '';
      setShot((old) => {
        if (old) URL.revokeObjectURL(old.preview);
        return { canvas, captured: f, preview, name, fromCut };
      });
      setWant(w);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function onLoad() {
    const frame = frameRef.current;
    if (!frame || release.current) return;
    // 주소를 넣기 전의 빈 문서(about:blank)가 내는 load 는 넘긴다
    if (!frame.contentWindow?.location.pathname.endsWith(PHOTOCRAFT_URL)) return;
    const releaseCapture = captureDownloads(frame, (f) => { void onCaptured(f); });
    // 탭을 끌어 내려 떠 있는 창으로 만드는 것을 막는다 — 웹판에서 그림이 창 밖으로 삐져나와 보이는 오류(사용자 제보 2026-10-14)
    const releaseGuard = guardTabFloat(frame);
    release.current = () => { releaseCapture(); releaseGuard(); };
    if (!(await waitForApp(frame))) {
      setStage('failed');
      setErr('포토샵이 뜨지 않았습니다 — 새로 고친 뒤 다시 열어 주세요.');
      return;
    }
    // 안에서 무언가 누르면(그리기·열기) 떠날 때 묻는다
    frame.contentDocument?.addEventListener('pointerdown', () => { touched.current = true; }, true);
    setStage('ready');
    focusEditor(frame);
  }

  function put(blob: Blob, name: string, msg: string) {
    const frame = frameRef.current;
    if (!frame || !dropFile(frame, blob, name)) { setErr('그림을 넣지 못했습니다.'); return; }
    touched.current = true;
    setNote(msg);
    focusEditor(frame);
  }

  async function loadCut(c: EditCut) {
    setPicker(false); setErr(''); setNote('');
    setBusy('갤러리 그림을 불러오는 중…');
    try {
      put(await fetchOurs(c.url), `cut_${c.id}.png`, `「${c.title || '컷'}」을 새 문서로 열었습니다 — 포토샵 위쪽 탭에 있습니다.`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }

  function openLocal(file: File | undefined) {
    if (!file) return;
    setErr('');
    put(file, file.name, `「${file.name}」을 새 문서로 열었습니다.`);
  }

  /** 지금 그림을 가져온다 — PhotoCraft 에 Ctrl+S 를 시키고, 받은 PSD 를 want 용도로 쓴다 */
  function grab(w: Want) {
    const frame = frameRef.current;
    if (!frame || stage !== 'ready') return;
    setErr(''); setNote('');
    pending.current = w;
    setBusy('지금 그림을 가져오는 중…');
    requestSave(frame);
    if (waitTimer.current) clearTimeout(waitTimer.current);
    waitTimer.current = setTimeout(() => {
      if (!pending.current) return;
      pending.current = null;
      setBusy('');
      setErr('그림을 가져오지 못했습니다 — 포토샵에 열린 그림이 있는지 확인해 주세요.');
    }, 8000);
  }

  function closePanel() {
    setWant(null);
    if (frameRef.current) focusEditor(frameRef.current);
  }

  /** AI 결과 한 장을 새 문서로 — 이름에 원본 컷을 이어 붙여 두어 갤러리 저장 때 계보가 남는다 */
  function openResult(op: AiOp, blob: Blob, n: number) {
    const base = shot?.fromCut ? `cut_${shot.fromCut}` : (shot?.name || 'photoshop');
    put(blob, `${base}_${op}_${n}.png`, `${AI_LABEL[op]} 결과를 새 문서로 열었습니다 — 원래 문서는 그대로 있습니다(위쪽 탭).`);
  }

  const ready = stage === 'ready';

  return (
    <div className="flex flex-col h-[calc(100dvh-48px)] lg:h-dvh">
      {/* ── 도구줄 ── */}
      <div className="flex items-center gap-2 flex-wrap px-3 py-2 shrink-0"
           style={{ background: 'var(--surface)', borderBottom: '1px solid var(--line)' }}>
        <b className="text-[14px] mr-1 inline-flex items-center gap-1.5"><Icon name="brush" size={16} />포토샵</b>
        <button className="btn text-[12px]" disabled={!ready} onClick={() => setPicker(true)}><Icon name="image" />갤러리에서 불러오기</button>
        <button className="btn text-[12px]" disabled={!ready} onClick={() => fileRef.current?.click()}><Icon name="folder" />내 PC에서 열기</button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,.psd" className="hidden"
               onChange={(e) => { openLocal(e.target.files?.[0]); e.target.value = ''; }} />
        <span className="mx-0.5" style={{ color: 'var(--line-strong)' }}>|</span>
        <button className="btn btn-primary text-[12px]" disabled={!ready || !!busy} onClick={() => grab('save')}
                title="지금 그림을 PNG·JPG·PSD 로 내려받거나 생성이미지 갤러리에 저장합니다 (포토샵 안에서 Ctrl+S 를 눌러도 같습니다)">
          <Icon name="save" />저장 · 내보내기
        </button>
        <span className="mx-0.5" style={{ color: 'var(--line-strong)' }}>|</span>
        <span className="label">AI</span>
        {AI_ORDER.map((op) => (
          <button key={op} className="chip" disabled={!ready || !!busy} onClick={() => grab(op)} title={AI_GUIDE[op]}>
            <Icon name={op} size={13} />{AI_LABEL[op]}
          </button>
        ))}
        <span className="text-[12px] ml-1" style={{ color: err ? 'var(--danger)' : 'var(--text-dim)' }}>
          {stage === 'loading' ? '포토샵을 불러오는 중… (처음 한 번은 10MB 안팎을 받습니다)' : err || busy || note}
        </span>
        <span className="ml-auto text-[11px] cursor-help" style={{ color: 'var(--text-mute)' }}
              title={[
                '오픈소스 PhotoCraft(github.com/storytold/photocraft, MIT/Apache-2.0) 기반 — 라이선스 파일은 /photocraft/ 에 함께 있습니다.',
                '초기 알파라 메뉴는 영어이고 자동 저장이 없습니다.',
                '한글 글자는 글자 도구에서 글꼴을 Pretendard Variable 로 고르면 보입니다.',
                'AI 는 나노바나나(제미나이)로 처리합니다 — 한 장에 약 ₩230~314.',
              ].join('\n')}>
          ⓘ PhotoCraft 기반 · 자동 저장 없음 · 한글은 Pretendard
        </span>
      </div>

      <iframe ref={frameRef} title="포토샵 이미지 편집기" onLoad={() => { void onLoad(); }}
              allow="fullscreen; clipboard-read; clipboard-write"
              className="flex-1 w-full min-h-0" style={{ border: 0, background: '#101216' }} />

      {/* ── 갤러리에서 고르기 ── */}
      {picker && (
        <CutPicker cuts={cuts} title="생성이미지 갤러리에서 불러오기" onPick={(c) => { void loadCut(c); }} onClose={() => setPicker(false)} />
      )}

      {/* ── 저장 · 내보내기 ── */}
      {shot && want === 'save' && (
        <SavePanel shot={shot} defaultTitle={shot.fromCut ? `${titles.get(shot.fromCut) || '컷'} (편집)` : shot.name}
                   onClose={closePanel} />
      )}

      {/* ── AI ── */}
      {shot && want && want !== 'save' && (
        <AiPanel op={want} shot={shot} cuts={cuts} onClose={closePanel} onOpen={(b, n) => openResult(want, b, n)} />
      )}
    </div>
  );
}

function Modal({ title, icon, onClose, children, wide }: { title: string; icon?: IconName; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.55)' }}
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card p-4 w-full flex flex-col" style={{ maxWidth: wide ? 1240 : 920, maxHeight: '94vh' }}>
        <div className="flex items-center mb-3">
          <b className="text-[14px] inline-flex items-center gap-1.5">{icon && <Icon name={icon} size={15} />}{title}</b>
          <button className="btn btn-ghost text-[12px] ml-auto" onClick={onClose}>닫기</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** 생성이미지 갤러리 고르기 — 불러오기·합성할 이미지·참조 이미지가 같이 쓴다 */
function CutPicker({ cuts, title, onPick, onClose, extra }: {
  cuts: EditCut[]; title: string; onPick: (c: EditCut) => void; onClose: () => void; extra?: React.ReactNode;
}) {
  const [q, setQ] = useState('');
  const shown = q.trim() ? cuts.filter((c) => c.title.includes(q.trim())) : cuts;
  return (
    <Modal onClose={onClose} title={title}>
      <div className="flex gap-2 mb-3">
        <input className="input" placeholder="제목으로 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
        {extra}
      </div>
      <div className="grid gap-2 overflow-y-auto pr-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', maxHeight: '64vh' }}>
        {shown.map((c) => (
          <button key={c.id} className="card p-1.5 text-left hover:opacity-85" onClick={() => onPick(c)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={thumbUrl(c.url, 256)} alt="" loading="lazy"
                 className="w-full aspect-square object-cover rounded-[6px]" style={{ background: 'var(--surface-2)' }} />
            <div className="text-[11px] mt-1 truncate">{c.title || '제목 없음'}</div>
            <div className="text-[10px]" style={{ color: 'var(--text-mute)' }}>{c.createdAt}</div>
          </button>
        ))}
        {!shown.length && <div className="text-[12px]" style={{ color: 'var(--text-mute)' }}>찾는 컷이 없습니다.</div>}
      </div>
    </Modal>
  );
}

function SavePanel({ shot, defaultTitle, onClose }: { shot: Shot; defaultTitle: string; onClose: () => void }) {
  const [title, setTitle] = useState(defaultTitle);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState<{ url: string } | null>(null);
  const isPsd = /photoshop/i.test(shot.captured.blob.type) || /\.psd$/i.test(shot.captured.name);
  const file = (title.trim() || shot.name).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);

  async function save(kind: 'png' | 'jpg' | 'psd') {
    setErr('');
    try {
      if (kind === 'psd') return downloadBlob(shot.captured.blob, `${file}.psd`);
      downloadBlob(await canvasToBlob(shot.canvas, kind === 'png' ? 'image/png' : 'image/jpeg', 0, 0.95), `${file}.${kind}`);
    } catch (e) { setErr((e as Error).message); }
  }

  async function toGallery() {
    setBusy('갤러리에 저장하는 중…'); setErr('');
    try {
      // 4MB 안으로 — 원본 크기에서 시작해 넘치면 줄인다
      let blob = await canvasToBlob(shot.canvas, 'image/jpeg', 0, 0.92);
      for (const [side, qy] of [[2560, 0.9], [2048, 0.88]] as const) {
        if (blob.size <= MAX_POST) break;
        blob = await canvasToBlob(shot.canvas, 'image/jpeg', side, qy);
      }
      const fd = new FormData();
      fd.append('file', new File([blob], 'edit.jpg', { type: 'image/jpeg' }));
      fd.append('title', title.trim() || defaultTitle);
      if (shot.fromCut) fd.append('fromCut', shot.fromCut);
      const r = await fetch('/api/image-edit', { method: 'POST', body: fd });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '저장 실패');
      setSaved({ url: j.url });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }

  return (
    <Modal title="저장 · 내보내기" onClose={onClose}>
      <div className="flex gap-4 flex-wrap">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={shot.preview} alt="지금 그림" className="rounded-[8px] object-contain"
             style={{ maxWidth: 'min(520px, 100%)', maxHeight: '56vh', background: CHECKER }} />
        <div className="flex-1 min-w-[240px] flex flex-col gap-2.5">
          <div className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
            {shot.canvas.width} × {shot.canvas.height}px{shot.fromCut ? ' · 갤러리에서 불러온 그림' : ''}
          </div>
          <label className="label">이름</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className="label mt-1">내 PC에 내려받기</div>
          <div className="flex gap-1.5 flex-wrap">
            <button className="btn text-[12px]" onClick={() => { void save('png'); }}>PNG</button>
            <button className="btn text-[12px]" onClick={() => { void save('jpg'); }}>JPG</button>
            {isPsd && <button className="btn text-[12px]" onClick={() => { void save('psd'); }} title="레이어가 살아 있는 원본 — 포토샵에서 다시 열어 고칠 수 있습니다">PSD (레이어 포함)</button>}
          </div>
          <div className="label mt-1">생성이미지 갤러리에 저장</div>
          <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            새 컷으로 쌓입니다(원본 컷은 그대로).{shot.fromCut ? ' 불러온 컷의 제품·색·모델 정보를 이어받습니다.' : ''}
          </div>
          {saved ? (
            <div className="text-[12px]" style={{ color: 'var(--ok)' }}>
              저장했습니다 — <Link href="/cuts" className="underline" target="_blank">생성이미지 갤러리에서 보기</Link>
            </div>
          ) : (
            <button className="btn btn-primary text-[12px] self-start" disabled={!!busy} onClick={() => { void toGallery(); }}>
              {busy || '갤러리에 저장'}
            </button>
          )}
          {err && <div className="text-[12px]" style={{ color: 'var(--danger)' }}>{err}</div>}
        </div>
      </div>
    </Modal>
  );
}

/** 조화(합성)에 얹을 이미지 */
interface Placed { url: string; bmp: ImageBitmap; aspect: number; name: string }
/** 생성형 채우기의 참조 이미지 */
interface RefImg { url?: string; file?: Blob; preview: string; name: string }

/**
 * AI 창 — 포토샵의 AI 기능 하나. 왼쪽은 작업판(칠하기·자리 잡기·비율 미리보기), 오른쪽은 설정과 결과(변형 1~3장).
 * 결과는 고른 것만 새 문서로 연다 — 포토샵에서 변형 셋 중 하나를 고르는 것과 같다.
 */
function AiPanel({ op, shot, cuts, onClose, onOpen }: {
  op: AiOp; shot: Shot; cuts: EditCut[]; onClose: () => void; onOpen: (b: Blob, n: number) => void;
}) {
  const selectable = op === 'fill' || op === 'remove' || op === 'background';
  const [tool, setTool] = useState<'brush' | 'box'>('brush');
  const [size, setSize] = useState(36);
  const [hasSel, setHasSel] = useState(false);
  const [boxDrag, setBoxDrag] = useState<Box | null>(null);
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(1);
  const [ratio, setRatio] = useState<[number, number] | null>(null);
  const [anchor, setAnchor] = useState<[number, number]>([0.5, 0.5]);
  const [ref, setRef] = useState<RefImg | null>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [flip, setFlip] = useState(false);
  const [pos, setPos] = useState({ cx: 0.5, cy: 0.62, w: 0.34 });
  const [chooser, setChooser] = useState<null | 'ref' | 'place'>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [results, setResults] = useState<AiResult[]>([]);
  const [opened, setOpened] = useState<number[]>([]);
  const area = useRef<HTMLDivElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const moving = useRef<{ dx: number; dy: number } | null>(null);
  const pcFile = useRef<HTMLInputElement>(null);
  const pcFor = useRef<'ref' | 'place'>('place');

  // 칠하기 판은 미리보기 그림의 실제 픽셀 크기로 둔다(보내기 직전에 그림 크기로 늘린다)
  const k0 = Math.min(1, 1600 / Math.max(shot.canvas.width, shot.canvas.height));
  const PW = Math.round(shot.canvas.width * k0), PH = Math.round(shot.canvas.height * k0);

  // 포토샵처럼 [ ] 로 붓 크기
  useEffect(() => {
    if (!selectable) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === '[') setSize((s) => Math.max(4, s - 6));
      if (e.key === ']') setSize((s) => Math.min(300, s + 6));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectable]);

  function rel(e: React.PointerEvent) {
    const r = area.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, k: PW / r.width };
  }
  function dab(a: { x: number; y: number }, b: { x: number; y: number }, k: number) {
    const ctx = maskRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = ctx.fillStyle = SEL_COLOR[op] ?? '#2b8cff';
    ctx.lineWidth = size * k;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x * PW, a.y * PH);
    ctx.lineTo(b.x * PW, b.y * PH);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(b.x * PW, b.y * PH, (size * k) / 2, 0, Math.PI * 2);
    ctx.fill();
    setHasSel(true);
  }
  function clearSel() {
    const c = maskRef.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    setHasSel(false);
  }

  async function choose(c: EditCut) {
    const target = chooser;
    setChooser(null);
    setErr('');
    try {
      if (target === 'ref') { setRef({ url: c.url, preview: thumbUrl(c.url, 256), name: c.title }); return; }
      const blob = await fetchOurs(c.url);
      const bmp = await createImageBitmap(blob);
      setPlaced({ url: URL.createObjectURL(blob), bmp, aspect: bmp.width / bmp.height, name: c.title });
    } catch (e) { setErr((e as Error).message); }
  }
  async function fromPc(file: File | undefined) {
    if (!file) return;
    setErr('');
    try {
      if (pcFor.current === 'ref') { setRef({ file, preview: URL.createObjectURL(file), name: file.name }); return; }
      const bmp = await createImageBitmap(file);
      setPlaced({ url: URL.createObjectURL(file), bmp, aspect: bmp.width / bmp.height, name: file.name });
    } catch { setErr('이 파일은 열 수 없습니다 — PNG·JPG·WebP 를 골라 주세요.'); }
  }

  const canRun = op === 'expand' ? !!ratio
    : op === 'harmonize' ? !!placed
      : op === 'cutout' ? true
        : op === 'background' ? hasSel && !!prompt.trim()
          : hasSel;

  async function run() {
    setBusy(true); setErr(''); setResults([]); setOpened([]);
    try {
      const src = shot.canvas;
      const s = Math.min(1, 2048 / Math.max(src.width, src.height));
      const W = Math.max(64, Math.round(src.width * s)), H = Math.max(64, Math.round(src.height * s));
      const base = document.createElement('canvas');
      base.width = W;
      base.height = H;
      const ctx = base.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(src, 0, 0, W, H);
      let mask: string | undefined;
      if (selectable && maskRef.current) mask = maskFromCanvas(maskRef.current, W, H);
      if (op === 'harmonize' && placed) {
        // 얹을 이미지를 먼저 그림에 합쳐 보낸다(투명 PNG 의 가장자리가 그대로 살아 있게) — AI 는 그 자리를 장면에 녹인다
        const ow = pos.w * W, oh = ow / placed.aspect;
        const x = pos.cx * W - ow / 2, y = pos.cy * H - oh / 2;
        ctx.save();
        if (flip) { ctx.translate(x + ow / 2, 0); ctx.scale(-1, 1); ctx.translate(-(x + ow / 2), 0); }
        ctx.drawImage(placed.bmp, x, y, ow, oh);
        ctx.restore();
        mask = maskFromRect(W, H, x, y, ow, oh);
      }
      const imageUrl = await upload(await canvasToBlob(base, 'image/jpeg', 0, 0.92), '포토샵 AI 원본');
      let refUrl: string | undefined;
      if (op === 'fill' && ref && prompt.trim()) refUrl = ref.url ?? await upload(ref.file!, '포토샵 AI 참조');
      const r = await fetch('/api/image-edit/ai', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op, imageUrl, mask, refUrl, count,
          prompt: prompt.trim() || undefined,
          ratio: op === 'expand' ? ratio : undefined,
          anchor: op === 'expand' ? anchor : undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'AI 처리 실패');
      setResults(j.results as AiResult[]);
      if (j.failed) setErr(`${j.failed}장은 만들지 못했습니다 — 나머지 중에서 고르세요.`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function open(i: number) {
    try {
      onOpen(await fetchOurs(results[i].url), i + 1);
      setOpened((o) => [...o, i]);
    } catch (e) { setErr((e as Error).message); }
  }

  // ── 작업판 크기 — 창 안에 들어오게 ──
  const W0 = shot.canvas.width, H0 = shot.canvas.height;
  const ar = op === 'expand' && ratio ? ratio[0] / ratio[1] : W0 / H0;
  const availW = Math.min(820, (typeof window === 'undefined' ? 1200 : window.innerWidth) - 460);
  const availH = (typeof window === 'undefined' ? 900 : window.innerHeight) * 0.62;
  const boardW = Math.max(160, Math.min(availW, availH * ar));
  const boardH = boardW / ar;
  let inner = { w: 1, h: 1 };
  if (op === 'expand' && ratio) {
    let cw = W0, ch = (W0 * ratio[1]) / ratio[0];
    if (ch < H0) { ch = H0; cw = (H0 * ratio[0]) / ratio[1]; }
    inner = { w: W0 / cw, h: H0 / ch };
  }
  const hR = placed ? (pos.w * (W0 / H0)) / placed.aspect : 0;
  const cost = `나노바나나 ${count}회 · 약 ${won(230 * count)}~${won(314 * count)}`;
  const active = { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' };

  return (
    <Modal title={AI_LABEL[op]} icon={op} onClose={() => { if (!busy) onClose(); }} wide>
      <div className="text-[12px] mb-3 leading-relaxed" style={{ color: 'var(--text-dim)' }}>{AI_GUIDE[op]}</div>
      <div className="flex gap-4 flex-wrap min-h-0">
        {/* ── 작업판 ── */}
        <div className="flex items-center justify-center rounded-[8px] p-2.5" style={{ background: 'var(--surface-2)', flex: '1 1 480px', minWidth: 0 }}>
          {op === 'expand' ? (
            <div className="relative" style={{ width: boardW, height: boardH, maxWidth: '100%',
                                               border: ratio ? '2px dashed var(--accent)' : undefined,
                                               background: ratio ? 'repeating-linear-gradient(45deg, rgba(254,99,38,0.12) 0 10px, transparent 10px 20px)' : undefined }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={shot.preview} alt="" draggable={false} className="absolute"
                   style={{ left: `${anchor[0] * (1 - inner.w) * 100}%`, top: `${anchor[1] * (1 - inner.h) * 100}%`,
                            width: `${inner.w * 100}%`, height: `${inner.h * 100}%` }} />
            </div>
          ) : (
            <div ref={area} className="relative select-none" style={{ width: boardW, height: boardH, maxWidth: '100%', touchAction: 'none',
                                                                       cursor: selectable ? 'crosshair' : 'default', background: CHECKER }}
                 onPointerDown={(e) => {
                   if (!selectable) return;
                   e.currentTarget.setPointerCapture(e.pointerId);
                   const p = rel(e);
                   if (tool === 'brush') { dab(p, p, p.k); last.current = p; } else setBoxDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
                 }}
                 onPointerMove={(e) => {
                   if (moving.current) {
                     const p = rel(e);
                     setPos((o) => ({ ...o, cx: p.x - moving.current!.dx, cy: p.y - moving.current!.dy }));
                     return;
                   }
                   if (!selectable) return;
                   const p = rel(e);
                   if (tool === 'brush' && last.current) { dab(last.current, p, p.k); last.current = p; }
                   if (tool === 'box' && boxDrag) setBoxDrag({ ...boxDrag, x1: p.x, y1: p.y });
                 }}
                 onPointerUp={() => {
                   moving.current = null;
                   last.current = null;
                   if (boxDrag) {
                     const ctx = maskRef.current?.getContext('2d');
                     const x0 = Math.min(boxDrag.x0, boxDrag.x1), y0 = Math.min(boxDrag.y0, boxDrag.y1);
                     const bw = Math.abs(boxDrag.x1 - boxDrag.x0), bh = Math.abs(boxDrag.y1 - boxDrag.y0);
                     if (ctx && bw > 0.005 && bh > 0.005) {
                       ctx.fillStyle = SEL_COLOR[op] ?? '#2b8cff';
                       ctx.fillRect(x0 * PW, y0 * PH, bw * PW, bh * PH);
                       setHasSel(true);
                     }
                     setBoxDrag(null);
                   }
                 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={shot.preview} alt="" draggable={false} className="absolute inset-0 w-full h-full" />
              {selectable && <canvas ref={maskRef} width={PW} height={PH} className="absolute inset-0 w-full h-full pointer-events-none" style={{ opacity: 0.5 }} />}
              {boxDrag && (
                <div className="absolute pointer-events-none" style={{
                  left: `${Math.min(boxDrag.x0, boxDrag.x1) * 100}%`, top: `${Math.min(boxDrag.y0, boxDrag.y1) * 100}%`,
                  width: `${Math.abs(boxDrag.x1 - boxDrag.x0) * 100}%`, height: `${Math.abs(boxDrag.y1 - boxDrag.y0) * 100}%`,
                  border: `2px dashed ${SEL_COLOR[op]}`,
                }} />
              )}
              {op === 'harmonize' && placed && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={placed.url} alt="" draggable={false} className="absolute"
                     style={{ left: `${(pos.cx - pos.w / 2) * 100}%`, top: `${(pos.cy - hR / 2) * 100}%`, width: `${pos.w * 100}%`, height: `${hR * 100}%`,
                              cursor: 'move', transform: flip ? 'scaleX(-1)' : undefined, outline: '1px dashed rgba(0,220,230,0.9)' }}
                     onPointerDown={(e) => {
                       e.stopPropagation();
                       area.current?.setPointerCapture(e.pointerId);
                       const p = rel(e);
                       moving.current = { dx: p.x - pos.cx, dy: p.y - pos.cy };
                     }}
                     onWheel={(e) => setPos((o) => ({ ...o, w: Math.min(1.2, Math.max(0.03, o.w * (e.deltaY < 0 ? 1.06 : 1 / 1.06))) }))} />
              )}
            </div>
          )}
        </div>

        {/* ── 설정 · 결과 ── */}
        <div className="flex flex-col gap-2.5 min-w-0" style={{ flex: '0 1 340px' }}>
          {selectable && (
            <>
              <div className="label">{op === 'background' ? '남길 피사체 칠하기' : '선택 영역 칠하기'}</div>
              <div className="flex gap-1.5 flex-wrap items-center">
                <button className="chip" style={tool === 'brush' ? active : {}} onClick={() => setTool('brush')}>붓</button>
                <button className="chip" style={tool === 'box' ? active : {}} onClick={() => setTool('box')}>상자</button>
                <button className="chip" disabled={!hasSel} onClick={clearSel}>선택 지우기</button>
              </div>
              {tool === 'brush' && (
                <label className="flex items-center gap-2 text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
                  붓 크기
                  <input type="range" min={4} max={300} value={size} onChange={(e) => setSize(Number(e.target.value))} className="flex-1" />
                  <span className="tabular-nums w-8 text-right">{size}</span>
                </label>
              )}
              <div className="text-[11px]" style={{ color: 'var(--text-mute)' }}>[ ] 키로 붓 크기를 바꿀 수 있습니다.</div>
            </>
          )}

          {op === 'harmonize' && (
            <>
              <div className="label">합성할 이미지</div>
              <div className="flex gap-1.5 flex-wrap">
                <button className="btn text-[12px]" onClick={() => setChooser('place')}><Icon name="image" />갤러리에서</button>
                <button className="btn text-[12px]" onClick={() => { pcFor.current = 'place'; pcFile.current?.click(); }}><Icon name="folder" />내 PC에서</button>
              </div>
              {placed ? (
                <>
                  <div className="text-[11.5px] truncate" style={{ color: 'var(--text-dim)' }}>{placed.name} — 작업판에서 끌어 옮기세요</div>
                  <label className="flex items-center gap-2 text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
                    크기
                    <input type="range" min={3} max={120} value={Math.round(pos.w * 100)} onChange={(e) => setPos((o) => ({ ...o, w: Number(e.target.value) / 100 }))} className="flex-1" />
                    <span className="tabular-nums w-10 text-right">{Math.round(pos.w * 100)}%</span>
                  </label>
                  <div className="flex gap-1.5">
                    <button className="chip" style={flip ? active : {}} onClick={() => setFlip((f) => !f)}>좌우 뒤집기</button>
                    <button className="chip" onClick={() => setPos({ cx: 0.5, cy: 0.62, w: 0.34 })}>자리 처음으로</button>
                  </div>
                </>
              ) : (
                <div className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>아직 넣은 이미지가 없습니다.</div>
              )}
            </>
          )}

          {op === 'expand' && (
            <>
              <div className="label">새 비율</div>
              <div className="flex gap-1.5 flex-wrap">
                {RATIOS.map(([label, a, b]) => (
                  <button key={label} className="chip" onClick={() => setRatio([a, b])} style={ratio && ratio[0] === a && ratio[1] === b ? active : {}}>{label}</button>
                ))}
              </div>
              <div className="label">원본을 둘 자리</div>
              <div className="grid grid-cols-3 gap-1 w-[96px]">
                {[0, 0.5, 1].flatMap((y) => [0, 0.5, 1].map((x) => (
                  <button key={`${x}-${y}`} className="h-[28px] rounded-[4px]" title="원본 자리"
                          onClick={() => setAnchor([x, y])}
                          style={{ border: '1px solid var(--line-strong)', background: anchor[0] === x && anchor[1] === y ? 'var(--accent)' : 'var(--surface-2)' }} />
                )))}
              </div>
            </>
          )}

          {op !== 'remove' && op !== 'cutout' && (
            <>
              <div className="label">{op === 'background' ? '새 배경' : op === 'fill' ? '무엇을 그릴까요' : '지시'}</div>
              <textarea className="input" rows={3} placeholder={AI_PLACEHOLDER[op]} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </>
          )}

          {op === 'fill' && (
            <>
              <div className="label">참조 이미지 (선택)</div>
              <div className="flex gap-1.5 flex-wrap items-center">
                <button className="btn text-[12px]" onClick={() => setChooser('ref')}><Icon name="image" />갤러리에서</button>
                <button className="btn text-[12px]" onClick={() => { pcFor.current = 'ref'; pcFile.current?.click(); }}><Icon name="folder" />내 PC에서</button>
                {ref && (
                  <span className="inline-flex items-center gap-1.5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={ref.preview} alt="" className="w-9 h-9 object-cover rounded-[4px]" />
                    <button className="chip" onClick={() => setRef(null)}>빼기</button>
                  </span>
                )}
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-mute)' }}>그릴 것을 적었을 때만 씁니다 — 이 물건을 칠한 자리에 그려 넣습니다.</div>
            </>
          )}

          <div className="label">변형</div>
          <div className="flex gap-1.5 items-center flex-wrap">
            {[1, 2, 3].map((n) => (
              <button key={n} className="chip" style={count === n ? active : {}} onClick={() => setCount(n)}>{n}장</button>
            ))}
            <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>{cost}</span>
          </div>
          <button className="btn btn-primary text-[12.5px] self-start" disabled={!canRun || busy} onClick={() => { void run(); }}>
            {busy ? `AI 처리 중… (${count === 1 ? '30초~1분' : '1~2분'})` : `${AI_LABEL[op]} 실행`}
          </button>
          {err && <div className="text-[12px]" style={{ color: 'var(--danger)' }}>{err}</div>}

          {results.length > 0 && (
            <>
              <div className="label mt-1">결과 — 고른 것을 포토샵에 새 문서로 엽니다</div>
              <div className="grid grid-cols-3 gap-1.5">
                {results.map((r, i) => (
                  <div key={r.url} className="flex flex-col gap-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={thumbUrl(r.url, 384)} alt={`변형 ${i + 1}`} className="w-full aspect-square object-contain rounded-[6px]"
                         style={{ background: CHECKER }} />
                    <button className="chip justify-center" onClick={() => { void open(i); }} style={opened.includes(i) ? active : {}}>
                      {opened.includes(i) ? '열었음' : `${i + 1} 열기`}
                    </button>
                  </div>
                ))}
              </div>
              {results.length > 1 && (
                <button className="btn text-[12px] self-start" onClick={() => { results.forEach((_, i) => { if (!opened.includes(i)) void open(i); }); }}>
                  모두 열기
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <input ref={pcFile} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
             onChange={(e) => { void fromPc(e.target.files?.[0]); e.target.value = ''; }} />
      {chooser && (
        <CutPicker cuts={cuts} title={chooser === 'ref' ? '참조 이미지 고르기' : '합성할 이미지 고르기'}
                   onPick={(c) => { void choose(c); }} onClose={() => setChooser(null)} />
      )}
    </Modal>
  );
}
