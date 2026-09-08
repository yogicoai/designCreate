'use client';

import { useEffect, useRef, useState } from 'react';
import Zoomable from '@/components/Zoomable';
import { shrinkForUpload, formatBytes } from '@/lib/client-image';
import { thumbUrl } from '@/lib/thumb';
import type { ReferenceDoc } from '@/lib/queries';

/**
 * 자산관리 > 레퍼런스 — 등록·이름변경·이미지 교체·숨김·완전 삭제.
 * 생성 화면(/create)의 보관함과 같은 컬렉션(references)을 쓴다.
 *
 * 숨김 = 목록에서만 제거 (파일 유지 — 생성 이력이 참조할 수 있음)
 * 삭제 = DB + FTP 파일까지 제거. 생성 컷 기록에 쓰였으면 한 번 더 확인받는다.
 *        디자인 빌더(eventTemp)에서 가져온 항목은 파일이 그쪽 자산이라 목록에서만 빠진다.
 */

/*
 * 레퍼런스 분류 — 내용 기준 3종. (구 체계 web-banner/mobile/sns-story/thumbnail 은 아래로 통합)
 *   촬영 = 실제 촬영·연출 컷 (구 thumbnail)
 *   배너 = 배너 규격 (구 web-banner + mobile)
 *   SNS  = SNS (구 sns + sns-story)
 * 구 값이 들어와도 화면에서 3종으로 보이도록 매핑을 함께 둔다.
 */
const CATEGORY_KR: Record<string, string> = {
  shoot: '촬영',
  banner: '배너',
  sns: 'SNS',
  interior: '인테리어',
  instagram: '인스타그램',
  model: '모델컷',
  // 구 값 폴백
  'web-banner': '배너',
  mobile: '배너',
  'sns-story': 'SNS',
  thumbnail: '촬영',
};

/** 등록·변경 시 고르는 분류 (구 값 정규화는 서버 getReferences·API 에서 처리) */
const CATEGORY_OPTIONS: { value: string; label: string; desc: string }[] = [
  { value: 'shoot', label: '촬영', desc: '실제 촬영·연출 컷' },
  { value: 'banner', label: '배너', desc: '자사몰·스마트스토어·모바일 배너 규격' },
  { value: 'sns', label: 'SNS', desc: '인스타 정사각·스토리·릴스' },
  { value: 'interior', label: '인테리어', desc: '빈 공간·인테리어 컷 — 생성 시 「배경으로 사용」 소스' },
  { value: 'instagram', label: '인스타그램', desc: '인스타 게시물 (자동 백필 — 새 게시물은 스크립트 재실행)' },
  { value: 'model', label: '모델컷', desc: '전속 모델 인물 컷 — 포즈·표정·연출 레퍼런스' },
];

export default function ReferencesManager(
  { initial, talents = [] }: { initial: ReferenceDoc[]; talents?: { code: string; label: string }[] },
) {
  const [items, setItems] = useState<ReferenceDoc[]>(initial);
  /*
   * 목록 불러오기 — 3단 구조로 "두 번째부터는 기다림 없음"을 만든다.
   *   ① 이 PC 에 저장해둔 목록(localStorage)이 있으면 네트워크를 기다리지 않고 즉시 올린다
   *   ② 맨 앞 묶음만 다시 받아 새로 등록된 것과 전체 개수를 확인한다
   *   ③ 캐시가 모자란 만큼만 이어 받고, 끝나면 다시 저장한다
   * 쿠키는 4KB 제한이라 수천 장 목록을 담을 수 없어 localStorage 를 쓴다
   * (사파리 시크릿 등에서 막히면 그냥 ②③ 만 도는 기존 동작으로 떨어진다).
   */
  const [total, setTotal] = useState<number | null>(null);
  const loadingMore = useRef(false);
  useEffect(() => {
    if (loadingMore.current) return;
    loadingMore.current = true;

    const KEY = 'imgc.refs.v1';
    const TTL = 24 * 60 * 60 * 1000;                     // 하루 지나면 통째로 다시 받는다
    const lean = (r: ReferenceDoc) => ({
      url: r.url, title: r.title, width: r.width, height: r.height,
      category: r.category, sub: r.sub, tags: [], source: r.source, createdAt: null,
    }) as ReferenceDoc;
    const merge = (cur: ReferenceDoc[], add: ReferenceDoc[]) => {
      const seen = new Set(cur.map((x) => x.url));
      const fresh = add.filter((x) => !seen.has(x.url));
      return fresh.length ? [...cur, ...fresh] : cur;
    };

    let cached: ReferenceDoc[] = [];
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const c = JSON.parse(raw) as { at?: number; total?: number; items?: ReferenceDoc[] };
        if (Array.isArray(c.items) && Date.now() - (c.at ?? 0) < TTL) {
          cached = c.items;
          setItems((cur) => merge(cur, cached));
          if (typeof c.total === 'number') setTotal(c.total);
        }
      }
    } catch { /* 저장소를 못 쓰는 브라우저 — 네트워크로만 간다 */ }

    (async () => {
      const CHUNK = 1500;
      const all = merge(initial, cached);               // 화면 상태와 같은 순서로 캐시에 쌓을 사본
      let known: number | null = null;
      try {
        // ② 맨 앞 묶음 — 새로 등록된 것과 전체 개수 확인
        const head = await fetch('/api/references?skip=0&limit=400').then((r) => r.json());
        if (head?.ok) {
          known = typeof head.total === 'number' ? head.total : null;
          if (known != null) setTotal(known);
          const got = (head.references ?? []) as ReferenceDoc[];
          const withHead = merge(all, got);
          if (withHead !== all) setItems((cur) => merge(cur, got));
          all.length = 0; all.push(...withHead);
        }
      } catch { /* 앞 묶음 실패 — 아래 이어받기로 넘어간다 */ }

      // ③ 모자란 만큼만 이어 받기
      for (let guard = 0; guard < 20; guard++) {
        if (known != null && all.length >= known) break;
        try {
          const r = await fetch(`/api/references?skip=${all.length}&limit=${CHUNK}`);
          const j = (await r.json()) as { ok?: boolean; total?: number; references?: ReferenceDoc[] };
          if (!j.ok || !j.references?.length) break;
          const got = j.references;
          setItems((cur) => merge(cur, got));
          const next = merge(all, got);
          const grew = next.length > all.length;
          all.length = 0; all.push(...next);
          if (typeof j.total === 'number' && j.total >= 0) { known = j.total; setTotal(j.total); }
          if (!grew || got.length < CHUNK) break;
        } catch { break; }
      }

      // 다음 방문에 바로 뜨도록 이 PC 에 저장 (용량 초과면 조용히 포기)
      try {
        localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), total: known ?? all.length, items: all.map(lean) }));
      } catch { /* 용량 초과·차단 — 캐시 없이도 동작에는 문제 없다 */ }
    })();
    // 첫 렌더에서 한 번만 — initial 은 서버가 준 고정 배열이다
  }, [initial]);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState<string>('');
  /*
   * 다중 선택 — 평소엔 동그라미 없이 깨끗한 목록.
   * 상단 [분류 이동]/[삭제]를 누르면 선택 모드로 들어가 카드에 ○ 가 나타나고,
   * 여러 장 고른 뒤 한 번에 실행한다 (사용자 요청: 클릭했을 때만 선택 동그라미).
   */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState<null | 'move' | 'delete' | 'model'>(null);

  function enterMode(m: 'move' | 'delete' | 'model') {
    setSelectMode(m);
    setSelected(new Set());
  }
  function exitMode() {
    setSelectMode(null);
    setSelected(new Set());
  }
  const [page, setPage] = useState(1);
  /** 등록할 때 적용할 분류 — 고르기 전에는 파일창을 열지 않는다 */
  const [uploadCategory, setUploadCategory] = useState<string>('');
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  /** 이미지 교체 대상 URL — 교체용 파일창이 닫힐 때 참조 */
  const replaceTarget = useRef<string>('');

  async function uploadOne(f: File, replaceUrl?: string) {
    const shrunk = await shrinkForUpload(f);
    if (shrunk.bytes !== shrunk.originalBytes) {
      setNote(`${f.name}: ${formatBytes(shrunk.originalBytes)} → ${formatBytes(shrunk.bytes)} 로 줄여서 업로드`);
    }
    const fd = new FormData();
    fd.append('file', shrunk.file);
    fd.append('title', f.name);
    if (uploadCategory) fd.append('category', uploadCategory);
    if (replaceUrl) fd.append('replaceUrl', replaceUrl);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    return res.json();
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true); setErr(''); setNote('');
    try {
      for (const f of Array.from(files).slice(0, 8)) {
        const json = await uploadOne(f);
        if (json.ok) {
          setItems((cur) => [
            { url: json.url, title: json.title, width: json.width, height: json.height, category: json.category ?? null, tags: [], source: 'upload', createdAt: new Date().toISOString() },
            ...cur.filter((x) => x.url !== json.url),
          ]);
          // 새로 올린 건 맨 앞에 붙는다 — 3페이지를 보고 있었다면 안 보인다
          setPage(1);
        } else setErr(json.error || '업로드 실패');
      }
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  /** 이미지 교체 — 항목(이름·분류)은 유지하고 파일만 갈아끼운다 */
  async function onReplaceFile(files: FileList | null) {
    const target = replaceTarget.current;
    replaceTarget.current = '';
    if (!files?.length || !target) return;
    setUploading(true); setErr(''); setNote('');
    try {
      const json = await uploadOne(files[0], target);
      if (json.ok) {
        setItems((cur) => cur.map((x) => (x.url === target ? { ...x, url: json.url, width: json.width, height: json.height } : x)));
        setNote('이미지가 교체됐습니다. (이름·분류는 유지)');
      } else setErr(json.error || '교체 실패');
    } finally {
      setUploading(false);
      if (replaceInput.current) replaceInput.current.value = '';
    }
  }

  /** 분류 변경 — 순환식으로 다음 분류를 고른다 (미지정 → 웹배너 → … → 미지정) */
  async function changeCategory(url: string, current: string | null) {
    const order = [...CATEGORY_OPTIONS.map((c) => c.value), ''];
    const next = order[(order.indexOf(current ?? '') + 1) % order.length];
    const res = await fetch('/api/references', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, category: next || null }),
    });
    if ((await res.json()).ok) setItems((cur) => cur.map((x) => (x.url === url ? { ...x, category: next || null } : x)));
  }

  /*
   * 이름 변경 — window.prompt 는 Next dev 오버레이가 막는다(런타임 에러).
   * 제목 자리를 그대로 입력창으로 바꾸는 인라인 방식으로 한다.
   */
  const [renaming, setRenaming] = useState<{ url: string; value: string } | null>(null);
  async function commitRename() {
    const r = renaming;
    setRenaming(null);
    if (!r) return;
    const title = r.value.trim();
    const cur = items.find((x) => x.url === r.url);
    if (!title || !cur || title === cur.title) return;
    const res = await fetch('/api/references', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: r.url, title }),
    });
    if ((await res.json()).ok) setItems((c) => c.map((x) => (x.url === r.url ? { ...x, title } : x)));
  }

  async function hardDelete(url: string, source: string) {
    const msg = source === 'eventtemp'
      ? '디자인 빌더에서 가져온 항목입니다. 파일은 그쪽 자산이라 남고, 이 보관함에서만 완전히 빠집니다. 삭제할까요?'
      : '완전히 삭제할까요? FTP 파일까지 지워지며 되돌릴 수 없습니다.';
    if (!window.confirm(msg)) return;

    const call = (force: boolean) => fetch('/api/references', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, hard: true, ...(force ? { force: true } : {}) }),
    }).then((r) => r.json());

    let json = await call(false);
    if (!json.ok && json.needsForce) {
      if (!window.confirm(`${json.error}\n\n그래도 삭제할까요?`)) return;
      json = await call(true);
    }
    if (json.ok) setItems((cur) => cur.filter((x) => x.url !== url));
    else setErr(json.error || '삭제 실패');
  }

  function toggleSelect(url: string) {
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(url)) n.delete(url); else n.add(url);
      return n;
    });
  }

  /** 선택 항목 일괄 분류 이동 — '' 는 미지정 */
  async function bulkCategory(cat: string) {
    const urls = [...selected];
    if (!urls.length) { setNote('먼저 ○ 를 눌러 항목을 선택하세요.'); return; }
    let ok = 0;
    for (const url of urls) {
      const res = await fetch('/api/references', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, category: cat || null }),
      });
      if ((await res.json()).ok) {
        ok++;
        setItems((cur) => cur.map((x) => (x.url === url ? { ...x, category: cat || null } : x)));
      }
    }
    setNote(`${ok}개를 ${cat ? (CATEGORY_KR[cat] ?? cat) : '미지정'}(으)로 이동했습니다.`);
    exitMode();
  }

  /**
   * 선택 항목에 전속 모델을 붙인다 — 하위 분류(sub)에 모델 이름을 넣는 방식이라
   * 목록의 하위 칩과 생성 화면의 보관함 필터가 그대로 동작한다.
   */
  async function bulkModel(label: string) {
    const urls = [...selected];
    if (!urls.length) { setNote('먼저 ○ 를 눌러 항목을 선택하세요.'); return; }
    let ok = 0;
    for (const url of urls) {
      const res = await fetch('/api/references', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, sub: label || null, ...(label ? { category: 'model' } : {}) }),
      });
      if ((await res.json()).ok) {
        ok++;
        setItems((cur) => cur.map((x) => (x.url === url
          ? { ...x, sub: label || null, ...(label ? { category: 'model' } : {}) } : x)));
      }
    }
    setNote(label ? `${ok}개를 '${label}' 모델 레퍼런스로 지정했습니다.` : `${ok}개의 모델 지정을 해제했습니다.`);
    exitMode();
  }

  /** 선택 항목 일괄 삭제 — 업로드본은 파일까지, 디자인 빌더 항목은 목록에서만 빠진다 */
  async function bulkDelete() {
    const urls = [...selected];
    if (!urls.length) { setNote('먼저 ○ 를 눌러 항목을 선택하세요.'); return; }
    if (!window.confirm(
      `${urls.length}개를 완전히 삭제할까요?\n업로드본은 FTP 파일까지 지워지며 되돌릴 수 없습니다. (디자인 빌더 항목은 목록에서만 빠집니다)`,
    )) return;
    const call = (url: string, force: boolean) => fetch('/api/references', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, hard: true, ...(force ? { force: true } : {}) }),
    }).then((r) => r.json());
    let ok = 0;
    const needForce: string[] = [];
    for (const url of urls) {
      const json = await call(url, false);
      if (json.ok) { ok++; setItems((cur) => cur.filter((x) => x.url !== url)); }
      else if (json.needsForce) needForce.push(url);
    }
    // 다른 곳에서 쓰는 항목들은 한 번만 다시 물어보고 강제 삭제
    if (needForce.length && window.confirm(`${needForce.length}개는 다른 곳에서 사용 중입니다. 그래도 삭제할까요?`)) {
      for (const url of needForce) {
        const json = await call(url, true);
        if (json.ok) { ok++; setItems((cur) => cur.filter((x) => x.url !== url)); }
      }
    }
    setNote(`${ok}개 삭제됨.`);
    exitMode();
  }

  const categories = [...new Set(items.map((x) => x.category).filter(Boolean))] as string[];
  /*
   * 하위 분류 — '22 맥스' 같은 sub 필드가 있는 분류(촬영 2022 등)는
   * 그 분류를 골랐을 때 한 층 더 칩으로 나뉜다.
   */
  const [subFilter, setSubFilter] = useState('');
  const subs = filter
    ? ([...new Set(items.filter((x) => x.category === filter && x.sub).map((x) => x.sub))] as string[]).sort()
    : [];
  const matched = (filter ? items.filter((x) => x.category === filter) : items)
    .filter((x) => !subFilter || x.sub === subFilter);

  /*
   * 게시판식 페이지네이션 — 한 번에 20개.
   * 레퍼런스가 쌓이면 한 화면에 다 뿌리는 게 느리고 찾기도 어렵다.
   * 삭제·숨김으로 개수가 줄어 현재 페이지가 비면 마지막 페이지로 당겨온다
   * (마지막 항목을 지우고 빈 화면만 남는 걸 막는다).
   */
  // 한 줄 8개 × 3줄 = 24개 (사용자 지정). 줄이 딱 떨어져야 마지막 줄이 비어 보이지 않는다.
  const PER_PAGE = 24;
  const totalPages = Math.max(1, Math.ceil(matched.length / PER_PAGE));
  const current = Math.min(page, totalPages);
  const shown = matched.slice((current - 1) * PER_PAGE, current * PER_PAGE);

  /*
   * 다음·이전 페이지 썸네일 미리 받기 — 게시판을 넘기는 순간 이미 브라우저 캐시에 있어 바로 뜬다.
   * 지금 보는 페이지가 먼저 그려지도록 250ms 늦춰서 조용히 받고, 한 번 받은 URL 은 다시 안 받는다.
   * (프록시 썸네일은 첫 요청에서 생성되므로, 미리 받아두면 그 생성 시간도 같이 없앤다)
   */
  const preloaded = useRef<Set<string>>(new Set());
  useEffect(() => {
    const timer = setTimeout(() => {
      const list = (filter ? items.filter((x) => x.category === filter) : items)
        .filter((x) => !subFilter || x.sub === subFilter);
      for (const p of [current + 1, current + 2, current - 1]) {
        if (p < 1 || (p - 1) * PER_PAGE >= list.length) continue;
        for (const r of list.slice((p - 1) * PER_PAGE, p * PER_PAGE)) {
          if (preloaded.current.has(r.url)) continue;
          preloaded.current.add(r.url);
          const img = new window.Image();
          img.decoding = 'async';
          img.src = thumbUrl(r.url, 256);
        }
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [current, filter, subFilter, items]);

  /** 1234 … 형태로 보여줄 페이지 번호 (최대 10개 창) */
  function pageWindow(): number[] {
    const WINDOW = 10;
    let start = Math.max(1, current - Math.floor(WINDOW / 2));
    const end = Math.min(totalPages, start + WINDOW - 1);
    start = Math.max(1, end - WINDOW + 1);
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }

  const pageBtn = (label: string, to: number, disabled: boolean, active = false) => (
    <button
      key={label + to}
      onClick={() => !disabled && setPage(to)}
      disabled={disabled}
      className="min-w-[30px] h-[30px] px-2 rounded-lg text-[12px] tabular-nums"
      style={{
        border: '1px solid ' + (active ? 'var(--accent)' : 'var(--line)'),
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--accent)' : disabled ? 'var(--text-mute)' : 'var(--text-dim)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {label}
    </button>
  );

  return (
    <div>
      <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
      <input ref={replaceInput} type="file" accept="image/*" hidden onChange={(e) => onReplaceFile(e.target.files)} />

      <div className="card p-4 mb-4">
        <div className="label mb-2">1. 용도 분류를 고르세요</div>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {CATEGORY_OPTIONS.map((c) => (
            <button key={c.value} onClick={() => setUploadCategory(c.value === uploadCategory ? '' : c.value)}
                    title={c.desc} className="chip"
                    style={uploadCategory === c.value
                      ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' }
                      : {}}>
              {c.label}
            </button>
          ))}
        </div>

        <div className="label mb-2">2. 이미지를 올리세요</div>
        <div className="flex items-center gap-3 flex-wrap">
          <button className="btn btn-primary" onClick={() => fileInput.current?.click()}
                  disabled={uploading || !uploadCategory}
                  title={!uploadCategory ? '먼저 용도 분류를 골라주세요' : ''}
                  style={!uploadCategory ? { opacity: 0.45, cursor: 'not-allowed' } : {}}>
            {uploading ? '처리 중…' : '＋ 레퍼런스 등록'}
          </button>
          <span className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
            {uploadCategory
              ? `${CATEGORY_KR[uploadCategory]} 로 등록됩니다 — 큰 사진도 그대로 올리면 자동으로 줄여서 저장됩니다.`
              : '분류를 먼저 고르면 등록 버튼이 활성화됩니다.'}
          </span>
          {note && <span className="text-[11px]" style={{ color: 'var(--ok)' }}>{note}</span>}
          {err && <span className="text-[11px]" style={{ color: 'var(--danger)' }}>{err}</span>}
        </div>
      </div>

      {categories.length > 0 && (
        <div className="flex items-center gap-1.5 mb-4 flex-wrap">
          <span className="label mr-1">분류</span>
          <button className="chip" onClick={() => { setFilter(''); setPage(1); }}
                  style={!filter ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
            전체 ({items.length})
          </button>
          {categories.map((c) => (
            <button key={c} className="chip" onClick={() => { setFilter(c === filter ? '' : c); setSubFilter(''); setPage(1); }}
                    style={filter === c ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
              {CATEGORY_KR[c] ?? c} ({items.filter((x) => x.category === c).length})
            </button>
          ))}
        </div>
      )}

      {/* 하위 분류 — 촬영 2022 처럼 sub 가 있는 분류에서만 한 줄 더 */}
      {subs.length > 0 && (
        <div className="flex items-center gap-1.5 mb-4 flex-wrap">
          <span className="label mr-1">하위</span>
          <button className="chip" onClick={() => { setSubFilter(''); setPage(1); }}
                  style={!subFilter ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
            전체
          </button>
          {subs.map((s) => (
            <button key={s} className="chip" onClick={() => { setSubFilter(s === subFilter ? '' : s); setPage(1); }}
                    style={subFilter === s ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
              {s} ({items.filter((x) => x.category === filter && x.sub === s).length})
            </button>
          ))}
        </div>
      )}

      {/* 선택 모드 바 — 상단 [분류 이동]/[삭제]를 누르면 나타난다. ○로 고른 뒤 실행 */}
      {selectMode && (
        <div className="flex items-center gap-1.5 flex-wrap mb-3 p-2 rounded-[10px]"
             style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)' }}>
          <b className="text-[12px] mr-1" style={{ color: 'var(--accent)' }}>
            {selectMode === 'move' ? '분류 이동' : selectMode === 'model' ? '모델 지정' : '삭제'} · {selected.size}개 선택
          </b>
          <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            사진의 ○ 를 눌러 항목을 고르세요{selectMode === 'move' ? ' — 그 다음 이동할 분류 클릭:' : selectMode === 'model' ? ' — 그 다음 모델 클릭:' : ''}
          </span>
          {selectMode === 'move' && (
            <>
              {CATEGORY_OPTIONS.map((c) => (
                <button key={c.value} className="chip" title={c.desc} onClick={() => bulkCategory(c.value)}>{c.label}</button>
              ))}
              <button className="chip" onClick={() => bulkCategory('')}>미지정</button>
            </>
          )}
          {selectMode === 'model' && (
            <>
              {talents.map((t) => (
                <button key={t.code} className="chip" onClick={() => bulkModel(t.label)}
                        title={`${t.label} 레퍼런스로 묶기 (분류는 모델컷으로 바뀝니다)`}>{t.label}</button>
              ))}
              <button className="chip" onClick={() => bulkModel('')}>지정 해제</button>
            </>
          )}
          {selectMode === 'delete' && (
            <button className="chip" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={bulkDelete}>
              {selected.size ? `${selected.size}개 삭제` : '삭제 실행'}
            </button>
          )}
          <button className="chip" onClick={() => setSelected(new Set([...selected, ...shown.map((s) => s.url)]))}>
            이 페이지 전체 선택
          </button>
          <button className="chip ml-auto" onClick={exitMode}>취소</button>
        </div>
      )}

      {/*
        목록이 흐릿해 보이는 이유를 먼저 말해준다 — 안 써두면 "화질이 깨졌나?" 로 읽힌다.
        실제로는 목록만 줄여 부르고(로딩 속도), 클릭하면 원본을 부른다.
      */}
      {matched.length > 0 && (
        <div className="text-[11px] px-2.5 py-1.5 rounded-[8px] mb-2 leading-relaxed"
             style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text-mute)' }}>
          ℹ 목록의 이미지는 <b style={{ color: 'var(--text-dim)' }}>빠른 로딩을 위해 줄여서 보여주는 미리보기</b>라 흐릿하게 보입니다 —
          원본 화질은 그대로이고, <b style={{ color: 'var(--text-dim)' }}>썸네일을 클릭하면 원본으로 크게</b> 볼 수 있습니다.
          생성·디자인에 들어갈 때도 원본이 쓰입니다.
        </div>
      )}

      {/* 지금 몇 번째를 보고 있는지 — 게시판이면 이게 있어야 길을 잃지 않는다 */}
      {matched.length > 0 && (
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
            총 <b style={{ color: 'var(--text-dim)' }}>{matched.length}</b>개
            {/* 나머지를 이어 받는 중이면 알려준다 — 개수가 늘어나는 이유가 보이게 */}
            {total != null && items.length < total && (
              <span style={{ color: 'var(--warn)' }}> · 전체 {total.toLocaleString()}장 불러오는 중…</span>
            )}
            {totalPages > 1 && (
              <>
                {' · '}
                {(current - 1) * PER_PAGE + 1}–{Math.min(current * PER_PAGE, matched.length)} 표시
              </>
            )}
          </span>
          <span className="flex items-center gap-2">
            {/* 선택 모드 진입 — 누르면 카드에 ○ 가 나타난다 */}
            {!selectMode && (
              <>
                <button className="chip" onClick={() => enterMode('move')}>분류 이동</button>
                {talents.length > 0 && (
                  <button className="chip" onClick={() => enterMode('model')}
                          title="선택한 사진을 특정 전속 모델의 레퍼런스로 묶습니다">모델 지정</button>
                )}
                <button className="chip" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
                        onClick={() => enterMode('delete')}>삭제</button>
              </>
            )}
            {totalPages > 1 && (
              <span className="text-[11.5px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
                {current} / {totalPages} 페이지
              </span>
            )}
          </span>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="card p-8 text-center text-[13px]" style={{ color: 'var(--text-dim)' }}>
          {items.length === 0 ? '아직 등록된 레퍼런스가 없습니다.' : '이 분류에는 항목이 없습니다.'}
        </div>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          {shown.map((r) => (
            <div key={r.url}>
              <div className="relative">
                <Zoomable
                  src={r.url}
                  alt={r.title}
                  thumbW={256}
                  caption={`${r.title}${r.width ? ` · ${r.width}×${r.height}` : ''}`}
                  className="w-full aspect-square object-cover rounded-lg border"
                  style={{
                    borderColor: selected.has(r.url) ? 'var(--accent)' : 'var(--line)',
                    borderWidth: selected.has(r.url) ? 2 : 1,
                    background: 'var(--surface-2)',
                  }}
                />
                {/* 선택 ○ — 선택 모드에서만 나타난다 (상단 [분류 이동]/[삭제] 클릭 시) */}
                {selectMode && (
                  <button onClick={() => toggleSelect(r.url)}
                          title={selected.has(r.url) ? '선택 해제' : '선택'}
                          className="absolute top-1 right-1 w-[22px] h-[22px] rounded-full flex items-center justify-center text-[13px] leading-none"
                          style={{
                            border: '2px solid ' + (selected.has(r.url) ? 'var(--accent)' : 'rgba(255,255,255,.8)'),
                            background: selected.has(r.url) ? 'var(--accent)' : 'rgba(0,0,0,.35)',
                            color: '#fff', cursor: 'pointer', padding: 0,
                          }}>
                    {selected.has(r.url) ? '✓' : ''}
                  </button>
                )}
                {r.source === 'eventtemp' && (
                  <span className="absolute top-1 left-1 text-[8.5px] px-1.5 py-0.5 rounded"
                        style={{ background: 'rgba(0,0,0,.55)', color: '#9fd1ff' }}>
                    디자인 빌더
                  </span>
                )}
                {r.category && (
                  <span className="absolute bottom-1 left-1 text-[8.5px] px-1.5 py-0.5 rounded"
                        style={{ background: 'rgba(0,0,0,.55)', color: '#ddd' }}>
                    {CATEGORY_KR[r.category] ?? r.category}
                  </span>
                )}
              </div>
              {renaming?.url === r.url ? (
                <input
                  autoFocus
                  value={renaming.value}
                  onChange={(e) => setRenaming({ url: r.url, value: e.target.value })}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  className="mt-1 w-full text-[10.5px] px-1 py-0.5 rounded"
                  style={{ background: 'var(--surface)', border: '1px solid var(--accent)', color: 'var(--text)' }}
                />
              ) : (
                <button
                  onClick={() => setRenaming({ url: r.url, value: r.title })}
                  title="클릭해서 이름 변경"
                  className="mt-1 text-[10.5px] truncate text-left w-full"
                  style={{ color: 'var(--text-dim)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                >
                  {r.title || '(이름 없음)'}
                </button>
              )}
              {/* 분류 — 클릭하면 다음 분류로 순환 (미지정 포함) */}
              <button
                onClick={() => changeCategory(r.url, r.category)}
                title="클릭해서 분류 변경"
                className="text-[9.5px] truncate text-left w-full"
                style={{ color: r.category ? 'var(--info)' : 'var(--text-mute)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                {r.category ? (CATEGORY_KR[r.category] ?? r.category) : '＋ 분류 지정'}
              </button>
              <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-mute)' }}>
                <button onClick={() => { replaceTarget.current = r.url; replaceInput.current?.click(); }}
                        title="이미지 파일을 새로 올려 갈아끼웁니다 (이름·분류 유지)"
                        style={{ color: 'var(--info)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  수정
                </button>
                <button onClick={() => hardDelete(r.url, r.source)}
                        style={{ color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  삭제
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 페이지 번호 — 1 2 3 4 … */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1 mt-5 flex-wrap">
          {pageBtn('«', 1, current === 1)}
          {pageBtn('‹', current - 1, current === 1)}
          {pageWindow().map((n) => pageBtn(String(n), n, false, n === current))}
          {pageBtn('›', current + 1, current === totalPages)}
          {pageBtn('»', totalPages, current === totalPages)}
        </div>
      )}
    </div>
  );
}
