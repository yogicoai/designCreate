'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ICONS, renderLayersToSvg, textEm, type DesignDoc, type DesignLayer } from '@/lib/design-render';
import DesignEditor from '@/components/DesignEditor';
import { TEMPLATES, THEMES, findTheme } from '@/lib/banner-templates';
import {
  CHANNELS, AUTO_SET, visibleSizesFor, defaultSizeFor, channelOf,
  findSize, shapeOf, cropLoss, type Channel,
} from '@/lib/banner-sizes';
import { shrinkForUpload } from '@/lib/client-image';
import { BRAND_BUTTON_COLORS, brandButtonHex } from '@/lib/brand';
import { thumbUrl } from '@/lib/thumb';

/**
 * 배너 디자인 생성 — 간단한 포토샵.
 *
 * 화면이 곧 순서다: 컷 고르기 → 어디에 걸 배너인가 → 문구 → (선택) 다듬기.
 * 쓰는 사람이 디자이너가 아니라서, 세 번 만지면 완성되고 나머지는 접혀 있어야 한다.
 * 그래서 단계는 오른쪽 한 줄에 번호를 달아 세우고, 왼쪽은 결과만 크게 보여준다.
 *
 * 미리보기를 CSS 로 흉내내지 않고 **저장할 때와 똑같은 SVG** 를 그대로 띄운다.
 * 그래야 화면에서 본 것과 저장본이 어긋나지 않는다 (곡선 텍스트처럼
 * CSS 로는 재현 못 하는 연출이 있기 때문에도 필요하다).
 *
 * 좌표·크기는 전부 0~1 비율이라 어떤 해상도의 컷에 얹어도 같은 배치가 나온다.
 */

interface CutOption { id: string; url: string; label: string }
interface SavedTemplate { id: string; name: string; design: DesignDoc; updatedAt: string | null; thumb?: string | null }

const uid = () => Math.random().toString(36).slice(2, 9);

/**
 * 레이어를 기준 상태(base)에서 k 배로 키우거나 줄인 사본.
 * ⤡ 손잡이 드래그와 수치 입력이 똑같이 계산되도록 한 곳에 모았다.
 */
function scaledFrom(base: DesignLayer, k: number): DesignLayer {
  if (base.kind === 'text' || base.kind === 'icon') {
    return { ...base, size: Math.max(0.01, Math.min(0.6, (base.size ?? 0.06) * k)) };
  }
  if (base.kind === 'brush') {
    const cx0 = base.x ?? 0.5, cy0 = base.y ?? 0.5;
    return {
      ...base,
      strokeWidth: Math.max(0.002, (base.strokeWidth ?? 0.01) * k),
      points: (base.points ?? []).map((q) => ({ x: cx0 + (q.x - cx0) * k, y: cy0 + (q.y - cy0) * k })),
    };
  }
  // 이미지·도형·스크림 — 가로세로를 같은 배율로 (h 미지정 이미지는 srcAspect 가 따라온다)
  return {
    ...base,
    w: Math.max(0.02, Math.min(2, (base.w ?? 0.3) * k)),
    ...(base.h != null ? { h: Math.max(0.02, Math.min(2, base.h * k)) } : {}),
  };
}

/**
 * 새 레이어의 기본값 — 만들자마자 화면 가운데에 보이게.
 * 글자 외곽 그림자는 끈 채로 시작한다. 판판한 글씨가 깔끔하고,
 * 배경에 묻힐 때만 선택한 레이어에서 켜면 된다.
 */
function newLayer(kind: DesignLayer['kind'], color: string): DesignLayer {
  const base = { id: uid(), kind, x: 0.5, y: 0.5, color, opacity: 1 } as DesignLayer;
  if (kind === 'text') return { ...base, text: '새 문구', size: 0.06, weight: 700, tracking: 0, lineHeight: 1.25, align: 'middle', shadow: false, curve: 0 };
  if (kind === 'icon') return { ...base, icon: 'arrow', size: 0.06, stroke: 0.09 };
  if (kind === 'rect') return { ...base, w: 0.4, h: 0.1, radius: 0.05 };
  return { ...base, x: 0.5, y: 0.2, w: 1, h: 0.4, opacity: 0.5, direction: 'top' };
}

/** 자동 배치가 만든 레이어인가 — 손대지 않은 배치만 규격이 바뀔 때 다시 잡는다 */
const isAuto = (l: DesignLayer) => l.id.startsWith('auto-');

/*
 * 내가 올린 배경은 브라우저에 기억해둔다.
 *
 * cuts 컬렉션에 넣지 않는 이유: 이건 '생성한 컷'이 아니라 배너 재료일 뿐이다.
 * 레퍼런스 보관함에도 넣지 않는다 — 거긴 스타일 참고 이미지 자리다.
 * 그래도 새로고침하면 사라지는 건 곤란하니 URL 만 브라우저에 적어둔다.
 *
 * 스냅샷으로 문자열을 돌려주는 게 중요하다. 매번 새 배열을 만들어 돌려주면
 * useSyncExternalStore 가 계속 바뀐 것으로 보고 무한히 다시 그린다.
 */
const MINE_KEY = 'banner-bg-mine';
const mineListeners = new Set<() => void>();
let mineJson = (() => {
  try { return (typeof window !== 'undefined' && window.localStorage.getItem(MINE_KEY)) || '[]'; }
  catch { return '[]'; }
})();

function subscribeMine(fn: () => void) {
  mineListeners.add(fn);
  return () => { mineListeners.delete(fn); };
}
function saveMine(next: CutOption[]) {
  mineJson = JSON.stringify(next.slice(0, 24));
  try { window.localStorage.setItem(MINE_KEY, mineJson); } catch { /* 무시 */ }
  mineListeners.forEach((fn) => fn());
}

/**
 * 단계 카드.
 *
 * 이 화면은 순서대로 밟는 물건이라 번호를 붙이고 끝낸 단계는 표시한다.
 * 앞 단계를 안 끝냈으면 흐리게 죽여서, 어디부터 손대야 할지 헤매지 않게 한다.
 */
function Step({
  n, title, hint, done, disabled, open, onToggle, accent, children,
}: {
  n: number; title: string; hint?: string;
  done?: boolean; disabled?: boolean;
  open?: boolean; onToggle?: () => void;
  accent?: boolean;
  children: React.ReactNode;
}) {
  const collapsible = typeof open === 'boolean' && !!onToggle;
  const shown = collapsible ? open : true;
  return (
    <div className="card p-3 mb-3"
         style={{
           borderColor: accent ? 'var(--accent-dim)' : undefined,
           opacity: disabled ? 0.5 : 1,
           pointerEvents: disabled ? 'none' : undefined,
         }}>
      <div className={`flex items-center gap-2 ${shown ? 'mb-2' : ''}`}
           onClick={onToggle}
           style={{ cursor: collapsible ? 'pointer' : undefined }}>
        <span className="shrink-0 grid place-items-center rounded-full text-[10px] font-bold tabular-nums"
              style={{
                width: 18, height: 18,
                background: done ? 'var(--accent)' : 'var(--surface-3)',
                color: done ? '#fff' : 'var(--text-mute)',
              }}>
          {done ? '✓' : n}
        </span>
        <span className="label flex-1" style={{ color: 'var(--text-dim)' }}>{title}</span>
        {hint && <span className="text-[10.5px] tabular-nums" style={{ color: 'var(--text-mute)' }}>{hint}</span>}
        {collapsible && <span className="text-[10px]" style={{ color: 'var(--text-mute)' }}>{shown ? '▲' : '▼'}</span>}
      </div>
      {shown && children}
    </div>
  );
}

/** 이 레이어가 속한 무리. 무리가 없으면 자기 자신이 한 무리다 */
const groupOf = (l: DesignLayer) => l.group ?? l.id;

/** 무리마다 대표 하나씩만 남긴다 — 손잡이도 목록도 한 몸으로 보여야 한다 */
function leaders(list: DesignLayer[]): DesignLayer[] {
  const seen = new Set<string>();
  return list.filter((l) => {
    const g = groupOf(l);
    if (seen.has(g)) return false;
    seen.add(g);
    return true;
  });
}

/**
 * 버튼(알약 + 글자 + 화살표)의 속을 다시 맞춘다.
 *
 * 문구나 글자 크기를 바꾸면 알약도 같이 커져야 한다. 서버의 자동 배치가
 * 쓰는 것과 같은 계산이다 — 안 그러면 글자가 알약 밖으로 삐져나온다.
 */
function relayoutButton(list: DesignLayer[], group: string, W: number, H: number): DesignLayer[] {
  const S = Math.min(W, H);
  const pill = list.find((l) => l.group === group && l.kind === 'rect');
  const label = list.find((l) => l.group === group && l.kind === 'text');
  const arrow = list.find((l) => l.group === group && l.kind === 'icon');
  if (!pill || !label) return list;

  const cs = label.size ?? 0.03;
  const pw = Math.min(0.95, ((textEm(label.text ?? '') + (arrow ? 3.2 : 1.8)) * cs * S) / W);
  const ph = (cs * S * 2.4) / H;
  const cx = pill.x;
  const cy = pill.y;

  return list.map((l) => {
    if (l.group !== group) return l;
    if (l.kind === 'rect') return { ...l, x: cx, y: cy, w: pw, h: ph };
    if (l.kind === 'icon') return { ...l, x: cx + pw / 2 - (cs * S * 0.9) / W, y: cy, size: cs * 0.95 };
    return { ...l, x: arrow ? cx - (cs * S * 0.6) / W : cx, y: cy };
  });
}

/** 목록·손잡이에 보여줄 이름. 무리는 '버튼' 으로 묶어 부른다 */
function labelOf(l: DesignLayer, all: DesignLayer[]): string {
  if (l.group) {
    const t = all.find((x) => x.group === l.group && x.kind === 'text')?.text;
    return `버튼 · ${t || '(빈 글자)'}`;
  }
  if (l.kind === 'text') return l.text || '(빈 글자)';
  if (l.kind === 'icon') return `아이콘 · ${ICONS[l.icon ?? '']?.label ?? l.icon}`;
  return l.kind === 'rect' ? '도형' : '그늘';
}

/** 저장된 배너를 다시 열 때, 그때 쓴 문구를 입력칸에 되돌려 놓는다 */
function textOf(d: DesignDoc | undefined, id: string, fallback: string) {
  return d?.layers.find((l) => l.id === id)?.text ?? fallback;
}

export default function DesignStudio({ cuts, initial, sourceId, fonts = [], refs = [] }: {
  cuts: CutOption[];
  initial?: DesignDoc;
  /** 관리 게시판에서 수정으로 연 배너의 id — 저장할 때 계보로 남긴다 */
  sourceId?: string;
  /** fonts/ 폴더에서 찾은 글꼴들 — 파일만 넣으면 서버가 목록을 만든다 */
  fonts?: { family: string; file: string }[];
  /** 레퍼런스 보관함 — 배경·A안 우측 이미지를 생성 컷 말고 여기서도 고른다 */
  refs?: { url: string; label: string; cat: string }[];
}) {
  /*
   * 배경은 고르고 시작한다. 첫 컷을 자동으로 물려두면 고르지도 않은 배경 위에
   * 문구가 얹힌 채 화면이 열려서, 자기가 무엇을 만들고 있는지 헷갈린다.
   */
  const [imageUrl, setImageUrl] = useState(initial?.imageUrl ?? '');
  const [themeId, setThemeId] = useState('dark');
  const [layers, setLayers] = useState<DesignLayer[]>(initial?.layers ?? []);
  const [selected, setSelected] = useState<string | null>(null);
  const [templates, setTemplates] = useState<SavedTemplate[]>([]);
  /** 내 템플릿 드롭다운 열림 — 칩이 줄줄이 늘어지지 않게 접어둔다 */
  const [tplOpen, setTplOpen] = useState(false);
  const [busy, setBusy] = useState<'auto' | 'save' | 'tpl' | 'upload' | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  /*
   * 확인창 — 저장 전에 실제 크기 렌더를 보여주고, [이대로 저장]을 눌러야 저장된다.
   * 실수로 갤러리에 쌓이는 걸 막고, 저장되는 그림을 눈으로 확정하는 단계다.
   * 입력이 같으면 렌더도 같아서, 확인 후 저장 때 다시 그려도 같은 그림이 나온다.
   */
  const [result, setResult] = useState<
    | { kind: 'single'; preview: string; w: number; h: number }
    | {
        kind: 'pair';
        items: {
          label: string; w: number; h: number; preview: string; sizeId: string;
          layers: DesignLayer[]; fit: NonNullable<DesignDoc['fit']>;
        }[];
      }
    | null
  >(null);
  const [tweakOpen, setTweakOpen] = useState(true);
  /** 규격 단계 — 기본은 접어둔다 (대개 기본 규격을 그대로 쓰고, 배치·문구가 먼저다) */
  const [sizeOpen, setSizeOpen] = useState(false);
  // 배경 전체보기 게시판 — 생성 컷을 20개씩 페이지로 넘겨 고른다.
  // A안 웹의 우측 이미지도 같은 게시판에서 고른다 (browseFor 로 어느 자리에 넣을지 구분)
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseFor, setBrowseFor] = useState<'bg' | 'right'>('bg');
  // 소스 탭 — 생성 컷 / 레퍼런스 보관함. 레퍼런스는 분류 칩으로 한 번 더 거른다
  const [browseSrc, setBrowseSrc] = useState<'cuts' | 'refs'>('cuts');
  const [browseCat, setBrowseCat] = useState('');
  const [browsePage, setBrowsePage] = useState(0);
  const BROWSE_PER = 20;
  // 원본 컷의 크기와 '걸릴 자리'의 규격은 다른 값이다. 둘을 섞으면 미리보기가 어긋난다
  const [src, setSrc] = useState({ w: 1000, h: 1000 });
  /*
   * 채널이 규격보다 위다 — 자사몰 / 스마트스토어 / SNS 는 걸리는 자리와
   * 규격 묶음이 완전히 다르다. 저장본을 다시 열면 그 규격의 채널로 맞춘다.
   */
  const [channel, setChannel] = useState<Channel>(
    initial?.size?.id ? channelOf(initial.size.id) : '자사몰',
  );
  const [sizeId, setSizeId] = useState(initial?.size?.id ?? defaultSizeFor('자사몰'));   // '' = 컷 크기 그대로
  const [fitMode, setFitMode] = useState<'cover' | 'blur' | 'color' | 'gradient'>(initial?.fit?.mode ?? 'cover');
  // 여백 채우기 색 (color·gradient 모드) — 색값 하나로 서버·미리보기가 똑같이 그린다
  const [fillColor, setFillColor] = useState(initial?.fit?.fillColor ?? '#f2f0ec');
  const [fx, setFx] = useState(initial?.fit?.fx ?? 0.5);           // 잘라낼 때 남길 가로 위치
  const [fy, setFy] = useState(initial?.fit?.fy ?? 0.45);          // 세로 위치 — 인물이 아래면 올린다
  // 포토샵 방식에서 만지는 배경 변형(확대)·보정 — 템플릿 방식에선 기본값 그대로다
  const [fitZoom, setFitZoom] = useState(initial?.fit?.zoom ?? 1);
  const [fitZoomX, setFitZoomX] = useState(initial?.fit?.zoomX ?? 1);
  /** 배경을 캔버스 밖까지 미는 이동량 (폭·높이 대비 비율) — 잘릴 여백이 없어도 움직인다 */
  const [fitPanX, setFitPanX] = useState(initial?.fit?.panX ?? 0);
  const [fitPanY, setFitPanY] = useState(initial?.fit?.panY ?? 0);
  const [fitZoomY, setFitZoomY] = useState(initial?.fit?.zoomY ?? 1);
  const [fitAdjust, setFitAdjust] = useState<NonNullable<DesignDoc['fit']>['adjust']>(initial?.fit?.adjust);
  /*
   * 자동 배치 입력 — 이 화면의 기본 사용법이다.
   *
   * 기본값은 실제로 쓰는 자사몰 배너의 네 칸 구조를 그대로 채워둔다:
   *   눈썹(작게 한 줄) → 제목(크게) → 혜택 한 줄 → 버튼.
   * 빈칸에서 시작하면 무엇을 넣어야 하는지가 안 보인다.
   */
  const [autoEyebrow, setAutoEyebrow] = useState(() => textOf(initial, 'auto-eyebrow', '함께 쓸 때 더 완성되는 요기보 조합'));
  const [autoTitle, setAutoTitle] = useState(() => textOf(initial, 'auto-title', '요기보 빈백·서포트 세트'));
  const [autoSub, setAutoSub] = useState(() => textOf(initial, 'auto-sub', '상시할인 · 전 구성 무료배송 · 5% 추가 적립까지'));
  const [autoCta, setAutoCta] = useState(() => textOf(initial, 'auto-cta', '세트 구매하기'));
  const [picked, setPicked] = useState<{ where: string; light: boolean; sd: number; shape: string } | null>(null);
  /*
   * 버전 보관함 — 웹/모바일을 탭으로 오가며 각각 다듬기 위한 자리.
   * 무대에는 한 규격만 올라가고, 내려간 버전은 여기 남는다.
   * 위치·크기는 버전마다 따로지만, 색은 patchColor 가 양쪽에 같이 넣는다.
   */
  const [variants, setVariants] = useState<Record<string, { layers: DesignLayer[]; fit: NonNullable<DesignDoc['fit']> }>>({});
  /*
   * 버튼 색은 '사진에서 뽑기' 아니면 브랜드 목록 중 하나만 — 자유 색상은
   * 4단계에서 손으로 다듬는 사람의 몫이다. MD 가 색을 고르는 것 자체가 개입이라서.
   */
  const [btnColor, setBtnColor] = useState('photo');
  // 문구 크기·줄 간격 배율. 1 = 기존 자사몰 배너 실측값 — 고정이 아니라 출발점이다
  const [tuneScale, setTuneScale] = useState(1);
  const [tuneGap, setTuneGap] = useState(1);
  // 배너 전체의 글꼴 — 저장본을 다시 열면 그때 글꼴로 돌아온다
  const [fontFamily, setFontFamily] = useState(initial?.font ?? '');
  /*
   * 잘라내기 위치를 손댔는가. 안 댔으면 서버가 피사체를 보고 정한다.
   * 저장본을 다시 열었을 때는 그때 정한 위치를 존중한다 (true 로 시작).
   */
  const [focusTouched, setFocusTouched] = useState(!!initial);
  // 서버가 정해준 초점을 슬라이더에 반영할 때 재배치 효과가 또 돌지 않게 막는 표식
  const applyingFocus = useRef(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  /** 배경 이미지 자체를 끄는 중 — 기본 템플릿에서도 이미지를 잡아 위치(fx/fy)를 옮긴다 */
  const bgDragRef = useRef<{ sx: number; sy: number; fx0: number; fy0: number; px0: number; py0: number; pan: boolean } | null>(null);
  /** 이미지 칸(우측 이미지 등) 안에서 끌 때 — 그 칸의 사진만 움직인다 (배경이 아니라) */
  const imgPanRef = useRef<{ id: string; sx: number; sy: number; fx0: number; fy0: number } | null>(null);
  /** 이미지 더블클릭으로 여는 배경 크기 패널 (무대 상단에 뜬다) */
  const [bgTune, setBgTune] = useState(false);

  const theme = findTheme(themeId);
  const sel = layers.find((l) => l.id === selected) ?? null;

  const mineRaw = useSyncExternalStore(subscribeMine, () => mineJson, () => '[]');
  const mine = useMemo<CutOption[]>(() => {
    try { return JSON.parse(mineRaw) as CutOption[]; } catch { return []; }
  }, [mineRaw]);

  // 원본 컷의 실제 크기 — 얼마나 잘리는지 알려주려면 필요하다
  useEffect(() => {
    if (!imageUrl) return;
    const img = new window.Image();
    img.onload = () => setSrc({ w: img.naturalWidth || 1000, h: img.naturalHeight || 1000 });
    img.src = imageUrl;
  }, [imageUrl]);

  // 최종 규격. 고르지 않았으면 컷 크기를 그대로 쓴다
  const dims = useMemo(() => {
    if (!sizeId) return src;
    const b = findSize(sizeId);
    return { w: b.w, h: b.h };
  }, [sizeId, src]);

  const shape = shapeOf(dims.w, dims.h);
  // 규격과 컷의 비율이 다를 때만 '맞추는 방법'을 물어본다
  const needsFit = Math.abs(dims.w / dims.h - src.w / src.h) > 0.01;
  /*
   * 어느 축이 잘리는가. 1:1 컷을 1900x675 로 덮으면 가로는 통째로 들어가고
   * 세로만 잘린다 — 그때 좌우(↔) 슬라이더는 움직여도 아무 일이 없다.
   * 조절할 게 없는 슬라이더는 숨기고, 왜 없는지 한 줄로 말해준다.
   */
  const coverK = Math.max(dims.w / src.w, dims.h / src.h);
  const cropX = src.w * coverK - dims.w > 1;   // 가로가 잘리는 조합인가
  const cropY = src.h * coverK - dims.h > 1;
  const loss = needsFit ? cropLoss(src.w, src.h, dims.w, dims.h) : 0;
  const fit = useMemo(() => ({
    mode: fitMode, fx, fy,
    ...(fitMode === 'color' || fitMode === 'gradient' ? { fillColor } : {}),
    ...(fitZoom !== 1 ? { zoom: fitZoom } : {}),
    ...(fitZoomX !== 1 ? { zoomX: fitZoomX } : {}),
    ...(fitZoomY !== 1 ? { zoomY: fitZoomY } : {}),
    ...(fitPanX ? { panX: fitPanX } : {}),
    ...(fitPanY ? { panY: fitPanY } : {}),
    ...(fitAdjust ? { adjust: fitAdjust } : {}),
  }), [fitMode, fx, fy, fillColor, fitZoom, fitZoomX, fitZoomY, fitPanX, fitPanY, fitAdjust]);

  const design: DesignDoc = useMemo(
    () => ({ imageUrl, layers, size: { id: sizeId || undefined, w: dims.w, h: dims.h }, fit, font: fontFamily || undefined }),
    [imageUrl, layers, sizeId, dims, fit, fontFamily],
  );

  /*
   * 편집 방식 — 템플릿(자동배치, 기본) / 포토샵(레이어 정밀 편집).
   * 포토샵 방식은 같은 레이어 데이터를 피그마식 캔버스에서 만지는 전체 화면 편집기다.
   * 나갈 때 레이어를 그대로 돌려받아 두 방식이 이어진다.
   */
  const [editorOpen, setEditorOpen] = useState(false);

  const loadTemplates = useCallback(async () => {
    const r = await fetch('/api/design');
    const j = await r.json();
    if (j.ok) setTemplates(j.templates ?? []);
  }, []);
  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  /** 저장할 때와 똑같은 SVG — 미리보기가 곧 결과다 */
  const svg = useMemo(() => renderLayersToSvg(design, dims.w, dims.h), [design, dims]);

  function patch(id: string, next: Partial<DesignLayer>) {
    setLayers((cur) => cur.map((l) => (l.id === id ? { ...l, ...next } : l)));
  }

  /**
   * 색은 두 버전에 같이 들어간다 (사용자 결정: "위치는 아니고 컬러는 둘 다").
   * 자동 배치가 두 버전에 같은 레이어 id 를 쓰기 때문에 id 로 짝을 찾는다.
   */
  function patchColor(id: string, color: string) {
    patch(id, { color });
    setVariants((v) => {
      const out: typeof v = {};
      for (const [k, doc] of Object.entries(v)) {
        out[k] = { ...doc, layers: doc.layers.map((l) => (l.id === id ? { ...l, color } : l)) };
      }
      return out;
    });
  }

  /**
   * 저장해둔 배경 상태를 무대에 되돌린다.
   * 크기(zoom)·밀기(pan)·늘림·보정까지 전부 — 이걸 빠뜨리면 웹에서 키운 배경이
   * 모바일 탭에도 그대로 남아 "한쪽만 바꿔도 둘 다 바뀐다" 가 된다 (사용자 확인).
   */
  function applyFit(f: NonNullable<DesignDoc['fit']>) {
    setFitMode(f.mode);
    setFx(f.fx); setFy(f.fy);
    if (f.fillColor) setFillColor(f.fillColor);
    setFitZoom(f.zoom ?? 1);
    setFitZoomX(f.zoomX ?? 1);
    setFitZoomY(f.zoomY ?? 1);
    setFitPanX(f.panX ?? 0);
    setFitPanY(f.panY ?? 0);
    setFitAdjust(f.adjust);
  }

  /** '모든 설정 초기화' 한 번 더 묻기 — 실수로 눌러 배치가 날아가지 않게 */
  const [resetArm, setResetArm] = useState(false);
  /**
   * 이 버전의 손댄 설정을 처음 상태로 — 배경 변형(크기·밀기·늘림·보정)과 색 테마,
   * 문구 크기·줄간격을 되돌리고 배치는 지금 고른 시안으로 다시 깐다.
   * 되돌리기(↩) 로 복구되므로 한 번 더 묻기만 하고 바로 실행한다.
   */
  function resetAll() {
    snapUndo();
    setFitMode('cover');
    setFx(0.5); setFy(0.5);
    setFitZoom(1); setFitZoomX(1); setFitZoomY(1);
    setFitPanX(0); setFitPanY(0);
    setFitAdjust(undefined);
    setThemeId('dark');
    setTuneScale(1); setTuneGap(1);
    setSelected(null); setPanelClosedFor(null); setBgTune(false);
    if (stageIsTemplateA()) applyPlan('A');
    else if (stageIsTemplateB()) applyPlan('B');
    else setLayers([]);
    setResult(null);
    setResetArm(false);
    setNote('모든 설정을 처음 상태로 되돌렸습니다. (↩ 이전 작업으로 로 복구 가능)');
  }

  /** 무대에 있는 버전을 보관함에 내려둔다 */
  function stashActive() {
    if (!sizeId || !layers.length) return;
    setVariants((v) => ({ ...v, [sizeId]: { layers, fit } }));
  }

  /** 특정 규격의 자동 배치를 서버에서 받아온다 — 탭 전환과 짝 최신화가 같이 쓴다 */
  async function fetchAutoFor(sid: string) {
    const b = findSize(sid);
    const res = await fetch('/api/design', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        auto: {
          imageUrl, eyebrow: autoEyebrow, title: autoTitle, subtitle: autoSub, cta: autoCta,
          size: { id: sid, w: b.w, h: b.h },
          autoFocus: true,
          buttonColor: btnColor === 'photo' ? undefined : brandButtonHex(btnColor),
          tune: { scale: tuneScale, gap: tuneGap },
        },
      }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || '자동 배치 실패');
    return { layers: j.layers as DesignLayer[], fit: j.fit as NonNullable<DesignDoc['fit']> };
  }

  /**
   * 버전 탭 전환 — 지금 것을 내려두고 그 규격을 올린다.
   * 보관함에 없으면 같은 문구로 자동 배치를 새로 받아온다.
   */
  async function switchVariant(sid: string) {
    if (sid === sizeId) return;
    if (!imageUrl) { setErr('배경 컷을 골라주세요.'); return; }
    stashActive();
    const stored = variants[sid];
    applyingFocus.current = true;                        // 규격 변경으로 자동 재배치가 돌아 덮지 않게
    setSizeId(sid);
    setUndoDepth((undoRef.current[sid] ?? []).length);    // 되돌리기도 버전마다 따로다
    setFocusTouched(true);
    setSelected(null);
    setResult(null);
    if (stored) {
      setLayers(stored.layers);
      applyFit(stored.fit);
      return;
    }
    setBusy('auto'); setErr('');
    try {
      const got = await fetchAutoFor(sid);
      setLayers(got.layers);
      if (got.fit) applyFit(got.fit);
      setVariants((v) => ({ ...v, [sid]: got }));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  /**
   * 자사몰 기본 시안 A안 — 디자인팀 실제 롤링배너(1920x680) 레이아웃을 그대로 박은 것.
   * 원본(Yogibo Luxe 배너) 실측: 좌 60.6% 씬 이미지(어둡게) + 우 39.4% 클로즈업 이미지,
   * 문구는 좌하단 좌측정렬 3줄(타이틀·서브·설명/기간). 배경 = 좌측 이미지,
   * 우측 이미지는 별도 레이어라 이미지 2개가 한 배너에 들어간다.
   */
  /** A안 레이어 시드 — 규격에 맞는 배치를 만든다. texts 로 다른 버전의 문구를 이어받는다 */
  function templateASeeds(w: number, h: number, texts?: Record<string, string>, style: 'scrim' | 'band' = 'scrim'): DesignLayer[] {
    const tx = (name: string, def: string) => texts?.[name] ?? def;
    if (h > w && style === 'band') {
      /*
       * 밴드형 모바일 A안 (Modju 계열 실물) — 사진은 위쪽만 쓰고,
       * 아래는 단색 밴드가 깔리며 사진 끝이 그 색으로 스며든다. 문구는 밴드 위에.
       * 밴드 색은 캠페인마다 달라서 레이어 색으로 바꾼다 (기본: 네이비).
       */
      const BAND = '#3d3a68';
      return [
        { id: uid(), kind: 'rect', x: 0.5, y: 0.69, w: 1, h: 0.62, color: BAND, opacity: 1, name: '하단 밴드' },
        { id: uid(), kind: 'scrim', x: 0.5, y: 0.33, w: 1, h: 0.22, color: BAND, opacity: 1, direction: 'bottom', name: '사진→밴드 번짐' },
        // 문자: 62px/700/-2%/lh75 · 45px/700/-2%/lh80 · 25px/500/lh100% (피그마 실측, 800 기준)
        // 위치: 타이틀(2줄 블록) top 484 → 중심 484+75 · 서브 +21 → top 655 · 설명 +30 → top 765
        { id: uid(), kind: 'text', x: 0.094, y: 559 / 907, text: tx('타이틀', '문구가 들어갑니다.\n문구가 들어갑니다.'), size: 62 / 800, weight: 700, tracking: -0.02, lineHeight: 75 / 62, align: 'start', shadow: false, curve: 0, color: '#ffffff', opacity: 1, name: '타이틀' },
        { id: uid(), kind: 'text', x: 0.094, y: 695 / 907, text: tx('서브 타이틀', '서브 타이틀이 들어갑니다.'), size: 45 / 800, weight: 700, tracking: -0.02, lineHeight: 80 / 45, align: 'start', shadow: false, curve: 0, color: '#ffffff', opacity: 1, name: '서브 타이틀' },
        { id: uid(), kind: 'text', x: 0.094, y: 777.5 / 907, text: tx('설명·기간', '설명 또는 기간 00.00(월) - 00.00(일)'), size: 25 / 800, weight: 500, tracking: 0, lineHeight: 1, align: 'start', shadow: false, curve: 0, color: '#d9d6ea', opacity: 1, name: '설명·기간' },
      ];
    }
    if (h > w) {
      // 모바일 A안(실물 800×907 실측) — 이미지 한 장 + 하단 45% 웜톤 그늘 + 문구 3줄 좌측정렬
      return [
        { id: uid(), kind: 'scrim', x: 0.5, y: 0.775, w: 1, h: 0.45, color: '#2a1d12', opacity: 0.85, direction: 'bottom', name: '하단 그늘' },
        // 문자: 62px/700/-2%/lh75 · 45px/700/-2%/lh80 · 25px/500/lh100% (피그마 실측, 800 기준)
        // 위치: 타이틀(2줄 블록) top 484 → 중심 484+75 · 서브 +21 → top 655 · 설명 +30 → top 765
        { id: uid(), kind: 'text', x: 0.094, y: 559 / 907, text: tx('타이틀', '문구가 들어갑니다.\n문구가 들어갑니다.'), size: 62 / 800, weight: 700, tracking: -0.02, lineHeight: 75 / 62, align: 'start', shadow: false, curve: 0, color: '#ffffff', opacity: 1, name: '타이틀' },
        { id: uid(), kind: 'text', x: 0.094, y: 695 / 907, text: tx('서브 타이틀', '서브 타이틀이 들어갑니다.'), size: 45 / 800, weight: 700, tracking: -0.02, lineHeight: 80 / 45, align: 'start', shadow: false, curve: 0, color: '#ffffff', opacity: 1, name: '서브 타이틀' },
        { id: uid(), kind: 'text', x: 0.094, y: 777.5 / 907, text: tx('설명·기간', '설명 또는 기간 00.00(월) - 00.00(일)'), size: 25 / 800, weight: 500, tracking: 0, lineHeight: 1, align: 'start', shadow: false, curve: 0, color: '#e6e3dd', opacity: 1, name: '설명·기간' },
      ];
    }
    // 웹 A안(실물 1920×680 실측) — 좌 60.6% 씬+어둡게+문구 3줄, 우 39.4% 이미지 슬롯
    return [
      rightImg
        ? { id: uid(), kind: 'image', x: 0.803, y: 0.5, w: 0.394, h: 1.0, src: rightImg, cover: true,
            ...(rightAspect ? { srcAspect: rightAspect } : {}), srcFx: 0.5, srcFy: 0.5,
            color: '#ffffff', opacity: 1, name: '우측 이미지' }
        : { id: uid(), kind: 'rect', x: 0.803, y: 0.5, w: 0.394, h: 1.0, color: '#d9dde3', opacity: 1, name: '우측 이미지 자리 — 이미지로 교체' },
      { id: uid(), kind: 'rect', x: 0.303, y: 0.5, w: 0.606, h: 1.0, color: '#000000', opacity: 0.25, name: '좌측 어둡게' },
      // 문자: 65px/700/-2%/lh75 · 45px/700/-2%/lh80 · 25px/500/lh100% (피그마 실측, 680 기준)
      // 위치: left 180 · 타이틀(2줄 블록) top 297 → 중심 297+75 · 서브 +21 → top 468 · 설명 +33 → top 581
      { id: uid(), kind: 'text', x: 180 / 1920, y: 372 / 680, text: tx('타이틀', '문구가 들어갑니다.\n문구가 들어갑니다.'), size: 65 / 680, weight: 700, tracking: -0.02, lineHeight: 75 / 65, align: 'start', shadow: false, curve: 0, color: '#ffffff', opacity: 1, name: '타이틀' },
      { id: uid(), kind: 'text', x: 180 / 1920, y: 508 / 680, text: tx('서브 타이틀', '서브 타이틀이 들어갑니다.'), size: 45 / 680, weight: 700, tracking: -0.02, lineHeight: 80 / 45, align: 'start', shadow: false, curve: 0, color: '#ffffff', opacity: 1, name: '서브 타이틀' },
      { id: uid(), kind: 'text', x: 180 / 1920, y: 593.5 / 680, text: tx('설명·기간', '설명 또는 기간 00.00(월) - 00.00(일)'), size: 25 / 680, weight: 500, tracking: 0, lineHeight: 1, align: 'start', shadow: false, curve: 0, color: '#e6e3dd', opacity: 1, name: '설명·기간' },
    ];
  }

  /**
   * B안 레이어 시드 — 이미지 한 장 + **중앙정렬** 문구 3줄(타이틀은 2줄 가능).
   * 디자인팀 가이드(/test/w_b.jpg 1920×680, /test/m_b.jpg 800×907) 실측.
   * 가이드에 그늘이 없어서 안 깐다 — 대신 가는 가독 윤곽(shadow)으로 흰 글씨를 세운다.
   */
  function templateBSeeds(w: number, h: number, texts?: Record<string, string>): DesignLayer[] {
    const tx = (name: string, def: string) => texts?.[name] ?? def;
    const mob = h > w;
    return [
      // 문자: 웹 65px / 모바일 62px · 서브 45px · 설명 25px — 자간 -2%(설명 0), 중앙정렬 (피그마 실측)
      // 위치: 타이틀(2줄) top 웹310/모484 → 중심 +75 · 서브 +21 · 설명 웹+33/모+30
      { id: uid(), kind: 'text', x: 0.5, y: mob ? 559 / 907 : 385 / 680, text: tx('타이틀', '문구가 들어갑니다.\n문구가 들어갑니다.'), size: mob ? 62 / 800 : 65 / 680, weight: 700, tracking: -0.02, lineHeight: mob ? 75 / 62 : 75 / 65, align: 'middle', shadow: true, curve: 0, color: '#ffffff', opacity: 1, name: '타이틀' },
      { id: uid(), kind: 'text', x: 0.5, y: mob ? 695 / 907 : 521 / 680, text: tx('서브 타이틀', '서브 타이틀이 들어갑니다.'), size: mob ? 45 / 800 : 45 / 680, weight: 700, tracking: -0.02, lineHeight: 80 / 45, align: 'middle', shadow: true, curve: 0, color: '#ffffff', opacity: 1, name: '서브 타이틀' },
      { id: uid(), kind: 'text', x: 0.5, y: mob ? 777.5 / 907 : 606.5 / 680, text: tx('설명·기간', '설명 문구가 들어갑니다.'), size: mob ? 25 / 800 : 25 / 680, weight: 500, tracking: 0, lineHeight: 1, align: 'middle', shadow: true, curve: 0, color: '#f0eee9', opacity: 1, name: '설명·기간' },
    ];
  }

  /** 배치가 어느 시안인지 — 짝 저장에서 모자란 버전을 같은 시안으로 이어 만들 때 본다 */
  const looksLikeTemplateA = (ls: DesignLayer[]) =>
    ls.some((l) => l.name?.startsWith('우측 이미지') || l.name === '하단 그늘' || l.name === '하단 밴드');
  const looksLikeTemplateB = (ls: DesignLayer[]) =>
    !looksLikeTemplateA(ls) && ls.some((l) => l.kind === 'text' && l.name === '타이틀');
  const stageIsTemplateA = () => looksLikeTemplateA(layers);
  const stageIsTemplateB = () => looksLikeTemplateB(layers);

  /**
   * 시안 적용 — 무대에 깔고, 짝 버전에도 같은 시안을 심는다.
   * 짝을 안 심으면 버전 탭에 남아 있던 옛 자동 배치가 짝 저장에 그대로 끼어 들어간다
   * (사용자 확인: 모바일이 이전 배치로 저장됨). 시안 버튼 = "이 짝은 이 시안이다" 선언.
   */
  function applyPlan(plan: 'A' | 'B', style?: 'scrim' | 'band') {
    snapUndo();
    const st = style ?? mobStyle;
    if (style) setMobStyle(style);
    const make = (w: number, h: number) =>
      plan === 'B' ? templateBSeeds(w, h) : templateASeeds(w, h, undefined, st);
    const seeds = make(dims.w, dims.h);
    setLayers(seeds);
    for (const sid of AUTO_SET[channel]) {
      if (sid === sizeId) continue;
      const b = findSize(sid);
      const pseeds = make(b.w, b.h);
      // 배경 상태는 버전마다 따로 — 이미 잡아둔 게 있으면 그대로 둔다
      setVariants((v) => ({ ...v, [sid]: { layers: pseeds, fit: v[sid]?.fit ?? fit } }));
    }
    setSelected(null);   // 깔자마자 아무것도 선택하지 않는다 — 크기 패널이 먼저 뜨면 화면을 가린다
    setResult(null);
    if (plan === 'B') {
      setNote('B안 배치를 올렸습니다 — 이미지 한 장 + 중앙정렬 문구. 짝 버전에도 B안이 같이 깔렸습니다.');
    } else {
      setNote(dims.h > dims.w
        ? `모바일 A안(${st === 'band' ? '밴드형' : '그늘형'})을 올렸습니다 — 웹 버전에도 A안이 같이 깔렸습니다.`
        : rightImg ? 'A안 배치를 올렸습니다 — 모바일 버전에도 A안이 같이 깔렸습니다.' : 'A안 배치를 올렸습니다 — 우측 이미지를 올리면 회색 자리에 들어갑니다.');
    }
  }
  const applyTemplateA = (style?: 'scrim' | 'band') => applyPlan('A', style);

  /** A안 우측 이미지를 정한다 — 무대에 A안이 있으면 자리표시(회색)든 기존 것이든 바꿔 끼운다 */
  function setRightImage(url: string, aspect?: number) {
    snapUndo();
    setRightImg(url);
    setRightAspect(aspect);
    setLayers((cur) => cur.map((l) => (l.name?.startsWith('우측 이미지')
      ? {
          ...l, kind: 'image' as const, src: url, cover: true, color: '#ffffff', name: '우측 이미지',
          ...(aspect ? { srcAspect: aspect } : {}),
          // 새 사진을 끼우면 초점은 가운데로 초기화 — 이전 사진의 초점이 남으면 엉뚱한 데가 보인다
          srcFx: 0.5, srcFy: 0.5,
        }
      : l)));
    /*
     * 비율을 모르면 브라우저에서 재서 채운다 — srcAspect 가 있어야 슬롯 안에서
     * 초점(보이는 부분)을 옮길 수 있다. 없으면 가운데 고정으로만 잘린다.
     */
    if (!aspect) {
      const img = new window.Image();
      img.onload = () => {
        const a = (img.naturalWidth || 1) / (img.naturalHeight || 1);
        setRightAspect(a);
        setLayers((cur) => cur.map((l) => (l.src === url && l.name?.startsWith('우측 이미지') ? { ...l, srcAspect: a } : l)));
      };
      img.src = url;
    }
  }

  /** A안 우측 이미지 업로드 — 배경 업로드와 같은 경로, 보관함 등록은 안 한다 */
  async function uploadRight(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    setBusy('upload'); setErr('');
    try {
      const shrunk = await shrinkForUpload(f);
      const fd = new FormData();
      fd.append('file', shrunk.file);
      fd.append('title', f.name);
      fd.append('register', '0');
      const j = await (await fetch('/api/upload', { method: 'POST', body: fd })).json();
      if (!j.ok) { setErr(j.error || '업로드 실패'); return; }
      setRightImage(j.url, j.width && j.height ? j.width / j.height : undefined);
      setNote(`우측 이미지 준비됨 — "${f.name}"`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  function applyTemplate(tplId: string) {
    const t = TEMPLATES.find((x) => x.id === tplId);
    if (!t) return;
    const th = findTheme(themeId);
    const decs: DesignLayer[] = t.decorations.map((d) => ({
      id: uid(),
      kind: d.kind === 'scrim' ? 'scrim' : 'rect',
      x: d.x + d.w / 2, y: d.y + d.h / 2, w: d.w, h: d.h,
      color: d.tone === 'scrim' ? th.scrim : d.tone === 'accent' ? th.accent : th.strong,
      opacity: d.opacity, radius: d.radius, direction: d.direction ?? 'top',
    }));
    const txts: DesignLayer[] = t.layers.map((x) => ({
      id: uid(), kind: 'text', x: x.x, y: x.y, text: x.placeholder,
      size: x.size, weight: x.weight, tracking: x.tracking, lineHeight: 1.25,
      align: x.align, shadow: false, curve: 0,
      color: x.tone === 'strong' ? th.strong : x.tone === 'soft' ? th.soft : th.accentText,
      opacity: 1,
    }));
    setLayers([...decs, ...txts]);
    setSelected(null);   // 자동 배치도 마찬가지 — 손대는 순간에만 패널이 뜬다
    setResult(null);
  }

  // ── 끌어서 옮기기 ──
  function onDown(e: React.PointerEvent, id: string) {
    const st = stageRef.current;
    if (!st) return;
    const l = layers.find((x) => x.id === id);
    if (!l) return;
    snapUndo();
    const r = st.getBoundingClientRect();
    dragRef.current = { id, dx: (e.clientX - r.left) / r.width - l.x, dy: (e.clientY - r.top) / r.height - l.y };
    setSelected(id);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  /**
   * 비율 유지 크기 손잡이(↘) — 선택한 레이어의 점 옆에 떠서, 끌면 상하좌우가 한 번에
   * 같은 비율로 줄고 큰다 (사용자 요청: "상하좌우 한번에, 비율에 맞춰서").
   */
  const scaleRef = useRef<{ id: string; sx: number; sy: number; start: DesignLayer } | null>(null);
  /*
   * 수치로 크기 조절 — 선택한 순간의 상태를 100% 기준으로 잡고, 입력한 %만큼 키우거나 줄인다.
   * (사용자 요청: 손잡이 말고 숫자를 눌러 낮추면 작아지게)
   */
  const [sizePct, setSizePct] = useState(100);
  /** 100% 기준이 되는 레이어 id — 렌더에서 ref 를 읽지 않으려고 상태로 둔다 */
  const [sizeBaseId, setSizeBaseId] = useState<string | null>(null);
  /** X 로 접어둔 레이어 id — 다른 레이어를 고르면 패널이 다시 뜬다 */
  const [panelClosedFor, setPanelClosedFor] = useState<string | null>(null);
  /*
   * 이전 작업으로 돌아가기 — 조작을 시작하는 지점(시안 적용·이동·크기·이미지 교체 등)에서
   * 그 직전 배치를 최대 20단계까지 쌓아둔다. 슬라이더를 연속으로 움직여도 한 번만 쌓이도록
   * "조작 시작"에서만 부른다.
   */
  type UndoStep = { layers: DesignLayer[]; fit: NonNullable<DesignDoc['fit']> };
  /*
   * 버전(규격)마다 따로 쌓는다 — 웹에서 한 작업을 모바일에서 되돌리면 엉뚱한 배치가 올라온다.
   * 배경 변형(fit)도 함께 담아, 크기·위치를 만진 것도 같이 되짚는다.
   */
  const undoRef = useRef<Record<string, UndoStep[]>>({});
  const [undoDepth, setUndoDepth] = useState(0);
  const undoKey = () => sizeId || '__free';
  function snapUndo() {
    const k = undoKey();
    const cur = undoRef.current[k] ?? [];
    undoRef.current = { ...undoRef.current, [k]: [...cur.slice(-19), { layers, fit }] };
    setUndoDepth(undoRef.current[k].length);
  }
  function undoLast() {
    const k = undoKey();
    const cur = [...(undoRef.current[k] ?? [])];
    const prev = cur.pop();
    undoRef.current = { ...undoRef.current, [k]: cur };
    setUndoDepth(cur.length);
    if (!prev) return;
    setLayers(prev.layers);
    applyFit(prev.fit);
    setSelected(null);
    setResult(null);
    setNote('이전 작업으로 되돌렸습니다. (이 버전에만 적용됩니다)');
  }
  const sizeBaseRef = useRef<{ id: string; base: DesignLayer } | null>(null);
  const shownPct = sizeBaseId === selected
    ? sizePct
    : (sel?.kind === 'image' && sel.cover ? Math.round((sel.srcZoom ?? 1) * 100) : 100);
  function applySizePct(pct: number) {
    const l = layers.find((x) => x.id === selected);
    if (!l) return;
    /*
     * cover 이미지 슬롯(A안 우측 이미지 등)은 최종 자리·크기가 고정이다.
     * 그래서 여기서는 슬롯을 키우지 않고 그 안의 그림만 확대한다 — 넘치면 잘린다.
     */
    if (l.kind === 'image' && l.cover) {
      const v = Math.max(20, Math.min(400, Math.round(pct)));
      if (sizeBaseId !== l.id) { snapUndo(); setSizeBaseId(l.id); }
      setSizePct(v);
      patch(l.id, { srcZoom: v / 100 });
      setResult(null);
      return;
    }
    if (sizeBaseRef.current?.id !== l.id) {
      snapUndo();
      sizeBaseRef.current = { id: l.id, base: { ...l, points: l.points ? [...l.points] : undefined } };
      setSizeBaseId(l.id);
    }
    const v = Math.max(10, Math.min(400, Math.round(pct)));
    setSizePct(v);
    const base = sizeBaseRef.current.base;
    setLayers((cur) => cur.map((x) => (x.id === l.id ? { ...scaledFrom(base, v / 100), id: x.id } : x)));
    setResult(null);
  }

  function onScaleDown(e: React.PointerEvent, id: string) {
    snapUndo();
    const st = stageRef.current;
    const l = layers.find((x) => x.id === id);
    if (!st || !l) return;
    e.stopPropagation();
    // 손잡이로 끌면 수치 기준을 새로 잡는다 — 끌고 난 크기가 다시 100% 가 된다
    sizeBaseRef.current = null;
    setSizeBaseId(null);
    setSizePct(100);
    const r = st.getBoundingClientRect();
    scaleRef.current = { id, sx: (e.clientX - r.left) / r.width, sy: (e.clientY - r.top) / r.height, start: { ...l, points: l.points ? [...l.points] : undefined } };
    setSelected(id);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  /** 무대에서 이미지(빈 곳 포함)를 잡아 끌면 배경 위치가 움직인다 — cover 크롭에서 남는 축만 */
  function onBgDown(e: React.PointerEvent) {
    // 레이어 손잡이를 잡았으면(자식에서 dragRef 세팅됨) 배경은 건드리지 않는다
    if (dragRef.current || !imageUrl || !stageRef.current) return;
    /*
     * 캔버스 밖으로 밀어내기(pan)는 A안·B안 배치에서만 연다 (사용자 지정).
     * 그 외 배치에서는 예전 그대로 — 잘리는 여백이 없으면 아예 잡히지 않는다.
     */
    /*
     * 이미지 칸(cover) 위를 눌렀으면 배경이 아니라 그 칸의 사진을 민다 —
     * 화면에서 보이는 대로 "누른 그림이 움직인다" 가 맞다 (사용자 지정).
     */
    {
      const r0 = stageRef.current.getBoundingClientRect();
      const nx = (e.clientX - r0.left) / r0.width, ny = (e.clientY - r0.top) / r0.height;
      const hit = [...layers].reverse().find((l) =>
        l.kind === 'image' && l.cover && !l.hidden && l.src
        && Math.abs(nx - (l.x ?? 0.5)) <= (l.w ?? 0) / 2
        && Math.abs(ny - (l.y ?? 0.5)) <= (l.h ?? (l.srcAspect ? (l.w ?? 0.2) * dims.w / l.srcAspect / dims.h : 0.2)) / 2);
      if (hit) {
        snapUndo();
        setSelected(hit.id);
        imgPanRef.current = { id: hit.id, sx: nx, sy: ny, fx0: hit.srcFx ?? 0.5, fy0: hit.srcFy ?? 0.5 };
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        return;
      }
    }
    const panAllowed = stageIsTemplateA() || stageIsTemplateB();
    if (!panAllowed) {
      const k = Math.max(dims.w / src.w, dims.h / src.h) * Math.max(0.4, Math.min(4, fitZoom));
      if (src.w * k - dims.w <= 1 && src.h * k - dims.h <= 1) return;
    }
    const r = stageRef.current.getBoundingClientRect();
    bgDragRef.current = {
      sx: (e.clientX - r.left) / r.width, sy: (e.clientY - r.top) / r.height,
      fx0: fx, fy0: fy, px0: fitPanX, py0: fitPanY, pan: panAllowed,
    };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }

  function onMove(e: React.PointerEvent) {
    // 이미지 칸 안에서 끄는 중 — 칸은 그대로, 안의 사진만 민다 (넘치는 부분은 잘린다)
    const im = imgPanRef.current;
    if (im && stageRef.current) {
      const l = layers.find((x) => x.id === im.id);
      if (l) {
        const r = stageRef.current.getBoundingClientRect();
        const w = (l.w ?? 0.2) * dims.w;
        const h = l.h != null ? l.h * dims.h : (l.srcAspect ? w / l.srcAspect : 0.2 * dims.h);
        const a = l.srcAspect ?? 1;
        const z = Math.max(0.2, Math.min(6, l.srcZoom ?? 1));
        const wide = w / h > a;
        const iw = (wide ? w : h * a) * z;
        const ih = (wide ? w / a : h) * z;
        const dnx = ((e.clientX - r.left) / r.width - im.sx) * dims.w;   // 캔버스 px 이동량
        const dny = ((e.clientY - r.top) / r.height - im.sy) * dims.h;
        const ovX = iw - w, ovY = ih - h;
        const cl = (v: number) => Math.max(-0.5, Math.min(1.5, v));
        /*
         * 넘칠 때(ov>0)는 "보이는 부분"을 고르는 것이고, 칸보다 작을 때(ov<0)는
         * 칸 안에서 사진의 자리를 잡는 것이다 — 부호가 반대일 뿐 식은 같아서 절댓값으로 판단한다.
         */
        patch(im.id, {
          srcFx: Math.abs(ovX) > 1 ? cl(im.fx0 - dnx / ovX) : im.fx0,
          srcFy: Math.abs(ovY) > 1 ? cl(im.fy0 - dny / ovY) : im.fy0,
        });
        setResult(null);
      }
      return;
    }
    // 비율 유지 크기 조절 — 오른쪽·아래로 끌면 커지고, 반대로 끌면 상하좌우가 같이 줄어든다
    const sc = scaleRef.current;
    if (sc && stageRef.current) {
      const r = stageRef.current.getBoundingClientRect();
      const dn = ((e.clientX - r.left) / r.width - sc.sx) + ((e.clientY - r.top) / r.height - sc.sy);
      const k = Math.max(0.15, Math.min(5, 1 + dn * 1.6));
      setLayers((cur) => cur.map((l) => {
        if (l.id !== sc.id) return l;
        /*
         * 이미지 칸(cover)은 최종 자리·크기가 고정이다 — 손잡이로 끌어도 칸을 키우지 않고
         * 안의 사진만 확대·축소한다 (넘치면 잘림). 칸까지 커지면 옆 영역을 침범한다.
         */
        if (l.kind === 'image' && l.cover) {
          return { ...l, srcZoom: Math.max(0.2, Math.min(6, (sc.start.srcZoom ?? 1) * k)) };
        }
        return { ...scaledFrom(sc.start, k), id: l.id };
      }));
      setResult(null);
      return;
    }
    const b = bgDragRef.current;
    if (b && !dragRef.current && stageRef.current) {
      // 포인터가 끈 만큼 이미지가 따라온다 — 숨어 있는 폭/높이 대비 비율로 환산
      const r = stageRef.current.getBoundingClientRect();
      const zoom = Math.max(0.4, Math.min(4, fitZoom));   // cover 도 40% 까지 줄일 수 있다
      const baseK = fitMode === 'cover'
        ? Math.max(dims.w / src.w, dims.h / src.h)
        : Math.min(dims.w / src.w, dims.h / src.h);
      const fgW = src.w * baseK * zoom * Math.max(0.15, Math.min(4, fitZoomX));
      const fgH = src.h * baseK * zoom * Math.max(0.15, Math.min(4, fitZoomY));
      const dnx = (e.clientX - r.left) / r.width - b.sx;
      const dny = (e.clientY - r.top) / r.height - b.sy;
      /*
       * 사진의 왼쪽 끝 위치(px) 를 기준으로 계산한다.
       *   먼저 "잘리는 여백" 안(fx/fy)에서 움직이고, 그 끝을 넘어가면 나머지를 pan 이 받는다.
       *   → 여백이 있을 땐 예전처럼 빈틈 없이 슬라이드, 여백이 없거나 다 쓰면 밖으로 밀린다.
       */
      const slide = (axis: 'x' | 'y') => {
        const size = axis === 'x' ? dims.w : dims.h;
        const fgSize = axis === 'x' ? fgW : fgH;
        const f0 = axis === 'x' ? b.fx0 : b.fy0;
        const p0 = axis === 'x' ? b.px0 : b.py0;
        const dn = axis === 'x' ? dnx : dny;
        const span = size - fgSize;                       // cover 면 음수(=잘리는 여백)
        const wantRaw = f0 * span + p0 * size + dn * size;   // 옮기고 싶은 위치(px)
        /*
         * 사진이 화면에서 통째로 사라지지는 않게 막는다 (사용자 지정) —
         * 어느 방향으로 밀어도 캔버스의 최소 30% 는 사진이 덮고 있어야 한다.
         */
        const minVis = size * 0.3;
        const want = b.pan
          ? Math.max(minVis - fgSize, Math.min(size - minVis, wantRaw))
          : wantRaw;
        const lo = Math.min(0, span), hi = Math.max(0, span);
        const within = Math.max(lo, Math.min(hi, want));  // 여백 안에서 가능한 만큼
        const f = Math.abs(span) > 0.5 ? within / span : f0;
        // A안·B안이 아니면 여백 밖으로는 안 나간다 (pan 을 0 으로 눌러 둔다)
        const p = b.pan ? Math.max(-1.2, Math.min(1.2, (want - within) / size)) : 0;
        return { f: Math.max(0, Math.min(1, f)), p };
      };
      const X = slide('x'), Y = slide('y');
      setFx(X.f); setFitPanX(X.p);
      setFy(Y.f); setFitPanY(Y.p);
      setFocusTouched(true);
      setResult(null);
      return;
    }
    const d = dragRef.current, st = stageRef.current;
    if (!d || !st) return;
    const r = st.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width - d.dx));
    const ny = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height - d.dy));
    /*
     * 한 무리는 통째로 옮긴다. 대표가 움직인 만큼 나머지도 같이 민다 —
     * 각자 따로 걸리면 버튼의 알약·글자·화살표가 옮길 때마다 어긋난다.
     * 따라가는 조각은 자르지 않는다. 자르면 무리의 모양이 뭉개진다.
     */
    setLayers((cur) => {
      const lead = cur.find((l) => l.id === d.id);
      if (!lead) return cur;
      const ddx = nx - lead.x;
      const ddy = ny - lead.y;
      const g = groupOf(lead);
      return cur.map((l) => (groupOf(l) === g ? { ...l, x: l.x + ddx, y: l.y + ddy } : l));
    });
  }
  const onUp = () => { dragRef.current = null; bgDragRef.current = null; scaleRef.current = null; imgPanRef.current = null; };

  /**
   * 자동 배치 — 규격의 비율을 보고, 배경에서 비어 있는 곳에 읽히는 색으로 얹는다.
   * 디자이너가 아닌 사람이 쓰는 도구라 이게 기본 동선이다.
   * 결과가 마음에 안 들면 4단계에서 손으로 고치면 된다.
   */
  const autoLayout = useCallback(async (again = false) => {
    if (!imageUrl) { setErr('배경 컷을 골라주세요.'); return; }
    setBusy('auto'); setErr(''); setNote('');
    try {
      const wantAutoFocus = fitMode === 'cover' && !focusTouched;
      const r = await fetch('/api/design', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          auto: {
            imageUrl, eyebrow: autoEyebrow, title: autoTitle, subtitle: autoSub, cta: autoCta,
            size: { id: sizeId || undefined, w: dims.w, h: dims.h }, fit,
            autoFocus: wantAutoFocus,
            buttonColor: btnColor === 'photo' ? undefined : brandButtonHex(btnColor),
            tune: { scale: tuneScale, gap: tuneGap },
          },
        }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || '실패'); return; }
      // 서버가 피사체를 보고 정한 자르기 위치 — 미리보기가 같은 숫자로 잘라야 해서 받아온다
      if (wantAutoFocus && j.fit) {
        applyingFocus.current = true;
        setFx(j.fit.fx);
        setFy(j.fit.fy);
      }
      setLayers(j.layers);
      setPicked(j.picked);
      setSelected(null);
      setResult(null);
      const kind = j.picked.shape === 'wide' ? '가로형' : j.picked.shape === 'tall' ? '세로형' : '정사각';
      setNote(`${again ? '규격이 바뀌어 다시 잡았습니다 — ' : ''}${kind} ${dims.w}×${dims.h}, `
        + `${j.picked.where} 여백에 배치 `
        + `(${j.picked.light ? '밝은 배경이라 짙은 글씨' : '어두운 배경이라 흰 글씨'}).`);
      // 짝 버전도 같은 문구로 조용히 최신화 — 탭을 눌렀을 때 옛 문구가 남아 있으면 안 된다
      const partner = AUTO_SET[channel].find((id) => id !== sizeId);
      if (partner) {
        fetchAutoFor(partner)
          .then((got) => setVariants((v) => ({ ...v, [partner]: got })))
          .catch(() => { /* 짝 최신화 실패는 조용히 — 탭 전환 때 다시 받는다 */ });
      }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchAutoFor 는 렌더마다 새로 만들어지는 평범한 함수라 넣으면 의미 없이 매번 재생성만 된다. channel 은 짝 최신화가 낡은 채널을 잡지 않게 반드시 넣는다
  }, [imageUrl, autoEyebrow, autoTitle, autoSub, autoCta, sizeId, dims, fit, fitMode, focusTouched, btnColor, tuneScale, tuneGap, channel]);

  /*
   * 규격이나 자르기를 바꾸면 배치를 다시 잡는다.
   *
   * 좌표가 0~1 비율이라 규격이 바뀌어도 '깨지진' 않는다. 하지만 가로형과 정사각은
   * 애초에 배치 규칙이 다르다 — 가로형은 옆에 세우고 정사각은 위아래로 쌓는다.
   * 규격만 바꿔놓고 배치가 그대로면 쓰는 사람은 왜 어색한지 알 수가 없다.
   *
   * 손으로 옮긴 배치는 건드리지 않는다 (자동으로 만든 레이어만 다시 잡는다).
   * layers 를 의존성에 넣으면 자기가 부른 setLayers 때문에 무한히 돌기 때문에 ref 로 읽는다.
   */
  const layersRef = useRef(layers);
  const autoRef = useRef(autoLayout);
  // 렌더 중에 ref 를 건드리면 안 되므로 커밋 뒤에 최신값으로 맞춘다.
  // 아래 효과보다 먼저 선언돼 있어서 같은 커밋에서 항상 먼저 돈다
  useEffect(() => { layersRef.current = layers; autoRef.current = autoLayout; });
  // 불러온 배치를 첫 렌더에서 덮어쓰지 않도록 한 번 걸러낸다
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    // 서버가 정해준 초점을 슬라이더에 옮긴 것뿐이면 또 돌 필요가 없다 — 돌면 무한 왕복한다
    if (applyingFocus.current) { applyingFocus.current = false; return; }
    const cur = layersRef.current;
    if (!imageUrl || cur.length === 0 || !cur.every(isAuto)) return;
    const t = setTimeout(() => { autoRef.current(true); }, 500);   // 슬라이더를 끄는 동안 매번 부르지 않게
    return () => clearTimeout(t);
  }, [sizeId, fitMode, fx, fy, fillColor, imageUrl, btnColor, tuneScale, tuneGap]);

  async function render(save: boolean) {
    if (!imageUrl) { setErr('배경 컷을 골라주세요.'); return; }
    setBusy('save'); setErr(''); setNote('');
    try {
      const r = await fetch('/api/design', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ design, save, sourceId }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || '실패'); return; }
      if (save) { setNote('저장했습니다. 배너 디자인 관리에서 볼 수 있습니다.'); setResult(null); }
      else setResult({ kind: 'single', preview: j.preview, w: j.width, h: j.height });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  /**
   * 내 이미지를 배경으로 올린다.
   *
   * 서버가 배경을 URL 로 받아 처리하므로 공개된 자리에 올라가야 한다 — cafe24 FTP.
   * register=0 을 붙여 레퍼런스 보관함에는 넣지 않는다. 이건 스타일 참고가 아니라
   * 이 배너의 재료일 뿐이다.
   */
  async function uploadBackground(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    setBusy('upload'); setErr(''); setNote('');
    try {
      const shrunk = await shrinkForUpload(f);
      const fd = new FormData();
      fd.append('file', shrunk.file);
      fd.append('title', f.name);
      fd.append('register', '0');
      const j = await (await fetch('/api/upload', { method: 'POST', body: fd })).json();
      if (!j.ok) { setErr(j.error || '업로드 실패'); return; }
      const row: CutOption = { id: j.url, url: j.url, label: f.name };
      saveMine([row, ...mine.filter((m) => m.url !== j.url)]);
      setImageUrl(j.url);
      setResult(null);
      setVariants({});                                   // 배경이 바뀌면 옛 배치는 소용없다
      setNote(`"${f.name}" 을(를) 배경으로 올렸습니다. (${j.width}×${j.height})`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  /**
   * 웹+모바일 짝 저장 — 3단계 문구로 두 규격을 서버가 자동 배치해 한 번에 만든다.
   * 배너는 항상 짝으로 나가는 물건이라 이게 실전의 기본 동선이다.
   * 손으로 다듬은 배치는 여기 안 들어간다 (규격마다 배치가 다시 잡히므로).
   */
  /**
   * 짝 규격들 각각의 설계도 — 무대의 것 + 보관함(버전 탭)의 것을 모으고,
   * 아직 안 만든 버전은 그 자리에서 만들어 채운다:
   * 무대가 A안이면 그 규격의 A안(문구 이어받음)으로, 아니면 서버 자동 배치로.
   * "저장 한 번 = 웹·모바일 두 장"을 위해 밖의 버튼을 줄인 대신 여기가 빈 곳을 채운다.
   */
  async function pairDocs(): Promise<{ sizeId: string; label: string; w: number; h: number; design: DesignDoc }[]> {
    const out: { sizeId: string; label: string; w: number; h: number; design: DesignDoc }[] = [];
    for (const sid of AUTO_SET[channel]) {
      const b = findSize(sid);
      let doc = sid === sizeId
        ? (layers.length ? { layers, fit } : null)
        : variants[sid] ?? null;
      if (!doc || !doc.layers.length) {
        const texts = Object.fromEntries(
          layers.filter((l) => l.kind === 'text' && l.name).map((l) => [l.name as string, l.text ?? '']),
        );
        const pairFit = variants[sid]?.fit ?? fit;   // 그 버전이 갖고 있던 배경 상태 우선
        if (stageIsTemplateA()) doc = { layers: templateASeeds(b.w, b.h, texts, mobStyle), fit: pairFit };
        else if (stageIsTemplateB()) doc = { layers: templateBSeeds(b.w, b.h, texts), fit: pairFit };
        else doc = await fetchAutoFor(sid);
        const filled = doc;
        setVariants((v) => ({ ...v, [sid]: filled }));
      } else if (sid !== sizeId
                 && layers.some((l) => l.kind === 'text' && l.name === '타이틀')
                 && doc.layers.some((l) => l.kind === 'text' && l.name === '타이틀')) {
        // 짝 버전도 같은 시안(이름 붙은 문구 레이어)이면 문구만 무대 것으로 맞춘다 — 배치 손질은 보존
        const texts = new Map(layers.filter((l) => l.kind === 'text' && l.name).map((l) => [l.name as string, l.text ?? '']));
        doc = {
          ...doc,
          layers: doc.layers.map((l) => (l.kind === 'text' && l.name && texts.has(l.name) ? { ...l, text: texts.get(l.name)! } : l)),
        };
      }
      out.push({
        sizeId: sid, label: b.label, w: b.w, h: b.h,
        design: { imageUrl, layers: doc.layers, size: { id: sid, w: b.w, h: b.h }, fit: doc.fit, font: fontFamily || undefined },
      });
    }
    return out;
  }

  async function saveBoth(previewOnly: boolean) {
    if (!imageUrl) { setErr('배경 컷을 골라주세요.'); return; }
    setBusy('save'); setErr(''); setNote('');
    try {
      /*
       * 저장 = 항상 웹·모바일 짝. 손본 버전은 그 배치 그대로,
       * 아직 안 만든 버전은 pairDocs 가 그 자리에서 채워온다 (A안 연장 또는 자동 배치).
       * 결과 팝업에서 두 장을 눈으로 확인한 뒤에야 실제 저장된다.
       */
      const local = await pairDocs();
      if (previewOnly) {
        const items = [];
        for (const it of local) {
          const r = await fetch('/api/design', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ design: it.design, save: false }),
          });
          const j = await r.json();
          if (!j.ok) { setErr(j.error || '실패'); return; }
          items.push({
            label: it.label, w: it.w, h: it.h, preview: j.preview,
            sizeId: it.sizeId, layers: it.design.layers, fit: it.design.fit!,
          });
        }
        setResult({ kind: 'pair', items });
        return;
      }
      const pairId = uid();
      for (const it of local) {
        const r = await fetch('/api/design', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            design: it.design, save: true, sourceId, pairId,
            title: `${autoTitle || '배너'} — ${it.label}`,
          }),
        });
        const j = await r.json();
        if (!j.ok) { setErr(j.error || '실패'); return; }
      }
      setNote(`짝으로 저장했습니다 — ${local.map((i) => `${i.label} ${i.w}×${i.h}`).join(' · ')}. 배너 디자인 관리에서 볼 수 있습니다.`);
      setResult(null);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  /*
   * 템플릿 이름 — window.prompt 는 Next dev 가 막는다.
   * 버튼을 누르면 인라인 입력이 열리고, Enter 로 저장한다.
   */
  const [tplNaming, setTplNaming] = useState(false);
  /** A안(이미지 2분할)의 우측 이미지 URL */
  const [rightImg, setRightImg] = useState('');
  /** 우측 이미지 원본 비율 (w/h) — 슬롯 안에서 보여줄 부분을 옮기려면 이게 있어야 한다 */
  const [rightAspect, setRightAspect] = useState<number | undefined>(undefined);
  /** 모바일 A안 하단 처리 — 그늘형(Luxe, 사진 위 그라데이션) / 밴드형(Modju, 단색 블록) */
  const [mobStyle, setMobStyle] = useState<'scrim' | 'band'>('scrim');
  const [tplName, setTplName] = useState('');
  /** dataURI 를 가로 max 픽셀로 줄인 JPEG dataURI 로 — 템플릿 썸네일용 */
  async function shrinkDataUrl(dataUrl: string, max: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const img = new window.Image();
      img.onload = () => {
        const k = Math.min(1, max / (img.naturalWidth || max));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round((img.naturalWidth || max) * k));
        c.height = Math.max(1, Math.round((img.naturalHeight || max) * k));
        const ctx = c.getContext('2d');
        if (!ctx) return resolve(undefined);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = () => resolve(undefined);
      img.src = dataUrl;
    });
  }

  /** 저장해둔 배치를 지금 컷에 올린다 — 배경은 그대로, 문구·도형만 갈아 끼운다 */
  function applySavedTemplate(t: SavedTemplate) {
    snapUndo();
    setLayers(t.design.layers.map((l) => ({ ...l, id: uid() })));
    setSelected(null);
    setResult(null);
    setNote(`템플릿 "${t.name}" 배치를 올렸습니다 — 문구만 고쳐 쓰면 됩니다.`);
  }

  /** 템플릿 삭제 — 목록에서만 지운다 (지금 무대의 배치는 그대로) */
  async function removeSavedTemplate(t: SavedTemplate) {
    setBusy('tpl');
    try {
      const j = await (await fetch('/api/design', {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: t.id }),
      })).json();
      if (j.ok) { setNote(`템플릿 "${t.name}" 을 지웠습니다.`); loadTemplates(); }
      else setErr(j.error || '삭제 실패');
    } finally { setBusy(null); }
  }

  async function saveTemplate() {
    const name = tplName.trim();
    if (!name) { setTplNaming(true); return; }
    setTplNaming(false); setTplName('');
    setBusy('tpl');
    try {
      /*
       * 썸네일 — 이름만으론 어떤 배치인지 못 고른다. 지금 화면을 그대로 한 장 구워
       * 캔버스로 240px 까지 줄여 담는다 (원본 미리보기는 수백 KB 라 그대로는 못 넣는다).
       */
      let thumb: string | undefined;
      try {
        const pv = await (await fetch('/api/design', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ design, save: false }),
        })).json();
        if (pv?.ok && pv.preview) thumb = await shrinkDataUrl(pv.preview, 240);
      } catch { /* 썸네일은 없어도 저장은 된다 */ }
      const r = await fetch('/api/design', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, design, ...(thumb ? { thumb } : {}) }),
      });
      const j = await r.json();
      if (j.ok) { setNote(`템플릿 "${name}" 저장됨`); loadTemplates(); }
      else setErr(j.error || '실패');
    } finally { setBusy(null); }
  }

  // ── 선택한 무리 — 버튼(알약+글자+화살표)은 조각이 아니라 한 몸으로 고친다 ──
  const selGroup = sel?.group ?? null;
  const grpLayers = selGroup ? layers.filter((l) => l.group === selGroup) : [];
  const btnLabel = grpLayers.find((l) => l.kind === 'text') ?? null;
  const btnPill = grpLayers.find((l) => l.kind === 'rect') ?? null;
  const btnArrow = grpLayers.find((l) => l.kind === 'icon') ?? null;
  const isSel = (l: DesignLayer) => !!sel && groupOf(l) === groupOf(sel);

  /*
   * 두 번 누르면 편집으로 — 고치는 자리(맨 위 패널)로 데려가 문구에 초점을 준다.
   * focusTick 이 카운터인 이유: 같은 레이어를 다시 두 번 눌러도 또 와야 한다.
   */
  const inspectorRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    if (!focusTick) return;
    // 목록 바로 아래에 펴지므로 화면을 옮기지 않는다 — 필요한 만큼만 살짝 보이게
    inspectorRef.current?.scrollIntoView({ block: 'nearest' });
    textRef.current?.focus();
    textRef.current?.select?.();
  }, [focusTick]);

  /** 우측 이미지 고르기 팝업 (직접 올리기·레퍼런스·생성 컷) */
  function openRightPicker() {
    setBrowseFor('right');
    setBrowsePage(0);
    setBrowseOpen(true);
  }

  /** 아직 사진이 없는 "우측 이미지 자리"(회색 칸)를 가리키는 좌표인가 */
  function placeholderAt(nx: number, ny: number) {
    return layers.find((l) =>
      l.kind === 'rect' && l.name?.startsWith('우측 이미지 자리')
      && Math.abs(nx - (l.x ?? 0.5)) <= (l.w ?? 0) / 2
      && Math.abs(ny - (l.y ?? 0.5)) <= (l.h ?? 0) / 2);
  }

  function openInspector(id: string) {
    // 빈 이미지 칸은 속성 편집이 아니라 "사진 고르기" 가 하고 싶은 일이다
    const l = layers.find((x) => x.id === id);
    if (l?.kind === 'rect' && l.name?.startsWith('우측 이미지 자리')) { openRightPicker(); return; }
    setSelected(id);
    setFocusTick((n) => n + 1);
  }

  /** 버튼 문구·크기를 고치면 같은 계산으로 알약도 다시 잰다 — 글자가 삐져나오면 안 된다 */
  function setBtn(next: Partial<DesignLayer>) {
    if (!btnLabel || !selGroup) return;
    setLayers((cur) => relayoutButton(
      cur.map((l) => (l.id === btnLabel.id ? { ...l, ...next } : l)),
      selGroup, dims.w, dims.h,
    ));
    setResult(null);
  }

  /** 버튼의 글자와 화살표는 같은 색이어야 한다 — 그리고 두 버전에 같이 들어간다 */
  function setBtnInk(color: string) {
    if (!selGroup) return;
    setLayers((cur) => cur.map((l) => (
      l.group === selGroup && (l.kind === 'text' || l.kind === 'icon') ? { ...l, color } : l
    )));
    setVariants((v) => {
      const out: typeof v = {};
      for (const [k, doc] of Object.entries(v)) {
        out[k] = { ...doc, layers: doc.layers.map((l) => (
          l.group === selGroup && (l.kind === 'text' || l.kind === 'icon') ? { ...l, color } : l
        )) };
      }
      return out;
    });
  }

  const num = (label: string, v: number, min: number, max: number, step: number, on: (n: number) => void, fmt?: (n: number) => string) => (
    <label className="block mb-2">
      <div className="flex justify-between text-[10.5px] mb-0.5" style={{ color: 'var(--text-mute)' }}>
        <span>{label}</span><span className="tabular-nums">{fmt ? fmt(v) : v.toFixed(3)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={v} className="w-full"
             onChange={(e) => on(Number(e.target.value))} />
    </label>
  );

  /*
   * 선택한 것을 고치는 자리.
   *
   * "화면에 올라간 요소" 목록 바로 아래에 편다 — 고른 자리에서 그대로 고치는 게
   * 자연스럽고, 맨 위로 올라가면 화면이 튀어 어디를 보고 있었는지 놓친다.
   */
  const inspector = !sel ? null : (
    <div ref={inspectorRef} className="card p-3 mb-3" style={{ borderColor: 'var(--accent-dim)' }}>
      <div className="flex items-center justify-between mb-2">
        <div className="label" style={{ color: 'var(--text-dim)' }}>{labelOf(sel, layers)}</div>
        <button className="chip" onClick={() => setSelected(null)} title="선택 해제">닫기</button>
      </div>

      {btnLabel && btnPill ? (
        /* 버튼은 한 몸이라 조각별로 만지게 하지 않는다 — 문구·크기·색만 준다 */
        <>
          <input ref={textRef as unknown as React.RefObject<HTMLInputElement>}
                 className="input py-1 text-[12px] mb-2" value={btnLabel.text ?? ''}
                 placeholder="버튼 문구"
                 onChange={(e) => setBtn({ text: e.target.value })} />
          {num('글자 크기', btnLabel.size ?? 0.03, 0.012, 0.09, 0.001,
               (n) => setBtn({ size: n }), (n) => `${(n * 100).toFixed(1)}%`)}
          {num('모서리', btnPill.radius ?? 0.06, 0, 0.2, 0.005,
               (n) => patch(btnPill.id, { radius: n }), (n) => n.toFixed(3))}
          {/* 버튼을 한 몸으로 묶으면서 사라졌던 아이콘 바꾸기 — 무리 패널에서 바로 고른다 */}
          {btnArrow && (
            <>
              <div className="label mb-1 mt-1">아이콘</div>
              <div className="flex flex-wrap gap-1 mb-2">
                {Object.entries(ICONS).map(([key, v]) => (
                  <button key={key} className="chip" title={v.label}
                          style={btnArrow.icon === key ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
                          onClick={() => patch(btnArrow.id, { icon: key })}>
                    {v.label}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="label mb-1 mt-1">버튼 색 <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>— 두 버전에 같이</span></div>
          <div className="flex items-center gap-2 mb-2">
            <input type="color" value={btnPill.color}
                   onChange={(e) => patchColor(btnPill.id, e.target.value)}
                   style={{ width: 40, height: 28, padding: 0, border: '1px solid var(--line)', borderRadius: 'var(--radius)', background: 'none' }} />
            <div className="flex gap-1 flex-wrap">
              {[...new Set([theme.accent, theme.strong, theme.scrim, '#2f3a5c'])].map((c) => (
                <button key={c} onClick={() => patchColor(btnPill.id, c)} title={c}
                        className="w-6 h-6 rounded" style={{ background: c, border: '1px solid var(--line)' }} />
              ))}
            </div>
          </div>
          <div className="label mb-1">글자 색</div>
          <div className="flex items-center gap-2">
            <input type="color" value={btnLabel.color}
                   onChange={(e) => setBtnInk(e.target.value)}
                   style={{ width: 40, height: 28, padding: 0, border: '1px solid var(--line)', borderRadius: 'var(--radius)', background: 'none' }} />
            <div className="flex gap-1 flex-wrap">
              {['#ffffff', '#1b1d21'].map((c) => (
                <button key={c} onClick={() => setBtnInk(c)} title={c}
                        className="w-6 h-6 rounded" style={{ background: c, border: '1px solid var(--line)' }} />
              ))}
            </div>
          </div>
        </>
      ) : (
        <>

        {sel.kind === 'text' && (
          <>
            <textarea ref={textRef as unknown as React.RefObject<HTMLTextAreaElement>} className="input text-[12px] mb-2" style={{ height: 62 }} value={sel.text ?? ''}
                      placeholder="문구 (줄바꿈 가능)"
                      onChange={(e) => patch(sel.id, { text: e.target.value })} />
            {num('글자 크기', sel.size ?? 0.06, 0.015, 0.2, 0.002, (n) => patch(sel.id, { size: n }), (n) => `${(n * 100).toFixed(1)}%`)}
            {num('굵기', sel.weight ?? 700, 300, 900, 100, (n) => patch(sel.id, { weight: n }), (n) => String(n))}
            {num('자간', sel.tracking ?? 0, -0.05, 0.2, 0.005, (n) => patch(sel.id, { tracking: n }), (n) => n.toFixed(3))}
            {num('줄 간격', sel.lineHeight ?? 1.25, 0.9, 2, 0.05, (n) => patch(sel.id, { lineHeight: n }), (n) => n.toFixed(2))}
            {num('곡선 (반달)', sel.curve ?? 0, -1, 1, 0.02, (n) => patch(sel.id, { curve: n }), (n) => n.toFixed(2))}
            <div className="flex gap-1.5 mb-2">
              {(['start', 'middle', 'end'] as const).map((a) => (
                <button key={a} className="chip flex-1 justify-center"
                        style={sel.align === a ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
                        onClick={() => patch(sel.id, { align: a })}>
                  {a === 'start' ? '왼쪽' : a === 'middle' ? '가운데' : '오른쪽'}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-[11px] mb-2" style={{ color: 'var(--text-dim)' }}>
              <input type="checkbox" checked={!!sel.shadow} onChange={(e) => patch(sel.id, { shadow: e.target.checked })} />
              글자 외곽 그림자 (밝은 배경에서 안 날아가게)
            </label>
          </>
        )}

        {sel.kind === 'icon' && (
          <>
            <div className="flex flex-wrap gap-1 mb-2">
              {Object.entries(ICONS).map(([k, v]) => (
                <button key={k} className="chip" title={v.label}
                        style={sel.icon === k ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
                        onClick={() => patch(sel.id, { icon: k })}>{v.label}</button>
              ))}
            </div>
            {num('크기', sel.size ?? 0.06, 0.015, 0.25, 0.002, (n) => patch(sel.id, { size: n }), (n) => `${(n * 100).toFixed(1)}%`)}
            {num('선 굵기', sel.stroke ?? 0.09, 0.02, 0.2, 0.005, (n) => patch(sel.id, { stroke: n }), (n) => n.toFixed(3))}
          </>
        )}

        {(sel.kind === 'rect' || sel.kind === 'scrim') && (
          <>
            {num('가로', sel.w ?? 0.4, 0.05, 1, 0.01, (n) => patch(sel.id, { w: n }), (n) => `${(n * 100).toFixed(0)}%`)}
            {num('세로', sel.h ?? 0.1, 0.02, 1, 0.01, (n) => patch(sel.id, { h: n }), (n) => `${(n * 100).toFixed(0)}%`)}
            {sel.kind === 'rect' && num('모서리', sel.radius ?? 0, 0, 0.2, 0.005, (n) => patch(sel.id, { radius: n }), (n) => n.toFixed(3))}
            {/*
              * 그늘 방향에 좌/우가 있어야 한다 — 가로형 배너의 자동 배치가
              * 좌우 그라데이션을 만들기 때문에, 여기서 위/아래만 고를 수 있으면
              * 손대는 순간 배치가 깨진다.
              */}
            {sel.kind === 'scrim' && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {(['top', 'bottom', 'left', 'right', 'none'] as const).map((d) => (
                  <button key={d} className="chip justify-center"
                          style={{
                            ...(sel.direction === d ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}),
                            flex: '1 1 28%',
                          }}
                          onClick={() => patch(sel.id, { direction: d })}>
                    {d === 'top' ? '위' : d === 'bottom' ? '아래' : d === 'left' ? '왼쪽' : d === 'right' ? '오른쪽' : '균일'}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {num('불투명도', sel.opacity ?? 1, 0, 1, 0.02, (n) => patch(sel.id, { opacity: n }), (n) => `${(n * 100).toFixed(0)}%`)}
        {num('회전', sel.rotate ?? 0, -45, 45, 1, (n) => patch(sel.id, { rotate: n }), (n) => `${n}°`)}

        <div className="label mb-1 mt-2">색 <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>— 두 버전에 같이 적용</span></div>
        <div className="flex items-center gap-2">
          <input type="color" value={sel.color} onChange={(e) => patchColor(sel.id, e.target.value)}
                 style={{ width: 40, height: 28, padding: 0, border: '1px solid var(--line)', borderRadius: 6, background: 'none' }} />
          <div className="flex gap-1 flex-wrap">
            {/* 같은 색이 두 칸 나오면 키도 겹치고 보기에도 무의미하다 — 겹침을 걷어낸다 */}
            {[...new Set([theme.strong, theme.soft, theme.accent, theme.accentText, theme.scrim])].map((c) => (
              <button key={c} onClick={() => patchColor(sel.id, c)} title={c}
                      className="w-6 h-6 rounded" style={{ background: c, border: '1px solid var(--line)' }} />
            ))}
          </div>
        </div>
        </>
      )}
    </div>
  );

  /*
   * 배경 미리보기 스타일 — 서버 fitToSize 와 같은 식.
   * zoom=1 이면 기존 object-fit 경로(완전 동일 결과), zoom≠1 이면 명시 크기·위치로 그린다.
   * 보정(adjust)은 CSS filter 로 — 서버 sharp 값과 같은 의미라 화면=저장본.
   */
  const adjFilter = fitAdjust
    ? `brightness(${fitAdjust.brightness ?? 1}) contrast(${fitAdjust.contrast ?? 1}) saturate(${fitAdjust.saturate ?? 1})`
    : '';
  const bgImgStyle: React.CSSProperties = (() => {
    if (fitZoom === 1 && fitZoomX === 1 && fitZoomY === 1 && !fitPanX && !fitPanY) {   // 변형이 하나도 없을 때만 빠른 경로
      return {
        inset: 0, width: '100%', height: '100%',
        objectFit: needsFit && fitMode !== 'cover' ? 'contain' : 'cover',
        objectPosition: `${Math.round(fx * 100)}% ${Math.round(fy * 100)}%`,
        ...(adjFilter ? { filter: adjFilter } : {}),
      };
    }
    const zoom = Math.max(0.4, Math.min(4, fitZoom));   // cover 도 40% 까지 줄일 수 있다
    const baseK = fitMode === 'cover'
      ? Math.max(dims.w / src.w, dims.h / src.h)
      : Math.min(dims.w / src.w, dims.h / src.h);
    const k = baseK * zoom;
    const fgW = src.w * k * Math.max(0.15, Math.min(4, fitZoomX));
    const fgH = src.h * k * Math.max(0.15, Math.min(4, fitZoomY));
    return {
      width: `${(fgW / dims.w) * 100}%`, height: `${(fgH / dims.h) * 100}%`,
      left: `${((fx * (dims.w - fgW)) / dims.w + fitPanX) * 100}%`,
      top: `${((fy * (dims.h - fgH)) / dims.h + fitPanY) * 100}%`,
      maxWidth: 'none',
      ...(adjFilter ? { filter: adjFilter } : {}),
    };
  })();

  /** hex 를 밝게(+)/어둡게(-) — 미리보기 그라데이션이 서버와 같아지게 서버 shift 와 동일 규칙 */
  function shade(hex: string, d: number): string {
    const h = /^#?[0-9a-fA-F]{6}$/.test(hex) ? hex.replace('#', '') : 'f2f0ec';
    const cl = (v: number) => Math.max(0, Math.min(255, v + d));
    const r = cl(parseInt(h.slice(0, 2), 16)), g = cl(parseInt(h.slice(2, 4), 16)), b = cl(parseInt(h.slice(4, 6), 16));
    return `rgb(${r},${g},${b})`;
  }

  /** 배경 사진의 평균색을 뽑아 채울 색으로 — 여백이 사진과 자연스럽게 이어진다 */
  function sampleFillFromImage() {
    if (!imageUrl) return;
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = 16; cv.height = 16;
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, 16, 16);
        const d = ctx.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        const hx = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
        setFillColor(`#${hx(r)}${hx(g)}${hx(b)}`);
        setResult(null);
      } catch { /* 교차출처로 캔버스가 막히면 색 선택은 수동으로 */ }
    };
    img.src = imageUrl;
  }

  const sizeName = sizeId ? findSize(sizeId).label : '컷 크기 그대로';
  // 짝 저장 묶음의 이름과 크기 — 저장 버튼 설명에 그대로 쓴다
  const autoSet = AUTO_SET[channel].map(findSize);
  const autoSetText = autoSet.map((b) => `${b.label} ${b.w}×${b.h}`).join(' · ');
  const shapeWord = shape === 'wide' ? '가로형' : shape === 'tall' ? '세로형' : '정사각';

  return (
    /*
     * 넓은 화면에서는 미리보기를 세워두고 단계만 스크롤한다.
     * 문구를 고치거나 자르는 위치를 옮길 때 결과가 화면 밖으로 나가면
     * 무엇이 바뀌었는지 확인할 수가 없다.
     * items-start 가 없으면 flex 가 자식을 끝까지 늘려서 sticky 가 먹지 않는다.
     */
    <div className="flex flex-col xl:flex-row gap-4 xl:items-start">
      {/*
        * 서버가 렌더에 쓰는 것과 같은 파일을 브라우저에도 물린다.
        * 이게 없으면 작업 화면은 다른 글꼴로 그려져서 배치가 저장본과 어긋난다.
        * Pretendard Variable 은 globals.css 가 이미 woff2 로 물려놨으니 뺀다.
        */}
      {fonts.filter((f) => f.family !== 'Pretendard Variable').map((f) => (
        <style key={f.file}>{`@font-face{font-family:'${f.family.replace(/'/g, '')}';src:url('/api/font/${encodeURIComponent(f.file)}');font-display:swap;}`}</style>
      ))}
      {/* ── 왼쪽: 결과만 크게 (고정) ── */}
      <div className="flex-1 min-w-0 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto">
        <div className="card p-3">
          {/* 지금 무엇을 만들고 있는지 한 줄로 — 규격을 바꿔가며 쓰는 화면이라 필요하다 */}
          <div className="flex items-baseline justify-between gap-2 flex-wrap mb-2">
            <div className="label">작업 화면 — 저장본과 같은 그림</div>
            <div className="text-[10.5px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
              {sizeName} · {dims.w}×{dims.h} · {shapeWord}
              {needsFit && fitMode === 'cover' && ` · 컷의 ${Math.round(loss * 100)}% 잘림`}
              {needsFit && fitMode !== 'cover' && ' · 안 잘림'}
            </div>
          </div>

          {/*
            완성 도구는 무대 위에 둔다. 아래에 두면 세로 배너(480x558)가 화면을
            다 먹었을 때 버튼이 잠겨 스크롤해야 보였다. 저장은 곧바로 하지 않고
            실제 크기 렌더를 확인창으로 보여준 뒤 [이대로 저장] 을 눌러야 한다.
          */}
          <div className="flex gap-2 mb-1 flex-wrap items-center">
            {/* 포토샵 방식 — 템플릿으로 잡은 배치를 정밀하게 다듬는 다음 단계 */}
            <button className="btn" onClick={() => {
                      if (!imageUrl) { setErr('배경 컷을 먼저 골라주세요.'); return; }
                      setErr(''); setEditorOpen(true);
                    }}
                    disabled={!imageUrl}
                    title="피그마·포토샵처럼 레이어를 직접 만지는 전체 화면 편집기 — 텍스트·도형·아이콘·이미지 추가, 드래그·회전·그림자, PC 폰트, Ctrl+Z. 만진 레이어는 돌아와도 유지됩니다.">
              🎨 포토샵 방식
            </button>
            {/* 되돌리기 — 방금 한 조작을 한 단계씩 되짚는다 (최대 20단계) */}
            <button className="btn" onClick={undoLast} disabled={!undoDepth}
                    title={undoDepth ? `이전 작업으로 되돌립니다 (남은 단계 ${undoDepth})` : '되돌릴 작업이 없습니다'}>
              ↩ 이전 작업으로{undoDepth ? ` (${undoDepth})` : ''}
            </button>
            <button className="btn btn-primary" onClick={() => saveBoth(true)} disabled={!!busy || !layers.length || !imageUrl}
                    title={`${autoSetText} 두 버전을 함께 그려 보여드리고, 확인하면 둘 다 저장됩니다. 아직 안 만든 버전은 같은 배치·문구로 채워집니다.`}>
              {busy === 'save' ? '그리는 중…' : '✔ 완성 · 저장'}
            </button>
            {note && <span className="text-[11px]" style={{ color: 'var(--ok)' }}>{note}</span>}
            {err && <span className="text-[11px]" style={{ color: 'var(--danger)' }}>{err}</span>}
          </div>
          {/* 저장 하나로 끝낸다 — 누르면 두 버전을 나란히 보여주고, 확인해야 둘 다 저장 */}
          <div className="text-[10.5px] mb-2 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            <b>완성 · 저장</b> = {channel}용 두 규격({autoSetText})을 나란히 보여드리고, 확인하면 함께 저장됩니다.
            아직 안 다듬은 버전은 지금 배치·문구로 자동으로 채워집니다.
          </div>
          {(
            <div className="flex gap-1.5 mb-2 items-center flex-wrap">
              <span className="label">배치 고르기</span>
              {channel === '자사몰' && (<>
              {/* 선택된 시안만 칠한다 — 둘 다 칠해두면 뭐가 골라졌는지 안 보인다 (사용자 피드백) */}
              <button className="chip" onClick={() => applyTemplateA()} disabled={!!busy}
                      title="디자인팀 실물 실측 — 웹: 좌 60% 문구+우 40% 이미지 / 모바일: 하단 그늘 + 문구 3줄"
                      style={stageIsTemplateA() ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                🅰 A안 배치
              </button>
              <button className="chip" onClick={() => applyPlan('B')} disabled={!!busy}
                      title="디자인팀 가이드 실측 — 이미지 한 장 + 중앙정렬 문구 3줄 (타이틀 2줄 가능)"
                      style={stageIsTemplateB() ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                🅱 B안 배치
              </button>
              {/* 우측 이미지는 A안 웹 전용 — A안을 고른 다음에야 나타나고, 누르면 팝업에서 직접 올리기/레퍼런스/생성 컷을 고른다 */}
              {stageIsTemplateA() && dims.w > dims.h && (
                <>
                  <button className="chip"
                          title="직접 올리기 / 레퍼런스 보관함 / 생성 컷에서 고릅니다"
                          onClick={openRightPicker}
                          style={rightImg ? {} : { borderColor: 'var(--warn)', color: 'var(--warn)' }}>
                    {rightImg ? '우측 이미지 바꾸기' : '＋ 우측 이미지 추가하기'}
                  </button>
                  {rightImg && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={rightImg} alt="우측 이미지" className="h-[26px] w-[26px] object-cover rounded border" style={{ borderColor: 'var(--line)' }} />
                  )}
                </>
              )}
              {/* 모바일 탭 + A안일 때만 하단 처리 방식을 고른다 — 누르면 그 방식으로 A안이 다시 깔린다 */}
              {stageIsTemplateA() && dims.h > dims.w && (
                <>
                  <button className="chip" onClick={() => applyTemplateA('scrim')} disabled={!!busy}
                          title="사진 위로 어두운 그라데이션 (Luxe 배너 방식)"
                          style={mobStyle === 'scrim' ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                    그늘형
                  </button>
                  <button className="chip" onClick={() => applyTemplateA('band')} disabled={!!busy}
                          title="사진은 위쪽, 아래는 단색 밴드로 스며듦 (Modju 배너 방식) — 밴드 색은 레이어 색으로 변경"
                          style={mobStyle === 'band' ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                    밴드형
                  </button>
                </>
              )}
              </>)}
              <span className="mx-0.5" style={{ color: 'var(--line-strong)' }}>|</span>
              {/*
                내 템플릿 — 저장해둔 배치를 같은 층위에서 고른다. 개수가 늘면 칩이 줄줄이
                늘어지므로 접어두고, 열면 썸네일로 무엇인지 바로 알아보게 한다.
              */}
              <span className="relative inline-flex items-center">
                <button className="chip" onClick={() => setTplOpen((v) => !v)} disabled={!!busy}
                        title="저장해둔 배치를 골라 지금 컷에 올립니다">
                  📁 내 템플릿{templates.length ? ` (${templates.length})` : ''} ▾
                </button>
                {tplOpen && (
                  <div className="absolute z-20 p-2 rounded-[10px]"
                       style={{ top: 28, left: 0, width: 340, maxHeight: 320, overflowY: 'auto',
                                background: 'var(--surface)', border: '1px solid var(--line-strong)',
                                boxShadow: '0 6px 24px rgba(0,0,0,.4)' }}>
                    {templates.length === 0 ? (
                      <div className="text-[11px] p-2" style={{ color: 'var(--text-mute)' }}>
                        저장한 템플릿이 없습니다. 마음에 드는 배치를 만든 뒤 [💾 지금 배치 저장] 을 누르면 여기에 쌓입니다.
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {templates.map((t) => (
                          <div key={t.id} className="flex items-center gap-2 p-1 rounded-[8px]"
                               style={{ background: 'var(--surface-2)' }}>
                            <button className="flex items-center gap-2 flex-1 min-w-0 text-left"
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                                    onClick={() => { applySavedTemplate(t); setTplOpen(false); }}>
                              {t.thumb ? (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img src={t.thumb} alt={t.name} className="rounded"
                                     style={{ width: 76, height: 44, objectFit: 'cover', border: '1px solid var(--line)' }} />
                              ) : (
                                <span className="rounded grid place-items-center text-[9px]"
                                      style={{ width: 76, height: 44, background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text-mute)' }}>
                                  미리보기 없음
                                </span>
                              )}
                              <span className="text-[11.5px] truncate" style={{ color: 'var(--text-dim)' }}>{t.name}</span>
                            </button>
                            <button className="chip px-1.5" title="이 템플릿 삭제" disabled={!!busy}
                                    style={{ color: 'var(--danger)' }}
                                    onClick={() => removeSavedTemplate(t)}>✕</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </span>
              {tplNaming ? (
                <input autoFocus value={tplName}
                       onChange={(e) => setTplName(e.target.value)}
                       onKeyDown={(e) => {
                         if (e.key === 'Enter') saveTemplate();
                         if (e.key === 'Escape') { setTplNaming(false); setTplName(''); }
                       }}
                       placeholder="템플릿 이름 (Enter=저장)"
                       className="px-2 py-1 text-[12px] rounded-[8px] w-[180px]"
                       style={{ background: 'var(--surface)', border: '1px solid var(--accent)', color: 'var(--text)' }} />
              ) : (
                <button className="chip" onClick={saveTemplate} disabled={!!busy || !layers.length}
                        title="지금 화면의 문구·위치·크기·색 배치를 저장합니다 (배경 사진은 저장되지 않습니다)">
                  💾 지금 배치 저장
                </button>
              )}
              {/*
                배경 크기 — 더블클릭 패널에만 있으면 찾기 어렵다는 피드백으로 상단에도 둔다.
                숫자를 낮추면 배경이 규격보다 작아지고(40%까지) 남는 자리는 바탕이 보인다.
              */}
              <span className="mx-0.5" style={{ color: 'var(--line-strong)' }}>|</span>
              <span data-bgsize-top className="text-[10.5px]" style={{ color: 'var(--text-dim)' }}>배경 크기</span>
              <input type="number" min={40} max={250} step={5} disabled={!imageUrl}
                     value={Math.round(Math.max(0.4, fitZoom) * 100)}
                     title="배경 사진 크기 (%) — 40%까지 줄일 수 있고, 캔버스 안에서 드래그하면 위치가 움직입니다"
                     onChange={(e) => {
                       const v = Math.max(40, Math.min(250, Number(e.target.value) || 100));
                       setFitZoom(v / 100); setFocusTouched(true); setResult(null);
                     }}
                     className="w-[56px] px-1.5 py-0.5 text-[12px] rounded-[6px] tabular-nums text-right"
                     style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text)' }} />
              <span className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>%</span>
              <button className="chip px-2" disabled={!imageUrl} title="배경 크기·위치를 처음 상태로"
                      onClick={() => { setFitZoom(1); setFitPanX(0); setFitPanY(0); setFx(0.5); setFy(0.5); setResult(null); }}>
                원위치
              </button>
              <span className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>A = 2분할 · B = 중앙 문구</span>
            </div>
          )}

          {/*
            템플릿 — 마음에 든 문구 배치를 저장해두고 다른 컷에 그대로 올린다.
            (배경 사진은 저장하지 않는다 — 배치·문구·색만 남아서 어떤 컷에도 얹힌다)
          */}
          {/*
            버전 탭 — 웹/모바일을 오가며 각각 다듬는다.
            위치·크기는 버전마다 따로, 색은 두 버전에 같이 들어간다.
          */}
          {autoSet.length > 1 && (
            <div className="flex gap-1.5 mb-2 items-center flex-wrap">
              <span className="label">버전</span>
              {autoSet.map((b) => (
                <button key={b.id} className="chip" disabled={!!busy}
                        onClick={() => switchVariant(b.id)}
                        style={sizeId === b.id ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}
                        title={`${b.label} ${b.w}×${b.h}${variants[b.id] || sizeId === b.id ? '' : ' — 누르면 같은 문구로 자동 배치됩니다'}`}>
                  {b.label.replace(/^(자사몰|스마트스토어)\s*/, '')} {b.w}×{b.h}
                </button>
              ))}
              <span className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>
                위치는 버전마다 따로 · 색은 두 버전에 같이 적용
              </span>
            </div>
          )}

          <div className="flex justify-center">
          <div
            ref={stageRef}
            onPointerDown={onBgDown}
            onDoubleClick={(e) => {
              const st = stageRef.current;
              if (st) {
                const r = st.getBoundingClientRect();
                const hit = placeholderAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
                if (hit) { openRightPicker(); return; }   // 빈 우측 이미지 칸 — 바로 고르기로
              }
              if (imageUrl) setBgTune(true);
            }}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onUp}
            className="relative w-full select-none rounded-lg overflow-hidden"
            style={{
              aspectRatio: `${dims.w} / ${dims.h}`, background: 'var(--surface-2)', touchAction: 'none',
              // 세로형은 높이를 화면에 맞추고 폭을 줄인다. max-height 로 자르면 비율이
              // 깨져서 손잡이 좌표와 배경 자르기가 서버와 어긋난다 — 폭으로만 줄인다
              maxWidth: dims.w < dims.h ? `calc((100vh - 250px) * ${(dims.w / dims.h).toFixed(4)})` : undefined,
            }}
          >
            {/*
              * 서버의 fitToSize 와 같은 계산을 CSS 로 한다.
              * cover = object-fit:cover + object-position(fx,fy),
              * blur  = 흐린 사본을 깔고 그 위에 통째로 얹기.
              * 두 계산이 어긋나면 화면에서 본 자리와 저장본이 달라진다.
              */}
            {/* color·gradient·blur 는 여백을 채우는 배경을 깔고 사진을 통째로(contain) 얹는다 */}
            {imageUrl && fitMode === 'blur' && needsFit && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl} alt="" aria-hidden
                   className="absolute inset-0 w-full h-full object-cover"
                   style={{ filter: 'blur(18px) brightness(0.82)', transform: 'scale(1.1)' }} draggable={false} />
            )}
            {imageUrl && needsFit && (fitMode === 'color' || fitMode === 'gradient') && (
              <div className="absolute inset-0" aria-hidden
                   style={fitMode === 'gradient'
                     ? { background: `linear-gradient(${shade(fillColor, 22)}, ${shade(fillColor, -26)})` }
                     : { background: fillColor }} />
            )}
            {imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl} alt="배경" draggable={false}
                   className="absolute"
                   style={bgImgStyle} />
            )}
            {/* 저장본과 같은 SVG 를 그대로 얹는다 */}
            <div className="absolute inset-0 pointer-events-none"
                 dangerouslySetInnerHTML={{ __html: svg.replace('<svg ', '<svg style="width:100%;height:100%;display:block" ') }} />
            {/* 이미지 더블클릭 → 배경 크기 패널. 슬라이더 조작이 배경 드래그로 새지 않게 전파를 끊는다 */}
            {bgTune && imageUrl && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-3 py-2 rounded-[10px]"
                   style={{ background: 'var(--surface)', border: '1px solid var(--accent)', width: 'min(440px, 94%)', boxShadow: '0 4px 18px rgba(0,0,0,.35)' }}
                   onPointerDown={(e) => e.stopPropagation()}
                   onDoubleClick={(e) => e.stopPropagation()}>
                <span className="text-[10.5px] shrink-0" style={{ color: 'var(--text-dim)' }}>이미지 크기</span>
                <input type="range" min={0.4} max={2.5} step={0.02} value={Math.max(0.4, fitZoom)} className="flex-1"
                       onChange={(e) => { setFitZoom(Number(e.target.value)); setFocusTouched(true); setResult(null); }} />
                {/* 수치 직접 입력 — 눌러서 숫자를 낮추면 그만큼 작아진다 */}
                <input type="number" min={40} max={250} step={5}
                       value={Math.round(Math.max(0.4, fitZoom) * 100)}
                       onChange={(e) => {
                         const v = Math.max(40, Math.min(250, Number(e.target.value) || 100));
                         setFitZoom(v / 100); setFocusTouched(true); setResult(null);
                       }}
                       className="w-[58px] px-1.5 py-0.5 text-[12px] rounded-[6px] tabular-nums text-right"
                       style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text)' }} />
                <span className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>%</span>
                <button className="chip px-2" title="원래 크기·위치로"
                        onClick={() => { setFitZoom(1); setFitPanX(0); setFitPanY(0); setFx(0.5); setFy(0.5); setResult(null); }}>원위치</button>
                <button className="chip px-2" onClick={() => setBgTune(false)}>닫기</button>
              </div>
            )}
            {/*
              * 선택한 레이어 크기 — 수치 입력. 손잡이를 끄는 대신 숫자를 낮추면 그만큼 줄어든다.
              * 선택한 순간이 100% 기준이고, 배경 패널이 떠 있으면 그 아래로 비켜 앉는다.
              */}
            {sel && panelClosedFor !== sel.id && (
              <div className="absolute left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-3 py-1.5 rounded-[10px]"
                   style={{ top: bgTune ? 60 : 8, background: 'var(--surface)', border: '1px solid var(--accent)',
                            maxWidth: '92%', flexWrap: 'wrap', rowGap: 4,
                            boxShadow: '0 4px 18px rgba(0,0,0,.35)' }}
                   onPointerDown={(e) => e.stopPropagation()}
                   onDoubleClick={(e) => e.stopPropagation()}>
                <span className="text-[10.5px] shrink-0" style={{ color: 'var(--text-dim)' }}>
                  {labelOf(sel, layers)} {sel.kind === 'image' && sel.cover ? '이미지 확대 (칸 고정)' : '크기'}
                </span>
                <input type="number" min={10} max={400} step={5} value={shownPct}
                       onChange={(e) => applySizePct(Number(e.target.value) || 100)}
                       title="숫자를 낮추면 상하좌우가 같은 비율로 작아집니다 (선택한 순간이 100%)"
                       className="w-[62px] px-1.5 py-0.5 text-[12px] rounded-[6px] tabular-nums text-right"
                       style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text)' }} />
                <span className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>%</span>
                <button className="chip px-2" title="선택 시점 크기로" onClick={() => applySizePct(100)}>되돌리기</button>
                <button className="chip px-1.5" title="이 패널 닫기 (다른 레이어를 고르면 다시 뜹니다)"
                        onClick={() => setPanelClosedFor(sel.id)}>✕</button>
                {/*
                  * 이미지 슬롯은 자리·크기를 고정한 채 "원본의 어느 부분이 보일지"만 옮긴다.
                  * 우측 이미지처럼 꽉 채워 자르는 슬롯에서 인물이 잘리는 걸 여기서 맞춘다.
                  */}
                {sel.kind === 'image' && sel.cover && (
                  <span data-focal-controls className="flex items-center gap-1.5">
                    <span className="mx-0.5" style={{ color: 'var(--line-strong)' }}>|</span>
                    <span className="text-[10.5px] shrink-0" style={{ color: 'var(--text-dim)' }}>보이는 부분</span>
                    <span className="text-[10px]" style={{ color: 'var(--text-mute)' }}>좌우</span>
                    <input type="range" min={-0.5} max={1.5} step={0.02} value={sel.srcFx ?? 0.5} style={{ width: 72 }}
                           title="원본의 왼쪽·오른쪽 중 어디를 보여줄지 (슬롯 밖으로도 밀 수 있습니다)" onPointerDown={() => snapUndo()}
                           onChange={(e) => { patch(sel.id, { srcFx: Number(e.target.value) }); setResult(null); }} />
                    <span className="text-[10px]" style={{ color: 'var(--text-mute)' }}>상하</span>
                    <input type="range" min={-0.5} max={1.5} step={0.02} value={sel.srcFy ?? 0.5} style={{ width: 72 }}
                           title="원본의 위·아래 중 어디를 보여줄지 (슬롯 밖으로도 밀 수 있습니다)" onPointerDown={() => snapUndo()}
                           onChange={(e) => { patch(sel.id, { srcFy: Number(e.target.value) }); setResult(null); }} />
                    <button className="chip px-2" title="가운데로"
                            onClick={() => { patch(sel.id, { srcFx: 0.5, srcFy: 0.5 }); setResult(null); }}>가운데</button>
                  </span>
                )}
              </div>
            )}
            {/*
              * 잡는 손잡이 — 레이어 중심에 점을 두고 그걸 끈다.
              * 무리마다 하나만 둔다. 버튼에 점 세 개가 뜨면 한 몸으로 안 보인다.
              * 두 번 누르면 곧바로 편집으로 넘어간다.
              */}
            {leaders(layers).map((l) => (
              <span key={l.id}
                    onPointerDown={(e) => onDown(e, l.id)}
                    onDoubleClick={(e) => { e.stopPropagation(); openInspector(l.id); }}
                    title={`${labelOf(l, layers)} — 끌어서 옮기기 · 두 번 눌러 수정`}
                    className="absolute rounded-full"
                    style={{
                      left: `${l.x * 100}%`, top: `${l.y * 100}%`, transform: 'translate(-50%,-50%)',
                      width: 22, height: 22, cursor: 'move',
                      border: `2px solid ${isSel(l) ? 'var(--accent)' : 'rgba(255,255,255,.55)'}`,
                      background: isSel(l) ? 'rgba(226,80,60,.25)' : 'rgba(0,0,0,.25)',
                    }} />
            ))}
            {/* 선택한 레이어에만 붙는 비율 유지 크기 손잡이 — 끌면 상하좌우가 같은 비율로 줄고 큰다 */}
            {layers.filter((l) => isSel(l)).map((l) => (
              <div key={l.id + '-scale'}
                   onPointerDown={(e) => onScaleDown(e, l.id)}
                   title="끌어서 크기 조절 — 비율 유지 (오른쪽·아래 = 확대, 왼쪽·위 = 축소)"
                   className="absolute grid place-items-center rounded-full text-[10px] select-none"
                   style={{
                     left: `calc(${l.x * 100}% + 20px)`, top: `calc(${l.y * 100}% + 20px)`,
                     transform: 'translate(-50%,-50%)', width: 18, height: 18,
                     cursor: 'nwse-resize', color: '#fff',
                     border: '2px solid var(--accent)', background: 'rgba(226,80,60,.55)',
                   }}>
                ⤡
              </div>
            ))}
            {!imageUrl && (
              <div className="absolute inset-0 grid place-items-center text-center text-[12px] px-4" style={{ color: 'var(--text-mute)' }}>
                오른쪽 2번에서 배경을 골라주세요.<br />
                생성한 컷을 쓰거나, 가지고 있는 이미지를 올려도 됩니다.
              </div>
            )}
          </div>
          </div>
        </div>
      </div>

      {/* ── 배경 전체보기 게시판 — 생성 컷 20개씩 ── */}
      {browseOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
             style={{ background: 'rgba(0,0,0,.8)' }} onClick={() => setBrowseOpen(false)}>
          <div className="card p-4 max-w-[min(1100px,94vw)] max-h-[92vh] overflow-y-auto w-full"
               onClick={(e) => e.stopPropagation()}>
            {(() => {
              const CAT_KR: Record<string, string> = { shoot: '촬영', banner: '배너', sns: 'SNS', interior: '인테리어', instagram: '인스타그램', model: '모델컷' };
              const pool = browseSrc === 'refs'
                ? refs.filter((r) => !browseCat || r.cat === browseCat).map((r) => ({ id: r.url, url: r.url, label: r.label }))
                : cuts;
              const page = Math.min(browsePage, Math.max(0, Math.ceil(pool.length / BROWSE_PER) - 1));
              const items = pool.slice(page * BROWSE_PER, (page + 1) * BROWSE_PER);
              const cats = [...new Set(refs.map((r) => r.cat))].filter((c) => CAT_KR[c]);
              return (
                <>
                  <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                    <h2 className="text-[14px] font-bold" style={{ color: 'var(--text)' }}>
                      {browseFor === 'right' ? 'A안 우측 이미지 고르기' : '배경 고르기'} — {pool.length.toLocaleString()}개
                    </h2>
                    <button className="chip" onClick={() => setBrowseOpen(false)}>닫기</button>
                  </div>
                  {/* 소스 탭 — 생성 컷 / 레퍼런스 보관함 (서버 업로드 없이 가진 자산에서 바로) */}
                  <div className="flex items-center gap-1.5 mb-3 flex-wrap">
                    <button className="chip" onClick={() => { setBrowseSrc('cuts'); setBrowsePage(0); }}
                            style={browseSrc === 'cuts' ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                      생성 컷 ({cuts.length})
                    </button>
                    {refs.length > 0 && (
                      <button className="chip" onClick={() => { setBrowseSrc('refs'); setBrowseCat(''); setBrowsePage(0); }}
                              style={browseSrc === 'refs' ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                        레퍼런스 보관함 ({refs.length.toLocaleString()})
                      </button>
                    )}
                    {browseFor === 'right' && (
                      <label className="chip cursor-pointer" title="가진 파일을 직접 올립니다">
                        ＋ 직접 올리기
                        <input type="file" accept="image/*" className="hidden"
                               onChange={(e) => { uploadRight(e.target.files); setBrowseOpen(false); }} />
                      </label>
                    )}
                    {browseSrc === 'refs' && cats.length > 1 && (
                      <>
                        <span className="mx-1" style={{ color: 'var(--line-strong)' }}>|</span>
                        <button className="chip px-2" onClick={() => { setBrowseCat(''); setBrowsePage(0); }}
                                style={!browseCat ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>전체</button>
                        {cats.map((c) => (
                          <button key={c} className="chip px-2" onClick={() => { setBrowseCat(c); setBrowsePage(0); }}
                                  style={browseCat === c ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                            {CAT_KR[c]} ({refs.filter((r) => r.cat === c).length.toLocaleString()})
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-2.5">
                    {items.map((c) => (
                      <button key={c.id}
                              onClick={() => {
                                if (browseFor === 'right') { setRightImage(c.url); setNote('우측 이미지를 골랐습니다.'); setBrowseOpen(false); return; }
                                setImageUrl(c.url); setFocusTouched(false); setResult(null); setVariants({}); setBrowseOpen(false);
                              }}
                              className="block rounded-lg overflow-hidden border text-left" style={{ padding: 0, borderColor: 'var(--line)' }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={thumbUrl(c.url, 256)} alt={c.label} loading="lazy"
                             style={{ width: '100%', aspectRatio: '1/1', objectFit: 'cover', display: 'block',
                                      background: 'var(--surface-2)',
                                      outline: c.url === imageUrl ? '2px solid var(--accent)' : 'none', outlineOffset: -2 }} />
                        <div className="text-[10px] px-1.5 py-1 truncate" style={{ color: 'var(--text-dim)' }}>{c.label || '(제목 없음)'}</div>
                      </button>
                    ))}
                  </div>
                  {pool.length > BROWSE_PER && (
                    <div className="flex items-center justify-center gap-2 mt-3">
                      <button className="btn" disabled={page === 0} onClick={() => setBrowsePage(Math.max(0, page - 1))}>이전</button>
                      <span className="text-[12px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
                        {page + 1} / {Math.ceil(pool.length / BROWSE_PER)}
                      </span>
                      <button className="btn" disabled={(page + 1) * BROWSE_PER >= pool.length}
                              onClick={() => setBrowsePage(page + 1)}>다음</button>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* ── 확인창 — 저장될 그림을 실제 크기 렌더로 보여주고 확인을 받는다 ── */}
      {result && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
             style={{ background: 'rgba(0,0,0,.75)' }}
             onClick={() => { if (!busy) setResult(null); }}>
          <div className="card p-4 max-w-[min(1100px,94vw)] max-h-[92vh] overflow-y-auto w-full"
               onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="label" style={{ color: 'var(--text-dim)' }}>
                {result.kind === 'pair' ? '이렇게 두 장이 저장됩니다' : '이렇게 저장됩니다'}
              </div>
              <div className="text-[10.5px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
                {result.kind === 'single' && `${result.w}×${result.h}`}
              </div>
            </div>

            {result.kind === 'single' ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={result.preview} alt="저장될 배너" className="w-full rounded-lg border"
                   style={{ borderColor: 'var(--line-strong)' }} />
            ) : (
              <div className="flex flex-col gap-3">
                {result.items.map((it) => (
                  <div key={it.label}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
                        {it.label} · {it.w}×{it.h}
                      </span>
                      {/*
                        * 한 장만 고치고 싶을 때 — 그 버전의 배치를 무대로 옮겨
                        * 이어서 다듬는다. 저장은 다듬은 뒤 [완성 · 저장]으로.
                        */}
                      <button className="chip ml-auto"
                              onClick={() => {
                                // 두 버전을 다 보관함에 담아둔다 — 탭으로 오가며 다듬고 짝 저장까지 이어진다
                                if (result?.kind === 'pair') {
                                  setVariants((v) => {
                                    const next = { ...v };
                                    for (const x of result.items) next[x.sizeId] = { layers: x.layers, fit: x.fit };
                                    return next;
                                  });
                                }
                                applyingFocus.current = true;      // 규격 변경으로 자동 재배치가 돌면 가져온 배치를 덮는다
                                setSizeId(it.sizeId);
                                setLayers(it.layers);
                                setFitMode(it.fit.mode);
                                setFx(it.fit.fx);
                                setFy(it.fit.fy);
                                setFocusTouched(true);
                                setSelected(null);
                                setResult(null);
                                setNote(`${it.label} 버전을 무대에 올렸습니다 — 버전 탭으로 오가며 다듬고, [완성 · 저장]으로 짝 저장하세요.`);
                              }}>
                        이 버전 무대에서 다듬기
                      </button>
                    </div>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={it.preview} alt={it.label} className="rounded-lg border mx-auto"
                         style={{ borderColor: 'var(--line-strong)', maxHeight: '58vh', maxWidth: '100%' }} />
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2 mt-3 justify-end">
              <button className="btn" onClick={() => setResult(null)} disabled={!!busy}>닫기</button>
              <button className="btn btn-primary" disabled={!!busy}
                      onClick={() => (result.kind === 'single' ? render(true) : saveBoth(false))}>
                {busy === 'save' ? '저장 중…' : result.kind === 'pair' ? '✔ 두 장 모두 저장' : '✔ 이대로 저장'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 오른쪽: 밟는 순서 ── */}
      <aside className="w-full xl:w-[340px] shrink-0">

        {/* 채널이 최초 선택 — 자사몰용인지 스마트스토어용인지 SNS 용인지가 모든 것의 출발점 */}
        <Step n={1} title="어디에 쓸 배너인가" done={!!channel}>
          <div className="flex gap-1.5">
            {CHANNELS.map((ch) => (
              <button key={ch}
                      className={`btn flex-1 ${channel === ch ? 'btn-primary' : ''}`}
                      onClick={() => {
                        setChannel(ch);
                        setSizeId(defaultSizeFor(ch));   // 채널의 대표 규격으로 바로 맞춘다
                        setFocusTouched(false);
                        setResult(null);
                        setVariants({});                 // 채널이 다르면 짝 규격도 달라진다
                      }}>
                {ch}
              </button>
            ))}
          </div>
          <div className="text-[10.5px] mt-1.5 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            자동완성 저장 묶음: {autoSetText}
          </div>
        </Step>

        <Step n={2} title="배경 고르기" done={!!imageUrl}
              hint={imageUrl ? `${src.w}×${src.h}` : undefined}>
          {/* 내가 올린 것 — 방금 올린 게 맨 앞에 오도록 생성 컷보다 위에 둔다 */}
          {mine.length > 0 && (
            <>
              <div className="label mb-1.5">내가 올린 이미지</div>
              <div className="flex gap-1.5 overflow-x-auto pb-1 mb-2">
                {mine.map((c) => (
                  <div key={c.id} className="relative shrink-0">
                    <button onClick={() => { setImageUrl(c.url); setFocusTouched(false); setResult(null); setVariants({}); }} title={c.label}
                            className="block rounded-lg overflow-hidden border" style={{ padding: 0 }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={c.url} alt={c.label} loading="lazy" className="object-cover"
                           style={{ width: 58, height: 58, borderColor: 'var(--line)',
                                    outline: c.url === imageUrl ? '2px solid var(--accent)' : 'none', outlineOffset: -2 }} />
                    </button>
                    <button title="목록에서 빼기"
                            onClick={() => saveMine(mine.filter((m) => m.url !== c.url))}
                            className="absolute -top-1 -right-1 w-4 h-4 rounded-full text-[9px] leading-none"
                            style={{ background: 'var(--surface-3)', border: '1px solid var(--line)', color: 'var(--text-mute)', cursor: 'pointer', padding: 0 }}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="flex items-center justify-between mb-1.5">
            <div className="label">생성한 컷</div>
            {cuts.length > 0 && (
              <button className="chip" onClick={() => { setBrowseFor('bg'); setBrowsePage(0); setBrowseOpen(true); }}
                      title="지금까지 생성된 컷을 게시판처럼 20개씩 봅니다">
                전체보기 · {cuts.length}
              </button>
            )}
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {cuts.map((c) => (
              <button key={c.id} onClick={() => { setImageUrl(c.url); setFocusTouched(false); setResult(null); setVariants({}); }} title={c.label}
                      className="shrink-0 rounded-lg overflow-hidden border" style={{ padding: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.url} alt={c.label} loading="lazy" className="object-cover"
                     style={{ width: 58, height: 58, borderColor: 'var(--line)',
                              outline: c.url === imageUrl ? '2px solid var(--accent)' : 'none', outlineOffset: -2 }} />
              </button>
            ))}
            {cuts.length === 0 && (
              <span className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
                생성된 컷이 없습니다. 먼저 이미지를 만들거나 아래에서 올려주세요.
              </span>
            )}
          </div>

          <label className="btn w-full justify-center mt-2" style={{ cursor: busy ? 'not-allowed' : 'pointer' }}>
            {busy === 'upload' ? '올리는 중…' : '＋ 내 이미지 올리기'}
            <input type="file" accept="image/*" className="hidden" disabled={!!busy}
                   onChange={(e) => { uploadBackground(e.target.files); e.target.value = ''; }} />
          </label>
          <div className="text-[10.5px] mt-1.5 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            포토샵으로 만든 배경도 올려서 쓸 수 있습니다. 올린 이미지는 이 브라우저에 기억해두니
            다음에 와도 그대로 있습니다.
          </div>
        </Step>

        {/* 규격 — 채널이 정해졌으니 그 채널의 규격만 보여준다 */}
        <Step n={3} title="직접 수정" open={tweakOpen} onToggle={() => setTweakOpen((v) => !v)}
              hint={layers.length ? `레이어 ${layers.length}` : undefined}>
          {/*
            A안·B안은 위치·크기가 이미 정해진 배치라, 여기 기본 배치들(정사각 기준)을 덧씌우면
            그 규칙이 깨진다. 그래서 A안·B안을 고른 상태에서는 이 묶음을 감춘다 (사용자 지정).
            템플릿 저장은 무대 위 [배치 고르기] 줄에 있으므로 여기 중복 버튼은 뺐다.
          */}
          {!stageIsTemplateA() && !stageIsTemplateB() && (
            <>
            <div className="label mb-1.5">다른 배치로 바꾸기</div>
            <div className="flex flex-wrap gap-1.5 mb-1">
              {TEMPLATES.map((t) => (
                <button key={t.id} className="chip" title={t.hint} onClick={() => applyTemplate(t.id)}>{t.name}</button>
              ))}
            </div>
            {shape !== 'square' && (
              <div className="text-[10.5px] mb-2 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
                이 템플릿들은 정사각 기준으로 잡아둔 것이라 {shapeWord} 규격에서는 간격이 어색할 수 있습니다.
                자동 배치가 이 비율에 맞게 잡아줍니다.
              </div>
            )}

            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {tplNaming && (
                <input
                  autoFocus
                  value={tplName}
                  onChange={(e) => setTplName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveTemplate();
                    if (e.key === 'Escape') { setTplNaming(false); setTplName(''); }
                  }}
                  placeholder="템플릿 이름 (Enter=저장)"
                  className="px-2 py-1 text-[12px] rounded-[8px] w-[170px]"
                  style={{ background: 'var(--surface)', border: '1px solid var(--accent)', color: 'var(--text)' }}
                />
              )}
              <button className="chip" onClick={saveTemplate} disabled={!!busy || !layers.length}
                      title="배경 없이 지금 배치만 저장해서 다른 컷에도 얹을 수 있게 합니다.">
                {tplNaming ? '이 이름으로 저장' : '지금 배치를 템플릿으로 저장'}
              </button>
            </div>
            </>
          )}

          {/* 색 테마·내 템플릿 목록도 A안·B안에선 감춘다 — 색과 배치가 이미 정해져 있고,
             템플릿은 무대 위 [배치 고르기] 줄에서 고른다 (중복 노출 방지) */}
          {!stageIsTemplateA() && !stageIsTemplateB() && (
            <>
            <div className="label mb-1.5 mt-2">색 테마</div>
            <select className="input py-1 text-[11.5px]" value={themeId} onChange={(e) => setThemeId(e.target.value)}>
              {THEMES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>

            {templates.length > 0 && (
              <>
                <div className="label mt-3 mb-1.5">내 템플릿</div>
                <div className="flex flex-wrap gap-1.5">
                  {templates.map((t) => (
                    <button key={t.id} className="chip"
                            onClick={() => applySavedTemplate(t)}>
                      {t.name}
                    </button>
                  ))}
                </div>
              </>
            )}

            </>
          )}
          <div className="flex items-center justify-between mt-3 mb-1.5">
            <div className="label">화면에 올라간 요소</div>
            {/* 요소 추가는 자유 배치에서만 — A안·B안은 들어갈 요소가 이미 정해져 있다 (사용자 지정) */}
            {!stageIsTemplateA() && !stageIsTemplateB() && (
              <div className="flex gap-1">
                {(['text', 'icon', 'rect', 'scrim'] as const).map((k) => (
                  <button key={k} className="chip" title={`${k} 추가`}
                          onClick={() => { const l = newLayer(k, theme.strong); setLayers((c) => [...c, l]); setSelected(l.id); }}>
                    ＋{k === 'text' ? '글자' : k === 'icon' ? '아이콘' : k === 'rect' ? '도형' : '그늘'}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="text-[10.5px] mb-1.5 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            문구·그늘·이미지가 한 줄씩 있습니다. <b style={{ color: 'var(--text-dim)' }}>보임</b> 을 누르면
            그 요소만 잠시 감춰지고(저장본에도 안 나옵니다), <b style={{ color: 'var(--text-dim)' }}>숨김</b> 을
            다시 누르면 돌아옵니다 — 지우는 게 아니라 껐다 켜는 겁니다.
            예: 사진이 밝아 글자가 잘 보이면 &lsquo;좌측 어둡게&rsquo; 를 잠시 꺼보세요.
          </div>
          {layers.length === 0 && (
            <div className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
              위 &lsquo;문구 넣고 자동 배치&rsquo; 를 누르거나, ＋ 로 요소를 추가하세요.
            </div>
          )}
          {/* 무리는 한 줄로 — 버튼이 세 줄로 늘어서면 무엇이 한 몸인지 안 보인다 */}
          <div className="flex flex-col gap-1">
            {leaders(layers).map((l) => {
              const g = groupOf(l);
              const grouped = !!l.group;
              return (
                <div key={l.id} className="flex items-center gap-1.5 p-1.5 rounded-lg text-[11px]"
                     style={{ background: isSel(l) ? 'var(--accent-soft)' : 'var(--surface-2)', cursor: 'pointer' }}
                     onClick={() => setSelected(l.id)}
                     onDoubleClick={() => openInspector(l.id)}>
                  <span className="w-3 h-3 rounded shrink-0" style={{ background: l.color }} />
                  <span className="truncate flex-1"
                        style={{ color: 'var(--text-dim)', opacity: l.hidden ? 0.45 : 1, textDecoration: l.hidden ? 'line-through' : 'none' }}>
                    {labelOf(l, layers)}
                  </span>
                  {/*
                    보임/숨김 — 어둡게 깔린 그늘처럼 "지우긴 아깝고 잠깐 꺼보고 싶은" 레이어가 있다.
                    묶음(버튼 등)은 한 몸이라 무리 전체를 함께 끈다. 숨긴 레이어는 저장본에도 안 나온다.
                  */}
                  <button className="chip px-1.5 py-0 text-[10px]"
                          title={l.hidden ? '지금은 안 보이는 상태 — 눌러서 다시 보이게 합니다' : '이 요소를 화면에서 잠시 감춥니다 (지우는 게 아니라 껐다 켤 수 있어요)'}
                          onClick={(e) => {
                            e.stopPropagation();
                            snapUndo();
                            const ids = new Set(leaders(layers).filter((x) => groupOf(x) === g).map((x) => x.id));
                            setLayers((c) => c.map((x) => (
                              (l.group ? x.group === l.group : ids.has(x.id) || x.id === l.id)
                                ? { ...x, hidden: !l.hidden } : x)));
                            setResult(null);
                          }}
                          style={{ color: l.hidden ? 'var(--warn)' : 'var(--text-mute)',
                                   borderColor: l.hidden ? 'var(--warn)' : 'var(--line)' }}>
                    {l.hidden ? '숨김' : '보임'}
                  </button>
                  {!grouped && (
                    <button title="위로" onClick={(e) => {
                      e.stopPropagation();
                      setLayers((c) => {
                        const i = c.findIndex((x) => x.id === l.id);
                        if (i <= 0) return c;
                        const n = [...c]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n;
                      });
                    }} style={{ background: 'none', border: 'none', color: 'var(--text-mute)', cursor: 'pointer', padding: 0 }}>▲</button>
                  )}
                  <button title="삭제" onClick={(e) => {
                    e.stopPropagation();
                    setLayers((c) => c.filter((x) => groupOf(x) !== g));   // 무리는 통째로 지운다
                    setSelected(null);
                  }} style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: 0 }}>✕</button>
                </div>
              );
            })}
          </div>
          {/*
            고른 요소의 설정은 목록 "바로 아래" 에 편다 — 맨 위로 올라가 버리면
            고르는 곳과 고치는 곳이 멀어져서 화면이 튀는 느낌이 든다 (사용자 지정).
          */}
          {inspector}

          {/* 처음으로 되돌리기 — 이것저것 만지다 원점에서 다시 시작하고 싶을 때 */}
          <div className="mt-3 pt-2" style={{ borderTop: '1px solid var(--line)' }}>
            {resetArm ? (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[11px]" style={{ color: 'var(--warn)' }}>
                  배경 크기·위치·보정과 색, 배치를 처음 상태로 되돌립니다.
                </span>
                <button className="chip" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
                        onClick={resetAll}>네, 초기화</button>
                <button className="chip" onClick={() => setResetArm(false)}>취소</button>
              </div>
            ) : (
              <button className="chip" onClick={() => setResetArm(true)} disabled={!!busy}
                      title="배경 크기·위치·보정, 색, 문구 크기 설정을 처음 상태로 되돌립니다 (↩ 로 복구 가능)">
                ↺ 모든 설정 초기화
              </button>
            )}
          </div>
        </Step>

        {/*
          A안·B안은 문구 자리가 이미 정해져 있어 자동 배치가 필요 없다 —
          문구는 위 "화면에 올라간 요소" 에서 해당 줄을 눌러 직접 고친다 (사용자 지정).
        */}
        {!stageIsTemplateA() && !stageIsTemplateB() && (
          <Step n={4} title="문구 넣고 자동 배치" accent disabled={!imageUrl}
                done={layers.length > 0 && layers.every(isAuto)}>
            <input className="input py-1 text-[11.5px] mb-1.5" value={autoEyebrow}
                   onChange={(e) => setAutoEyebrow(e.target.value)} placeholder="윗 문구 — 작게 한 줄 (선택)" />
            <input className="input py-1 text-[12px] mb-1.5" value={autoTitle}
                   onChange={(e) => setAutoTitle(e.target.value)} placeholder="제목 — 가장 크게" />
            <input className="input py-1 text-[11.5px] mb-1.5" value={autoSub}
                   onChange={(e) => setAutoSub(e.target.value)} placeholder="혜택 한 줄 (선택)" />
            <input className="input py-1 text-[11.5px] mb-2" value={autoCta}
                   onChange={(e) => setAutoCta(e.target.value)} placeholder="버튼 문구 (선택)" />


            <div className="label mb-1">버튼 색</div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              <button className="chip" onClick={() => setBtnColor('photo')}
                      style={btnColor === 'photo' ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                사진에서 뽑기
              </button>
              {BRAND_BUTTON_COLORS.map((c) => (
                <button key={c.id} className="chip" onClick={() => setBtnColor(c.id)}
                        style={btnColor === c.id ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                  <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: c.hex }} />
                  {c.name}
                </button>
              ))}
            </div>

            {fonts.length > 1 && (
              <>
                <div className="label mb-1">글꼴</div>
                <select className="input py-1 text-[11.5px] mb-2" value={fontFamily}
                        onChange={(e) => { setFontFamily(e.target.value); setResult(null); }}>
                  {fonts.map((f) => (
                    <option key={f.file} value={f.family}>{f.family}</option>
                  ))}
                </select>
              </>
            )}

            {/* 기본값(100%)이 기존 자사몰 배너 실측 — 취향껏 벌리고 줄일 수 있게 열어둔다 */}
            {num('문구 크기', tuneScale, 0.7, 1.3, 0.01, (n) => { setTuneScale(n); setResult(null); },
                 (n) => `${Math.round(n * 100)}%`)}
            {num('줄 간격', tuneGap, 0.7, 1.5, 0.01, (n) => { setTuneGap(n); setResult(null); },
                 (n) => `${Math.round(n * 100)}%`)}

            <button className="btn btn-primary w-full" onClick={() => autoLayout(false)} disabled={!!busy || !imageUrl}>
              {busy === 'auto' ? '분석 중…' : '✨ 자동 배치'}
            </button>
            <div className="text-[10.5px] mt-1.5 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
              규격의 비율에 맞는 배치를 고르고, 배경에서 <b>비어 있는 곳</b>에 글자를 놓습니다.
              배경 밝기에 따라 글자색과 그늘도 정합니다.
              {picked && <><br />이번엔 <b style={{ color: 'var(--text-dim)' }}>{picked.where}</b> 여백을 골랐습니다.
                규격을 바꾸면 알아서 다시 잡습니다.</>}
            </div>
          </Step>
        )}

        <Step n={5} title="규격" done={!!sizeId} disabled={!imageUrl}
              open={sizeOpen} onToggle={() => setSizeOpen((v) => !v)}>
          <select className="input py-1 text-[12px]" value={sizeId}
                  onChange={(e) => { setSizeId(e.target.value); setFocusTouched(false); setResult(null); }}>
            <option value="">컷 크기 그대로 ({src.w}×{src.h})</option>
            {/* 감춰둔 규격으로 저장한 배너를 다시 열었을 때 — 목록에 없으면 선택칸이 빈 것처럼 보인다 */}
            {sizeId && !visibleSizesFor(channel).some((b) => b.id === sizeId) && (
              <option value={sizeId}>{findSize(sizeId).label} · {dims.w}×{dims.h}</option>
            )}
            {visibleSizesFor(channel).map((b) => (
              <option key={b.id} value={b.id}>{b.label} · {b.w}×{b.h}</option>
            ))}
          </select>
          <div className="text-[10.5px] mt-1.5 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            {shape === 'wide' ? '가로형 — 문구를 비어 있는 한쪽 옆에 세웁니다.'
              : shape === 'tall' ? '세로형 — 위나 아래에 크게 쌓습니다.'
              : '정사각 — 비어 있는 위/아래에 쌓습니다.'}
          </div>

          {needsFit && (
            <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--line)' }}>
              <div className="label mb-1.5">컷이 이 규격과 비율이 달라요</div>
              <div className="grid grid-cols-2 gap-1.5 mb-1.5">
                {([['cover', '잘라서 채우기'], ['blur', '흐리게 채우기'], ['color', '단색으로 채우기'], ['gradient', '그라데이션 채우기']] as const).map(([m, label]) => (
                  <button key={m} className={`btn ${fitMode === m ? 'btn-primary' : ''}`}
                          onClick={() => { setFitMode(m); setResult(null); }}>
                    {label}
                  </button>
                ))}
              </div>
              {fitMode === 'cover' ? (
                <>
                  {cropX && num('남길 위치 ↔', fx, 0, 1, 0.01, (n) => { setFx(n); setFocusTouched(true); setResult(null); },
                       (n) => `${Math.round(n * 100)}%`)}
                  {cropY && num('남길 위치 ↕', fy, 0, 1, 0.01, (n) => { setFy(n); setFocusTouched(true); setResult(null); },
                       (n) => `${Math.round(n * 100)}%`)}
                  {!(cropX && cropY) && (
                    <div className="text-[10.5px] mb-1 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
                      {cropY
                        ? '이 조합은 가로가 통째로 들어가서 위아래로만 잘립니다 — 좌우는 조절할 게 없습니다.'
                        : '이 조합은 세로가 통째로 들어가서 좌우로만 잘립니다 — 위아래는 조절할 게 없습니다.'}
                    </div>
                  )}
                  {!focusTouched && (
                    <div className="text-[10.5px] mb-1 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
                      지금은 <b>인물을 피해서</b> 남길 곳을 자동으로 정합니다. 슬라이더를 만지면 그때부터 손 위치를 따릅니다.
                    </div>
                  )}
                  <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
                    컷의 <b style={{ color: 'var(--warn)' }}>약 {Math.round(loss * 100)}%</b> 가 잘립니다.
                    인물이 잘리면 위 막대로 남길 곳을 옮기세요.
                  </div>
                </>
              ) : fitMode === 'blur' ? (
                <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
                  컷을 통째로 넣고 남는 자리는 같은 사진을 흐리게 깔아 채웁니다. 하나도 잘리지 않습니다.
                </div>
              ) : (
                <div>
                  <div className="text-[10.5px] mb-1.5 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
                    컷을 줄여 넣고 남는 여백을 {fitMode === 'gradient' ? '그 색의 위아래 그라데이션으로' : '단색으로'} 채웁니다. 하나도 잘리지 않습니다.
                  </div>
                  <div className="label mb-1">채울 색</div>
                  <div className="flex items-center gap-2">
                    <input type="color" value={fillColor} onChange={(e) => { setFillColor(e.target.value); setResult(null); }}
                           style={{ width: 38, height: 26, padding: 0, border: '1px solid var(--line)', borderRadius: 'var(--radius)', background: 'none' }} />
                    <div className="flex gap-1 flex-wrap">
                      {['#f2f0ec', '#1b1d21', '#2f3a5c', '#e2503c', '#e9e2d6'].map((c) => (
                        <button key={c} onClick={() => { setFillColor(c); setResult(null); }} title={c}
                                className="w-6 h-6 rounded" style={{ background: c, border: '1px solid var(--line)' }} />
                      ))}
                      <button className="chip" title="배경 사진에서 평균색을 뽑아 채웁니다"
                              onClick={() => sampleFillFromImage()}>사진에서 뽑기</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </Step>

      </aside>

      {/* ── 포토샵 방식 편집기 (전체 화면) ── */}
      {editorOpen && imageUrl && (
        <DesignEditor
          base={design}
          srcDims={src}
          serverFonts={fonts.map((f) => f.family)}
          sizeLabel={sizeId ? findSize(sizeId).label : undefined}
          sourceId={sourceId}
          onExit={(ls, f, img) => {
            setLayers(ls);
            if (img && img !== imageUrl) setImageUrl(img);   // AI 도구가 배경을 바꿨으면 이어받는다
            if (f) {
              setFitMode(f.mode); setFx(f.fx); setFy(f.fy);
              if (f.fillColor) setFillColor(f.fillColor);
              setFitZoom(f.zoom ?? 1);
              setFitZoomX(f.zoomX ?? 1);
              setFitZoomY(f.zoomY ?? 1);
              setFitPanX(f.panX ?? 0);
              setFitPanY(f.panY ?? 0);
              setFitAdjust(f.adjust);
            }
            setEditorOpen(false); setResult(null);
          }}
          onSaved={() => setNote('포토샵 방식에서 저장했습니다 — 배너 디자인 관리에서 볼 수 있습니다.')}
        />
      )}
    </div>
  );
}
