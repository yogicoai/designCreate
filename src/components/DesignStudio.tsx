'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ICONS, renderLayersToSvg, textEm, type DesignDoc, type DesignLayer } from '@/lib/design-render';
import { TEMPLATES, THEMES, findTheme } from '@/lib/banner-templates';
import {
  CHANNELS, AUTO_SET, visibleSizesFor, defaultSizeFor, channelOf,
  findSize, shapeOf, cropLoss, type Channel,
} from '@/lib/banner-sizes';
import { shrinkForUpload } from '@/lib/client-image';
import { BRAND_BUTTON_COLORS, brandButtonHex } from '@/lib/brand';

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
interface SavedTemplate { id: string; name: string; design: DesignDoc; updatedAt: string | null }

const uid = () => Math.random().toString(36).slice(2, 9);

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

export default function DesignStudio({ cuts, initial, sourceId, fonts = [] }: {
  cuts: CutOption[];
  initial?: DesignDoc;
  /** 관리 게시판에서 수정으로 연 배너의 id — 저장할 때 계보로 남긴다 */
  sourceId?: string;
  /** fonts/ 폴더에서 찾은 글꼴들 — 파일만 넣으면 서버가 목록을 만든다 */
  fonts?: { family: string; file: string }[];
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
          layers: DesignLayer[]; fit: { mode: 'cover' | 'blur' | 'color' | 'gradient'; fx: number; fy: number; fillColor?: string };
        }[];
      }
    | null
  >(null);
  const [tweakOpen, setTweakOpen] = useState(false);
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
  const [variants, setVariants] = useState<Record<string, { layers: DesignLayer[]; fit: { mode: 'cover' | 'blur' | 'color' | 'gradient'; fx: number; fy: number; fillColor?: string } }>>({});
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
  const fit = useMemo(() => ({ mode: fitMode, fx, fy, ...(fitMode === 'color' || fitMode === 'gradient' ? { fillColor } : {}) }), [fitMode, fx, fy, fillColor]);

  const design: DesignDoc = useMemo(
    () => ({ imageUrl, layers, size: { id: sizeId || undefined, w: dims.w, h: dims.h }, fit, font: fontFamily || undefined }),
    [imageUrl, layers, sizeId, dims, fit, fontFamily],
  );

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
    return { layers: j.layers as DesignLayer[], fit: j.fit as { mode: 'cover' | 'blur' | 'color' | 'gradient'; fx: number; fy: number; fillColor?: string } };
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
    setFocusTouched(true);
    setSelected(null);
    setResult(null);
    if (stored) {
      setLayers(stored.layers);
      setFitMode(stored.fit.mode);
      setFx(stored.fit.fx);
      setFy(stored.fit.fy);
      if (stored.fit.fillColor) setFillColor(stored.fit.fillColor);
      return;
    }
    setBusy('auto'); setErr('');
    try {
      const got = await fetchAutoFor(sid);
      setLayers(got.layers);
      if (got.fit) { setFitMode(got.fit.mode); setFx(got.fit.fx); setFy(got.fit.fy); }
      setVariants((v) => ({ ...v, [sid]: got }));
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
    setSelected(txts[0]?.id ?? null);
    setResult(null);
  }

  // ── 끌어서 옮기기 ──
  function onDown(e: React.PointerEvent, id: string) {
    const st = stageRef.current;
    if (!st) return;
    const l = layers.find((x) => x.id === id);
    if (!l) return;
    const r = st.getBoundingClientRect();
    dragRef.current = { id, dx: (e.clientX - r.left) / r.width - l.x, dy: (e.clientY - r.top) / r.height - l.y };
    setSelected(id);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onMove(e: React.PointerEvent) {
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
  const onUp = () => { dragRef.current = null; };

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
  /** 짝 규격들 각각의 설계도 — 무대의 것과 보관함의 것을 모은다. 하나라도 없으면 null */
  function localPairDocs(): { sizeId: string; label: string; w: number; h: number; design: DesignDoc }[] | null {
    const out: { sizeId: string; label: string; w: number; h: number; design: DesignDoc }[] = [];
    for (const sid of AUTO_SET[channel]) {
      const b = findSize(sid);
      const doc = sid === sizeId
        ? (layers.length ? { layers, fit } : null)
        : variants[sid] ?? null;
      if (!doc || !doc.layers.length) return null;
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
       * 두 버전을 탭에서 각각 손봤다면 **그 손본 배치 그대로** 저장해야 한다.
       * 서버 자동(batch)으로 다시 만들면 다듬은 게 날아간다.
       * 손본 버전이 다 있으면 로컬 설계도로, 아니면 서버 자동으로 간다.
       */
      const local = localPairDocs();
      if (local) {
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
        const pairId = Math.random().toString(36).slice(2, 10);
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
        return;
      }

      const r = await fetch('/api/design', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          batch: {
            imageUrl, eyebrow: autoEyebrow, title: autoTitle, subtitle: autoSub, cta: autoCta,
            sizeIds: AUTO_SET[channel],
            buttonColor: btnColor === 'photo' ? undefined : brandButtonHex(btnColor),
            tune: { scale: tuneScale, gap: tuneGap },
            font: fontFamily || undefined,
            sourceId,
            preview: previewOnly,
          },
        }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || '실패'); return; }
      if (previewOnly) {
        setResult({ kind: 'pair', items: j.items });
        return;
      }
      const made = (j.items as { label: string; w: number; h: number }[])
        .map((i) => `${i.label} ${i.w}×${i.h}`).join(' · ');
      setNote(`짝으로 저장했습니다 — ${made}. 배너 디자인 관리에서 볼 수 있습니다.`);
      setResult(null);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  async function saveTemplate() {
    const name = window.prompt('템플릿 이름을 지어주세요 (배경 없이 배치만 저장됩니다)');
    if (!name) return;
    setBusy('tpl');
    try {
      const r = await fetch('/api/design', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, design }),
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
    inspectorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    textRef.current?.focus();
    textRef.current?.select?.();
  }, [focusTick]);

  function openInspector(id: string) {
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
   * 오른쪽 열 맨 위에 둔다. 아래쪽에 있으면 무대에서 뭔가를 고른 뒤
   * 한참 스크롤해야 해서, 고르는 곳과 고치는 곳이 멀어진다.
   * 무대에서 두 번 누르면 여기로 와서 곧바로 문구를 고칠 수 있다.
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
  // 자동완성 묶음의 이름과 크기 — 버튼·설명에 그대로 쓴다
  const autoSet = AUTO_SET[channel].map(findSize);
  const autoSetText = autoSet.map((b) => `${b.label} ${b.w}×${b.h}`).join(' · ');
  // '저장' 을 붙이지 않는다 — 누르면 두 장을 먼저 보여주고, 확인해야 저장된다
  const autoBtnLabel = channel === 'SNS' ? '정사각·세로 자동완성' : '웹·모바일 자동완성';
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
            <button className="btn btn-primary" onClick={() => render(false)} disabled={!!busy || !layers.length}
                    title="지금 보는 규격 그대로 실제 크기로 그려 보여드리고, 확인하면 저장됩니다.">
              {busy === 'save' ? '그리는 중…' : '✔ 완성 · 저장'}
            </button>
            <button className="btn" onClick={() => saveBoth(true)} disabled={!!busy || !imageUrl}
                    title={`문구만으로 ${autoSetText} 를 자동 배치해 보여드리고, 확인하면 함께 저장됩니다. 손으로 다듬은 배치는 들어가지 않습니다.`}>
              {autoBtnLabel}
            </button>
            <button className="btn" onClick={saveTemplate} disabled={!!busy || !layers.length}
                    title="배경 없이 지금 배치만 저장해서 다른 컷에도 얹을 수 있게 합니다.">
              템플릿으로 저장
            </button>
            {note && <span className="text-[11px]" style={{ color: 'var(--ok)' }}>{note}</span>}
            {err && <span className="text-[11px]" style={{ color: 'var(--danger)' }}>{err}</span>}
          </div>
          {/* 버튼 이름만으론 부족하다 — 무엇이 몇 장 저장되는지 한 줄로 미리 말해준다 */}
          <div className="text-[10.5px] mb-2 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            <b>완성 · 저장</b> = 지금 보는 규격 한 장 ·{' '}
            <b>{autoBtnLabel.replace(' 저장', '')}</b> = 문구만으로 {channel}용 두 규격({autoSetText})을 자동 배치해 함께 저장
            — 둘 다 저장 전에 결과를 먼저 보여드리고, 확인을 눌러야 저장됩니다.
          </div>

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
                   className="absolute inset-0 w-full h-full"
                   style={{
                     objectFit: needsFit && fitMode !== 'cover' ? 'contain' : 'cover',
                     objectPosition: `${Math.round(fx * 100)}% ${Math.round(fy * 100)}%`,
                   }} />
            )}
            {/* 저장본과 같은 SVG 를 그대로 얹는다 */}
            <div className="absolute inset-0 pointer-events-none"
                 dangerouslySetInnerHTML={{ __html: svg.replace('<svg ', '<svg style="width:100%;height:100%;display:block" ') }} />
            {/*
              * 잡는 손잡이 — 레이어 중심에 점을 두고 그걸 끈다.
              * 무리마다 하나만 둔다. 버튼에 점 세 개가 뜨면 한 몸으로 안 보인다.
              * 두 번 누르면 곧바로 편집으로 넘어간다.
              */}
            {leaders(layers).map((l) => (
              <span key={l.id}
                    onPointerDown={(e) => onDown(e, l.id)}
                    onDoubleClick={() => openInspector(l.id)}
                    title={`${labelOf(l, layers)} — 끌어서 옮기기 · 두 번 눌러 수정`}
                    className="absolute rounded-full"
                    style={{
                      left: `${l.x * 100}%`, top: `${l.y * 100}%`, transform: 'translate(-50%,-50%)',
                      width: 22, height: 22, cursor: 'move',
                      border: `2px solid ${isSel(l) ? 'var(--accent)' : 'rgba(255,255,255,.55)'}`,
                      background: isSel(l) ? 'rgba(226,80,60,.25)' : 'rgba(0,0,0,.25)',
                    }} />
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
                                setNote(`${it.label} 버전을 무대에 올렸습니다 — 버전 탭으로 오가며 다듬고, [${'웹·모바일 자동완성'}]으로 짝 저장하세요.`);
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
        {inspector}

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

          <div className="label mb-1.5">생성한 컷</div>
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
        <Step n={3} title="규격" done={!!sizeId} disabled={!imageUrl}>
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

        {/* 기본 동선 — 문구만 넣고 누르면 끝난다 */}
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

        <Step n={5} title="손으로 다듬기 (선택)" open={tweakOpen} onToggle={() => setTweakOpen((v) => !v)}
              hint={layers.length ? `레이어 ${layers.length}` : undefined}>
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
                          onClick={() => { setLayers(t.design.layers.map((l) => ({ ...l, id: uid() }))); setResult(null); }}>
                    {t.name}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="flex items-center justify-between mt-3 mb-1.5">
            <div className="label">레이어</div>
            <div className="flex gap-1">
              {(['text', 'icon', 'rect', 'scrim'] as const).map((k) => (
                <button key={k} className="chip" title={`${k} 추가`}
                        onClick={() => { const l = newLayer(k, theme.strong); setLayers((c) => [...c, l]); setSelected(l.id); }}>
                  ＋{k === 'text' ? '글자' : k === 'icon' ? '아이콘' : k === 'rect' ? '도형' : '그늘'}
                </button>
              ))}
            </div>
          </div>
          {layers.length === 0 && (
            <div className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
              4번에서 자동 배치를 누르거나, ＋ 로 레이어를 추가하세요.
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
                  <span className="truncate flex-1" style={{ color: 'var(--text-dim)' }}>{labelOf(l, layers)}</span>
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
        </Step>

      </aside>
    </div>
  );
}
