'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { thumbUrl } from '@/lib/thumb';
import type { DropboxAssetDoc, DropboxSummary, DropboxSection } from '@/lib/queries';
import { PRODUCT_LABELS, UNSORTED } from '@/lib/dropbox-products';

/**
 * 자산 관리 > 드롭박스 — 팀 드롭박스에서 복사해 온 사진 보관함.
 *
 * 탭 두 개: 제품사진(2.7 제품사진 + 2.6 촬영 일부) / 브랜드 정리(0. 브랜드 이미지).
 * 폴더 칩으로 거르고, 검색하고, 사진을 누르면 팝업으로 크게 본다.
 *
 * 검수 도구는 두지 않는다 (사용자 판단 2026-09-21: "검수가 있으면 팀원들이 더 헷갈린다,
 * 알아서 보면 된다"). 처음엔 폴더명이 틀린 경우가 있어서(슬림 폴더 41장이 midi 파일명)
 * 사람이 라벨을 확정하는 화면으로 만들었지만, 쓰는 사람에게는 보관함이 더 맞다고 봤다.
 * 근거 데이터(labelStatus·filenameHint)는 DB 에 그대로 있다 — 필요하면 다시 꺼낼 수 있다.
 *
 * 원본(드롭박스)은 읽기 전용이다. 이 화면에는 원본을 건드리는 동작이 없다.
 * 숨기기는 목록에서만 빼고, 삭제는 웹 사본 파일까지 지운다 — 둘 다 드롭박스 원본은 그대로다.
 */

/*
 * 한 페이지 50장, 게시판식으로 넘긴다 (사용자 요청 2026-09-21).
 * 수천 장을 이어붙이며 쌓으면 스크롤이 길어져 어디까지 봤는지 알 수 없고,
 * 브라우저에 쌓인 이미지 요소만으로도 화면이 무거워진다. 검수는 "이 페이지를 끝냈다"
 * 가 분명해야 진도가 나가는 일이라 페이지로 끊는 쪽이 맞다.
 */
const PAGE = 50;

/*
 * 한 쪽 장수는 "50 에 가까운, 줄이 꽉 차는 수" 로 맞춘다 (사용자 요청 2026-09-21).
 * 목록이 auto-fill 그리드라 화면 폭에 따라 한 줄 칸 수가 바뀐다 — 넓은 화면은 9칸,
 * 노트북은 7~8칸. 50장 고정이면 9칸 화면에서 마지막 줄이 5장만 차고 4칸이 빈다.
 * 칸 수를 재서 9칸이면 54장, 8칸이면 48장, 7칸이면 49장으로 맞춘다.
 * 아래 두 값은 그리드 CSS(minmax 150px, gap-2.5=10px)와 같아야 칸 수 계산이 맞는다.
 */
const TILE_MIN = 150;
const TILE_GAP = 10;
function pageSizeFor(width: number): number {
  const cols = Math.max(1, Math.floor((width + TILE_GAP) / (TILE_MIN + TILE_GAP)));
  return cols * Math.max(1, Math.round(PAGE / cols));
}

type Filters = { folder: string; status: string; labeled: string; q: string; product: string };
const NO_FILTERS: Filters = { folder: '', status: '', labeled: '', q: '', product: '' };

export default function DropboxManager({
  initial,
  initialSummary,
  counts: initialCounts,
}: {
  initial: DropboxAssetDoc[];
  initialSummary: DropboxSummary;
  /** 탭에 띄울 갈래별 장수 */
  counts: { product: number; brand: number };
}) {
  const [section, setSection] = useState<DropboxSection>('product');
  const [counts, setCounts] = useState(initialCounts);
  const [items, setItems] = useState<DropboxAssetDoc[]>(initial);
  const [summary, setSummary] = useState<DropboxSummary>(initialSummary);
  const [total, setTotal] = useState(initialSummary.total);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  /** 제품 칩 장수 — 지금 폴더·검색 안에서. 라벨이 하나도 없으면 칩 줄을 숨긴다 */
  const [productCounts, setProductCounts] = useState<{ product: string; total: number }[]>([]);
  /*
   * 제품 정리 모드 (사용자 요청 2026-09-22) — 켜야만 보인다. 팀원 화면은 그대로 두려는 것
   * ("검수 도구가 있으면 팀원들이 헷갈린다", 2026-09-21).
   * 켜면: 사진 클릭 = 선택, Shift+클릭 = 구간 선택(쪽이 달라도 된다), 아래 제품 버튼으로 한 번에 라벨.
   */
  const [labelMode, setLabelMode] = useState(false);
  /** 구간의 첫 장 — 마지막으로 그냥 클릭한 사진 */
  const [anchor, setAnchor] = useState<{ url: string; title: string } | null>(null);
  /** Shift 로 고른 구간. 서버가 화면과 같은 순서로 사이를 찾아 라벨을 붙인다 */
  const [range, setRange] = useState<{ from: string; to: string; fromTitle: string; toTitle: string } | null>(null);
  /** 붙일 제품 버튼들 — 여러 개 고를 수 있다 */
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  /*
   * 한 쪽 장수 — 그리드 폭을 재기 전에는 null 이다. null 인 동안에는 받지 않는다:
   * 50장으로 한 번 받고 폭을 잰 뒤 54장으로 또 받으면 요청이 두 번 나간다.
   */
  const [pageSize, setPageSize] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /** 숨기기처럼 사람이 누른 작업이 도는 중 — 목록 받기와는 따로 센다 */
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** 알림(숨겼습니다 등) — 목록을 새로 받아도 지우지 않는다 */
  const [msg, setMsg] = useState('');
  /** 목록을 못 받았을 때만 뜬다 — 다음에 받으면 지운다 */
  const [loadErr, setLoadErr] = useState('');
  /**
   * 팝업으로 크게 보는 사진의 주소. null = 닫힘.
   * 번호가 아니라 주소로 들고 있어서, 쪽이나 탭이 바뀌어 그 사진이 화면에서 빠지면 팝업도 저절로 닫힌다.
   */
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  /** 숨긴 뒤 같은 쪽을 다시 받게 하는 신호 */
  const [tick, setTick] = useState(0);
  /** 어느 탭에서 보낸 요청인지 — 응답이 늦게 와도 다른 탭 화면을 덮지 않게 */
  const sectionRef = useRef<DropboxSection>('product');
  useEffect(() => { sectionRef.current = section; }, [section]);

  /*
   * 필터를 바꾸면 1쪽으로 돌아간다 — 3쪽을 보던 중에 조건을 좁히면 그 쪽이 비어 있을 수 있다.
   * effect 로 "필터가 바뀌면 page=0" 을 하지 않고 바꾸는 자리에서 같이 한다 (렌더가 두 번 도는 것을 막는다).
   */
  const changeFilters = (fn: (f: Filters) => Filters) => { setFilters(fn); setPage(0); setViewUrl(null); };
  const goPage = (p: number) => { setPage(p); setViewUrl(null); };

  /** 검색은 타이핑마다 부르면 안 된다 — 멈춘 뒤에 한 번만 */
  const [qInput, setQInput] = useState('');
  useEffect(() => {
    if (qInput === filters.q) return;
    const t = setTimeout(() => changeFilters((f) => ({ ...f, q: qInput })), 350);
    return () => clearTimeout(t);
  }, [qInput, filters.q]);

  /*
   * 그리드 폭을 재서 한 쪽 장수를 정한다. 창 크기를 바꾸면 다시 잰다.
   * 장수가 바뀌면 보던 첫 장이 그대로 보이는 쪽으로 옮긴다 — 3쪽을 보다 창을 줄였는데
   * 전혀 다른 사진이 나오면 어디까지 검수했는지 잃는다.
   */
  const sizeRef = useRef<number | null>(null);
  const widthRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    // 이전 장수는 ref 로 들고 있는다 — setState 업데이터 안에서 다른 setState 를 부르면
    // 개발 모드(StrictMode)에서 업데이터가 두 번 돌아 쪽이 두 번 옮겨진다
    const apply = () => {
      const w = el.clientWidth;
      /*
       * 스크롤바 폭(약 15~17px) 미만의 변화는 무시한다. 칸 경계 근처 폭에서는
       * "칸이 늘어 줄이 늘어남 → 스크롤바가 생김 → 폭이 줄어 칸이 줄어듦 → 스크롤바가 사라짐" 이
       * 끝없이 반복돼 쪽이 튄다(2026-09-21 검토). 전역 scrollbar-gutter 를 쓰면 다른 화면이 전부 밀려서
       * 이 그리드 안에서만 막는다.
       */
      if (widthRef.current !== null && Math.abs(w - widthRef.current) < 20) return;
      widthRef.current = w;
      const next = pageSizeFor(w);
      const prev = sizeRef.current;
      if (prev === next) return;
      sizeRef.current = next;
      if (prev) setPage((p) => Math.floor((p * prev) / next));
      setPageSize(next);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const qs = useCallback((skip: number, withSummary = false, limit = pageSize ?? PAGE) => {
    const p = new URLSearchParams({ skip: String(skip), limit: String(limit) });
    if (filters.folder) p.set('folder', filters.folder);
    if (filters.status) p.set('status', filters.status);
    if (filters.labeled) p.set('labeled', filters.labeled);
    if (filters.q) p.set('q', filters.q);
    if (filters.product) p.set('product', filters.product);
    if (withSummary) p.set('summary', '1');
    if (section === 'brand') p.set('section', 'brand');
    return p.toString();
  }, [filters, pageSize, section]);

  /*
   * 갈래를 바꾸면 필터를 전부 비운다 — 제품사진의 「서포트」 폴더 칩이 브랜드 정리 탭에 남아 있으면
   * 0장이 뜬다. 검색어·선택·팝업도 같이 비운다.
   */
  const switchSection = (next: DropboxSection) => {
    if (next === section) return;
    setSection(next);
    setQInput('');
    setFilters(NO_FILTERS);
    setPage(0);
    setMsg('');
    setPicked(new Set());
    setViewUrl(null);
    setAnchor(null);
    setRange(null);
  };

  /*
   * 지금 화면이 원하는 목록 — 폭을 재기 전에는 없다(null). tick 은 숨긴 뒤 같은 쪽을 다시 받게 한다.
   * "불러오는 중" 은 이 키가 마지막으로 받은 키와 다른지로 판단한다 — effect 안에서
   * setLoading(true) 를 바로 부르면 렌더가 한 번 더 돈다.
   */
  const reqQuery = pageSize === null ? null : qs(page * pageSize, true);
  const reqKey = reqQuery === null ? null : `${reqQuery}|${tick}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loading = busy || (reqKey !== null && loadedKey !== reqKey);

  /*
   * 쪽을 받는다. 이어붙이지 않고 갈아끼운다 — 게시판이므로 화면에는 이 쪽만 산다.
   * 응답이 도착한 뒤에 선택을 비운다: 받는 동안 옛 사진에서 고른 것이 새 쪽까지 따라오지 않게.
   * 탭 장수는 요청을 보낸 탭 쪽만 고친다 — 탭을 빨리 바꾸면 다른 탭 숫자가 들어가던 문제(2026-09-21 검토).
   */
  useEffect(() => {
    if (reqQuery === null || reqKey === null || pageSize === null) return;
    let alive = true;
    const sec = section;
    fetch(`/api/dropbox?${reqQuery}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (!j?.ok) { setLoadErr(j?.error ?? '목록을 불러오지 못했습니다.'); setLoadedKey(reqKey); return; }
        const assets: DropboxAssetDoc[] = j.assets ?? [];
        const tot: number = j.total ?? 0;
        // 숨겨서 마지막 쪽이 비었으면 남은 마지막 쪽으로 — 빈 화면에 "3 / 2쪽" 이 뜨지 않게
        if (!assets.length && tot > 0 && page > 0) { setPage(Math.max(0, Math.ceil(tot / pageSize) - 1)); return; }
        setItems(assets);
        setTotal(tot);
        if (j.summary) {
          setSummary(j.summary);
          // 요약은 필터와 무관한 갈래 전체 수라 그대로 탭 숫자가 된다
          setCounts((c) => ({ ...c, [sec]: j.summary.total }));
        }
        setProductCounts(Array.isArray(j.productCounts) ? j.productCounts : []);
        // 구간(range)은 비우지 않는다 — 첫 장을 고른 뒤 다른 쪽으로 넘어가 마지막 장을 고르는 게 구간 선택이다
        setPicked(new Set());
        setLoadErr('');
        setLoadedKey(reqKey);
      })
      .catch(() => { if (alive) { setLoadErr('목록을 불러오지 못했습니다.'); setLoadedKey(reqKey); } });
    return () => { alive = false; };
  }, [reqQuery, reqKey, section, page, pageSize]);

  const toggle = (url: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  };

  const hidePicked = async () => {
    const urls = [...picked];
    if (!urls.length) return;
    const sec = section;
    setBusy(true);
    try {
      const r = await fetch('/api/dropbox', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
      const j = await r.json().catch(() => null);
      if (sectionRef.current !== sec) return;   // 그 사이 탭을 바꿨으면 다른 탭 화면에 알림을 띄우지 않는다
      if (!j?.ok) { setMsg(j?.error ?? '숨기지 못했습니다.'); return; }
      setMsg(`${urls.length}장을 숨겼습니다. 원본은 드롭박스에 그대로 있습니다.`);
      // 숨기면 뒤 사진이 한 칸씩 당겨진다 — 이 쪽을 다시 받는다. 받는 일은 위 effect 가 한다
      setTick((t) => t + 1);
    } finally { setBusy(false); }
  };

  /*
   * 삭제 (사용자 요청 2026-09-22) — 숨김과 달리 되돌릴 수 없다. 지우는 것은 웹 사본(cafe24)과
   * 목록뿐이고 드롭박스 원본은 그대로다. 생성 컷이 참조로 쓴 사진은 서버가 숨김만 한다.
   */
  const deletePicked = async () => {
    const urls = [...picked];
    if (!urls.length) return;
    if (!window.confirm(
      `선택한 ${urls.length}장을 삭제합니다.\n\n` +
      '웹 사본 파일과 목록에서 완전히 지워지고 되돌릴 수 없습니다.\n' +
      '드롭박스 원본 파일은 그대로 남습니다.',
    )) return;
    const sec = section;
    setBusy(true);
    try {
      const r = await fetch('/api/dropbox', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls, purge: true }),
      });
      const j = await r.json().catch(() => null);
      if (sectionRef.current !== sec) return;
      if (!j?.ok) { setMsg(j?.error ?? '삭제하지 못했습니다.'); return; }
      const notes = [
        j.keptInUse ? `생성 컷에 쓰인 ${j.keptInUse}장은 숨김만` : '',
        j.failed ? `${j.failed}장은 파일 삭제 실패 — 숨김 처리` : '',
      ].filter(Boolean);
      setMsg(`${j.deleted}장을 삭제했습니다.${notes.length ? ` (${notes.join(' · ')})` : ''} 드롭박스 원본은 그대로 있습니다.`);
      setTick((t) => t + 1);
    } finally { setBusy(false); }
  };

  /*
   * 정리 모드의 사진 클릭. 그냥 클릭 = 한 장 선택/해제(+구간의 첫 장으로 기억),
   * Shift+클릭 = 첫 장~이 사진까지 구간. 같은 쪽이면 사이를 화면에서도 칠하고, 다른 쪽이면
   * 끝 두 장만 칠한다 — 실제 사이 사진은 라벨을 붙일 때 서버가 같은 순서로 찾는다.
   */
  const tileClick = (e: React.MouseEvent, it: DropboxAssetDoc) => {
    if (e.shiftKey && anchor && anchor.url !== it.url) {
      const a = shown.findIndex((x) => x.url === anchor.url);
      const b = shown.findIndex((x) => x.url === it.url);
      setPicked(new Set(a >= 0 ? shown.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.url) : [it.url]));
      setRange({ from: anchor.url, to: it.url, fromTitle: anchor.title, toTitle: it.title });
      return;
    }
    toggle(it.url);
    setAnchor({ url: it.url, title: it.title });
    setRange(null);
  };

  const clearSelection = () => { setPicked(new Set()); setRange(null); setAnchor(null); };

  /** 고른 사진(또는 구간)에 제품 라벨을 붙인다. products 가 빈 배열이면 미분류로 되돌린다 */
  const applyProducts = async (products: string[]) => {
    const urls = [...picked];
    if (!range && !urls.length) return;
    setBusy(true);
    try {
      const body = range
        ? { range: { from: range.from, to: range.to }, products, filter: { folder: filters.folder, q: filters.q, product: filters.product, section } }
        : { urls, products };
      const r = await fetch('/api/dropbox', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      if (!j?.ok) { setMsg(j?.error ?? '라벨을 붙이지 못했습니다.'); return; }
      setMsg(`${(j.count ?? urls.length).toLocaleString()}장 → ${products.length ? products.join(' · ') : UNSORTED}`);
      clearSelection();
      setChosen(new Set());
      setTick((t) => t + 1);
    } finally { setBusy(false); }
  };

  const chip = (active: boolean) => ({
    background: active ? 'var(--accent-soft)' : 'var(--surface-2)',
    color: active ? 'var(--accent)' : 'var(--text-dim)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
  });

  const pageBtn = (active: boolean, disabled: boolean): React.CSSProperties => ({
    background: active ? 'var(--accent)' : 'var(--surface-2)',
    color: active ? '#fff' : 'var(--text-dim)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
    borderRadius: 'var(--radius)',
    padding: '5px 10px',
    fontSize: 12,
    fontWeight: active ? 700 : 500,
    opacity: disabled ? 0.4 : 1,
    cursor: disabled ? 'default' : 'pointer',
    minWidth: 32,
  });

  const size = pageSize ?? PAGE;
  const pageCount = Math.ceil(total / size);
  /* 쪽 번호는 현재 쪽 주변 7개만 — 서포트 683장이면 14쪽, 전체 1,687장이면 34쪽이라 다 그리면 줄이 넘친다 */
  const pageWindow = useMemo(() => {
    const span = 7;
    let from = Math.max(0, page - Math.floor(span / 2));
    const to = Math.min(pageCount, from + span);
    from = Math.max(0, to - span);
    return Array.from({ length: to - from }, (_, i) => from + i);
  }, [page, pageCount]);


  /*
   * 팝업 — 이 쪽에 보이는 사진들 사이를 ← → 로 넘긴다.
   * 보는 사진을 주소로 찾으므로, 쪽·탭이 바뀌어 그 사진이 화면에서 빠지면 viewing 이 null 이 되어 저절로 닫힌다.
   */
  const shown = items.slice(0, size);
  const viewIdx = viewUrl === null ? -1 : shown.findIndex((it) => it.url === viewUrl);
  const viewing = viewIdx >= 0 ? shown[viewIdx] : null;
  const stepView = (d: number) => {
    const next = shown[viewIdx + d];
    if (next) setViewUrl(next.url);
  };
  useEffect(() => {
    if (!viewing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewUrl(null);
      else if (e.key === 'ArrowRight') stepView(1);
      else if (e.key === 'ArrowLeft') stepView(-1);
    };
    window.addEventListener('keydown', onKey);
    // 팝업이 떠 있는 동안 뒤 목록이 스크롤되지 않게
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prevOverflow; };
  });

  const isBrand = section === 'brand';
  const tabStyle = (on: boolean): React.CSSProperties => ({
    padding: '8px 16px', fontSize: 13.5, fontWeight: on ? 800 : 600, cursor: 'pointer',
    color: on ? 'var(--accent)' : 'var(--text-dim)', background: 'transparent', border: 'none',
    borderBottom: `2px solid ${on ? 'var(--accent)' : 'transparent'}`, marginBottom: -1,
  });

  return (
    <div className="space-y-4">
      {/*
        두 갈래 탭 (사용자 요청 2026-09-21) — 제품사진은 검수 도구, 브랜드 정리는 캠페인별 보관함.
        성격이 달라서 한 목록에 섞으면 브랜드 85장이 제품사진 수천 장에 묻힌다.
      */}
      <nav className="flex items-end gap-1" style={{ borderBottom: '1px solid var(--line)' }}>
        <button style={tabStyle(!isBrand)} onClick={() => switchSection('product')}>
          제품사진 <span style={{ fontWeight: 500, opacity: 0.7 }}>{counts.product.toLocaleString()}</span>
        </button>
        <button style={tabStyle(isBrand)} onClick={() => switchSection('brand')}>
          브랜드 정리 <span style={{ fontWeight: 500, opacity: 0.7 }}>{counts.brand.toLocaleString()}</span>
        </button>
      </nav>

      {/*
        검수 도구는 두지 않는다 (사용자 판단 2026-09-21: "검수가 있으면 팀원들이 더 헷갈린다,
        알아서 보면 된다"). 그냥 보관함 — 폴더로 거르고, 검색하고, 눌러서 크게 본다.
        (DB 의 labelStatus·filenameHint 는 그대로 남아 있다 — 나중에 필요하면 다시 꺼낼 수 있다.)
      */}
      {!isBrand && (
        <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
          드롭박스 「2.7 제품사진」과 「2.6 촬영」에서 가져온 제품사진 {summary.total.toLocaleString()}장을 제품별로 묶었습니다.
          촬영 폴더 사진은 AI 가 제품을 판별해 넣은 것이라 <b>점선 라벨</b>로 보입니다 — 틀린 건 「제품 정리 모드」에서 고쳐 주세요.
          사진을 누르면 크게 볼 수 있습니다.
        </p>
      )}

      {/* 브랜드 정리 안내 */}
      {isBrand && (
        <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
          드롭박스 「0. 브랜드 이미지 (2025 월별 글로벌 에셋 정리)」의 캠페인 비주얼 {summary.total.toLocaleString()}장입니다.
          캠페인 이름이 파일명에 들어 있어요 — 검색창에 <b>04월</b>, <b>PASTEL</b>, <b>Winter</b> 처럼 치면 그 캠페인만 나옵니다.
        </p>
      )}

      {/* 필터 */}
      <section className="space-y-2.5">
        {/*
          브랜드 정리는 캠페인별로 칩을 나누지 않는다 (사용자 요청 2026-09-21: "폴더로 각각 나눌 필요 없고
          하나로 묶어놓고 파일명만"). 캠페인 이름은 제목에 들어 있어서 검색창에 「04월」「PASTEL」 로 찾는다.
        */}
        {/*
          제품사진 탭은 「제품」 칩 한 줄로만 거른다 (사용자 요청 2026-09-22: "제품 폴더링만 남는 게 베스트").
          예전의 드롭박스 폴더 칩(2018·2021 같은 촬영 연도 폴더 포함)은 없앴다 — 촬영 폴더 사진은 AI 가 제품을 판별해
          라벨을 넣었고, 원래 제품 폴더(맥스·서포트…)에 있던 사진은 폴더 이름을 라벨로 넣었다. 그래서 같은 사진이
          연도 칩과 제품 칩에 두 번 나올 이유가 없다. 원래 폴더는 사진 아래 📁 표시와 팝업의 원본 경로로 남는다.
          한 장에 제품이 여럿이면 각 칩에 한 번씩 센다.
        */}
        {!isBrand && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="label mr-1">제품</span>
            <button onClick={() => changeFilters((f) => ({ ...f, product: '', folder: '' }))}
                    className="text-[12px] px-2.5 py-1 rounded-full" style={chip(!filters.product)}>
              전체 {summary.total.toLocaleString()}
            </button>
            {productCounts.map((p) => (
              <button key={p.product} onClick={() => changeFilters((f) => ({ ...f, product: p.product }))}
                      className="text-[12px] px-2.5 py-1 rounded-full" style={chip(filters.product === p.product)}>
                {p.product} {p.total.toLocaleString()}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-1.5 flex-wrap">
          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder={isBrand ? '캠페인 검색 (예: 04월, PASTEL, Winter)' : '파일명 · 원본경로 검색'}
            className="ml-auto text-[12px] px-2.5 py-1.5 rounded-lg w-[220px]"
            style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
          />
        </div>
      </section>

      {/* 고른 것에 라벨 찍기 — 선택이 있을 때만 나온다 */}
      {(picked.size > 0 || range) && (
        <section className="rounded-xl p-3 space-y-2 sticky top-2 z-20"
                 style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)' }}>
          {/* 정리 모드 — 제품 버튼. 여러 개 골라 [붙이기] */}
          {labelMode && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[12px] font-bold mr-1" style={{ color: 'var(--accent)' }}>제품</span>
              {PRODUCT_LABELS.map((p) => {
                const on = chosen.has(p);
                return (
                  <button key={p}
                          onClick={() => setChosen((prev) => {
                            const next = new Set(prev);
                            if (next.has(p)) next.delete(p);
                            else { if (p === '제품 없음') next.clear(); else next.delete('제품 없음'); next.add(p); }
                            return next;
                          })}
                          className="text-[12px] px-2.5 py-1 rounded-full"
                          style={{ ...chip(on), cursor: 'pointer', fontWeight: on ? 700 : 500 }}>
                    {p}
                  </button>
                );
              })}
              <button onClick={() => applyProducts([...chosen])} disabled={loading || !chosen.size}
                      className="text-[12px] px-3 py-1.5 rounded-lg font-bold ml-1"
                      style={{ background: chosen.size ? 'var(--accent)' : 'var(--surface-2)', color: chosen.size ? '#fff' : 'var(--text-mute)', border: 'none', cursor: chosen.size ? 'pointer' : 'default' }}>
                붙이기
              </button>
              <button onClick={() => applyProducts([])} disabled={loading}
                      className="text-[12px] px-2.5 py-1.5 rounded-lg"
                      style={{ background: 'transparent', border: '1px solid var(--line)', color: 'var(--text-mute)', cursor: 'pointer' }}
                      title="라벨을 지워 미분류로 되돌린다">
                미분류로
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-bold" style={{ color: 'var(--accent)' }}>
            {range ? `구간 선택: ${range.fromTitle} → ${range.toTitle}` : `${picked.size}장 선택`}
          </span>
          {range && <span className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>사이의 사진은 붙일 때 모두 포함됩니다 (다른 쪽 포함)</span>}
          {/* 숨기기·삭제는 눈에 보이는 선택에만 — 구간(다른 쪽까지)으로 지우면 무엇이 지워지는지 안 보인다 */}
          {!range && (<>
          <button onClick={hidePicked} disabled={loading}
                  className="text-[12px] px-3 py-1.5 rounded-lg"
                  style={{ background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text-dim)', cursor: 'pointer' }}>
            숨기기
          </button>
          <button onClick={deletePicked} disabled={loading}
                  className="text-[12px] px-3 py-1.5 rounded-lg"
                  style={{ background: 'var(--surface)', border: '1px solid var(--danger, #e5484d)', color: 'var(--danger, #e5484d)', cursor: 'pointer' }}>
            삭제
          </button>
          </>)}
          <button onClick={clearSelection}
                  className="text-[12px] px-3 py-1.5 rounded-lg ml-auto"
                  style={{ background: 'transparent', border: '1px solid var(--line)', color: 'var(--text-mute)', cursor: 'pointer' }}>
            선택 해제
          </button>
          </div>
        </section>
      )}

      {msg && (
        <div className="text-[12px] px-3 py-2 rounded-lg" style={{ background: 'var(--surface-2)', color: 'var(--text-dim)' }}>
          {msg}
        </div>
      )}
      {loadErr && (
        <div className="text-[12px] px-3 py-2 rounded-lg" style={{ background: 'var(--surface-2)', color: 'var(--danger, #e5484d)' }}>
          {loadErr} 잠시 뒤 다른 쪽을 눌러 다시 시도해 주세요.
        </div>
      )}

      <div className="flex items-center gap-3 text-[12px]" style={{ color: 'var(--text-mute)' }}>
        <span>
          전체 {total.toLocaleString()}장 · <b>{pageCount ? page + 1 : 0} / {pageCount.toLocaleString()}</b>쪽
          {items.length > 0 && ` (${(page * size + 1).toLocaleString()}–${(page * size + items.length).toLocaleString()}번)`}
        </span>
        {items.length > 0 && (
          <button onClick={() => { setRange(null); setPicked(new Set(items.map((i) => i.url))); }}
                  className="underline" style={{ cursor: 'pointer' }}>
            이 쪽 전부 선택
          </button>
        )}
        {!isBrand && (
          <button onClick={() => { setLabelMode((v) => !v); clearSelection(); setChosen(new Set()); }}
                  className="ml-auto text-[12px] px-2.5 py-1 rounded-lg"
                  style={{ cursor: 'pointer', background: labelMode ? 'var(--accent)' : 'transparent', color: labelMode ? '#fff' : 'var(--text-mute)', border: `1px solid ${labelMode ? 'var(--accent)' : 'var(--line)'}` }}
                  title="사진 클릭 = 선택, Shift+클릭 = 구간 선택, 제품 버튼으로 라벨">
            {labelMode ? '✓ 제품 정리 모드' : '제품 정리 모드'}
          </button>
        )}
      </div>
      {labelMode && (
        <p className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
          사진을 누르면 선택, <b>Shift</b>를 누른 채 다른 사진을 누르면 그 사이 전부(다른 쪽 포함)가 한 구간이 됩니다.
          위에 뜨는 제품 버튼을 고르고 [붙이기]. 점선 라벨은 AI 가 붙인 것, 채운 실선은 사람이 확정한 것, 빈 실선은 원래 제품 폴더에 있던 것입니다.
        </p>
      )}

      {/* 목록 */}
      <div ref={gridRef} className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_MIN}px, 1fr))` }}>
        {/* 첫 응답 전에는 서버가 실어 보낸 첫 묶음(200장)이 들어 있다 — 한 쪽 장수만큼만 그린다 */}
        {shown.map((it) => {
          const on = picked.has(it.url);
          return (
            <div key={it.url} className="rounded-lg overflow-hidden"
                 style={{ background: 'var(--surface)', border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`, outline: on ? '1px solid var(--accent)' : 'none' }}>
              {/*
                이미지 클릭 = 팝업으로 크게 보기 (사용자 요청 2026-09-21 — 새 탭 말고 팝업).
                선택(라벨·숨기기 대상 고르기)은 아래 줄의 작은 아이콘으로 한다.
              */}
              <div className="relative">
                {/* 정리 모드에서는 클릭 = 선택(Shift = 구간). 크게 보기는 오른쪽 위 🔍 */}
                <button onClick={(e) => (labelMode ? tileClick(e, it) : setViewUrl(it.url))} className="block w-full"
                        style={{ cursor: labelMode ? 'pointer' : 'zoom-in' }}
                        title={labelMode ? '클릭 = 선택 · Shift+클릭 = 구간' : '크게 보기'}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={thumbUrl(it.url, 256)} alt={it.title} loading="lazy"
                       className="w-full aspect-square object-cover block select-none"
                       style={{ background: 'var(--surface-2)', opacity: on ? 0.75 : 1 }} />
                </button>
                {labelMode && (
                  <button onClick={() => setViewUrl(it.url)} aria-label="크게 보기"
                          className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full text-[12px] flex items-center justify-center"
                          style={{ cursor: 'zoom-in', background: 'rgba(0,0,0,.55)', color: '#fff', border: 'none' }}>🔍</button>
                )}
                {on && (
                  <span className="absolute top-1.5 left-1.5 w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold pointer-events-none"
                        style={{ background: 'var(--accent)', color: '#fff' }}>✓</span>
                )}
              </div>
              <div className="px-2 py-1.5 space-y-1">
                <div className="flex items-center gap-1.5">
                  {/* 선택 아이콘 — 여러 장 골라 숨길 때 */}
                  <button onClick={() => toggle(it.url)} aria-pressed={on} title={on ? '선택 해제' : '선택'}
                          className="shrink-0 w-[18px] h-[18px] rounded flex items-center justify-center text-[11px] font-bold"
                          style={{
                            cursor: 'pointer',
                            background: on ? 'var(--accent)' : 'transparent',
                            color: on ? '#fff' : 'var(--text-mute)',
                            border: `1.5px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                          }}>
                    {on ? '✓' : ''}
                  </button>
                  <div className="text-[11px] truncate min-w-0" title={it.title}>{it.title}</div>
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  {isBrand ? (
                    // 캠페인 이름은 바로 위 제목에 있다 — 여기엔 시즌/월별만
                    <span className="text-[9.5px] px-1.5 py-[2px] rounded-full"
                          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }} title="시즌 캠페인 / 월별 캠페인">
                      {it.group || '월별'}
                    </span>
                  ) : (
                  <span className="text-[9.5px] px-1.5 py-[2px] rounded-full"
                        style={{ background: 'var(--surface-2)', color: 'var(--text-mute)' }} title="드롭박스 폴더">
                    📁 {it.folderHint}
                  </span>
                  )}
                  {/* 제품 라벨 — 점선 = AI 1차, 실선 = 사람이 확정 */}
                  {!isBrand && it.products.map((p) => (
                    <span key={p} className="text-[9.5px] px-1.5 py-[1px] rounded-full"
                          style={{
                            color: 'var(--accent)', background: it.productsSource === 'human' ? 'var(--accent-soft)' : 'transparent',
                            border: `1px ${it.productsSource === 'ai' ? 'dashed' : 'solid'} var(--accent)`,
                          }}
                          title={it.productsSource === 'human' ? '확정' : it.productsSource === 'folder' ? '원래 제품 폴더' : `AI 1차${it.aiConfidence !== null ? ` · 확신도 ${Math.round(it.aiConfidence * 100)}%` : ''}`}>
                      {p}
                    </span>
                  ))}
                  {!isBrand && labelMode && !it.products.length && (
                    <span className="text-[9.5px] px-1.5 py-[1px] rounded-full" style={{ color: 'var(--text-mute)', border: '1px dashed var(--line)' }}>
                      {UNSORTED}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 크게 보기 팝업 — 새 탭 대신 (사용자 요청 2026-09-21). 바깥을 누르거나 Esc 로 닫는다 */}
      {viewing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8"
             style={{ background: 'rgba(0,0,0,.82)' }}
             onClick={() => setViewUrl(null)} role="dialog" aria-modal="true" aria-label={viewing.title}>
          <div className="relative flex flex-col items-center max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={viewing.url} alt={viewing.title}
                 className="block rounded-lg object-contain"
                 style={{ maxWidth: '92vw', maxHeight: '78vh', background: '#111' }} />

            <div className="mt-3 w-full flex items-center gap-3 flex-wrap text-[12.5px]" style={{ color: '#e8e8e8' }}>
              <span className="font-bold text-[14px]">{viewing.title}</span>
              <span style={{ opacity: 0.6 }}>{viewIdx + 1} / {shown.length}</span>
              {viewing.width > 0 && <span style={{ opacity: 0.6 }}>{viewing.width}×{viewing.height}</span>}
              <span className="ml-auto flex items-center gap-2">
                {/* 팝업에서 보다가 바로 고를 수 있게 — 목록의 선택 아이콘과 같은 것 */}
                <button onClick={() => toggle(viewing.url)}
                        className="px-3 py-1.5 rounded-lg text-[12px] font-semibold"
                        style={{
                          cursor: 'pointer',
                          background: picked.has(viewing.url) ? 'var(--accent)' : 'rgba(255,255,255,.12)',
                          color: '#fff', border: '1px solid rgba(255,255,255,.2)',
                        }}>
                  {picked.has(viewing.url) ? '✓ 선택됨' : '선택'}
                </button>
                <button onClick={() => setViewUrl(null)} aria-label="닫기"
                        className="px-3 py-1.5 rounded-lg text-[12px]"
                        style={{ cursor: 'pointer', background: 'rgba(255,255,255,.12)', color: '#fff', border: '1px solid rgba(255,255,255,.2)' }}>
                  닫기 ✕
                </button>
              </span>
            </div>
            {/* 드롭박스 원본 위치 — cafe24 에는 2000px 축소본만 있다. 원본 화질이 필요하면 여기서 찾는다 */}
            <div className="mt-1 w-full text-[11px] truncate" style={{ color: 'rgba(255,255,255,.5)' }} title={viewing.sourcePath}>
              드롭박스 원본: {viewing.sourcePath}
            </div>

            {viewIdx > 0 && (
              <button onClick={() => stepView(-1)} aria-label="이전 사진"
                      className="absolute left-[-6px] sm:left-[-52px] top-[38vh] -translate-y-1/2 w-10 h-10 rounded-full text-[18px]"
                      style={{ cursor: 'pointer', background: 'rgba(255,255,255,.14)', color: '#fff', border: 'none' }}>‹</button>
            )}
            {viewIdx < shown.length - 1 && (
              <button onClick={() => stepView(1)} aria-label="다음 사진"
                      className="absolute right-[-6px] sm:right-[-52px] top-[38vh] -translate-y-1/2 w-10 h-10 rounded-full text-[18px]"
                      style={{ cursor: 'pointer', background: 'rgba(255,255,255,.14)', color: '#fff', border: 'none' }}>›</button>
            )}
          </div>
        </div>
      )}

      {pageCount > 1 && (
        <nav className="flex items-center justify-center gap-1 pt-3 flex-wrap" aria-label="쪽 넘기기">
          <button onClick={() => goPage(0)} disabled={page === 0} style={pageBtn(false, page === 0)}>«</button>
          <button onClick={() => goPage(Math.max(0, page - 1))} disabled={page === 0} style={pageBtn(false, page === 0)}>이전</button>
          {pageWindow.map((p) => (
            <button key={p} onClick={() => goPage(p)} style={pageBtn(p === page, false)}>{p + 1}</button>
          ))}
          <button onClick={() => goPage(Math.min(pageCount - 1, page + 1))} disabled={page >= pageCount - 1}
                  style={pageBtn(false, page >= pageCount - 1)}>다음</button>
          <button onClick={() => goPage(pageCount - 1)} disabled={page >= pageCount - 1}
                  style={pageBtn(false, page >= pageCount - 1)}>»</button>
        </nav>
      )}

      {!loading && items.length === 0 && (
        <div className="text-[13px] py-10 text-center" style={{ color: 'var(--text-mute)' }}>
          조건에 맞는 사진이 없습니다.
        </div>
      )}
    </div>
  );
}
