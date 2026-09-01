'use client';

import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import type { ProductDoc, TalentDoc, PoseRefDoc, ExpressionDoc } from '@/lib/types';
import type { SizePresetDoc, VariationDoc, PreservationDoc, ReferenceDoc } from '@/lib/queries';
import { shrinkForUpload, formatBytes } from '@/lib/client-image';
import Zoomable from '@/components/Zoomable';

type WithId<T> = T & { id: string };

interface BaseCut {
  url: string; line: string; colorKey: string; colorName: string; spec: string; talentCodes: string[];
}

interface Props {
  products: WithId<ProductDoc>[];
  talents: WithId<TalentDoc>[];
  poses: WithId<PoseRefDoc>[];
  sizes: WithId<SizePresetDoc>[];
  variations: WithId<VariationDoc>[];
  preservations: WithId<PreservationDoc>[];
  expressions: WithId<ExpressionDoc>[];
  baseCuts: BaseCut[];
  /** 자산관리 > 레퍼런스 보관함 (생성 중 업로드분도 자동 등록됨) */
  references: ReferenceDoc[];
  /** 프롬프트 작성 모드 — local(템플릿·무과금) / opus(라이브, 확인에도 소액 과금) */
  promptMode: 'local' | 'opus';
}

type RefRole = 'style' | 'base' | 'background';
interface UploadedRef { url: string; title: string; role: RefRole }

/** 선택된 모델 1명 — 순서가 곧 "사진 왼쪽부터" 배정 순서다 */
interface TalentPick { code: string; expression: string; outfitCode: string }

type EditTarget = 'face' | 'person' | 'add-person' | 'outfit' | 'product-color' | 'background' | 'text-removal';

const EDIT_TARGETS: { value: EditTarget; label: string; desc: string }[] = [
  { value: 'face', label: '얼굴만 교체', desc: '몸·포즈·의상·배경 유지, 얼굴+헤어만 우리 모델로' },
  { value: 'person', label: '인물 전체 교체', desc: '포즈는 유지하고 사람을 통째로 우리 모델로' },
  { value: 'add-person', label: '인물 추가 (앉히기)', desc: '사람 없는 사진에 우리 모델을 기존 빈백·좌석에 앉혀 합성. 공간·가구는 그대로' },
  { value: 'product-color', label: '제품 리컬러', desc: '제품 색만 공식 컬러로' },
  { value: 'outfit', label: '의상만 교체', desc: '얼굴·포즈 유지, 옷만' },
  { value: 'background', label: '배경만 교체', desc: '인물·제품 유지, 공간만' },
  { value: 'text-removal', label: '텍스트 제거', desc: '박힌 글자·배지·로고 지우기' },
];

const ROLE_META: { value: RefRole; label: string; desc: string }[] = [
  { value: 'style', label: '분위기 참고', desc: '조명·색감·무드만 따라가고 장면은 새로' },
  { value: 'base', label: '이 사진을 편집', desc: '사진은 그대로 두고 지정한 것만 바꿈 (합성·교체)' },
  { value: 'background', label: '배경으로 사용', desc: '공간만 가져오고 인물·제품은 우리 자산으로' },
];

/**
 * 장당 예상 단가 — 실측 usageMetadata 기반 (₩1,400/$).
 *
 * 실제 원가는 사고(thinking) 토큰에 따라 매번 달라진다: 같은 브리프로도 199~699 토큰이
 * 나와 ₩230~₩314 범위로 흔들린다. 그래서 여기 값은 어디까지나 **예상 범위의 중앙**이고,
 * 생성 후에는 응답의 실측 원가를 그대로 표시한다.
 *   pro   = gemini-3-pro-image 2K — 실측 ₩230~₩314
 *   draft = gemini-3.1-flash-image 2K — 출력 단가가 Pro 의 약 1/4
 */
const WON_BY_TIER = { pro: 270, draft: 90 } as const;
/**
 * 힉스필드는 원화가 아니라 크레딧으로 빠진다.
 * 서버(/api/balance)가 실제 설정값(perImage)을 내려주므로 그걸 우선 쓰고,
 * 못 받았을 때만 이 기본값을 쓴다.
 */
const HF_CREDITS_FALLBACK = 2;
const ORD = ['①', '②', '③', '④'];
const MY_SIZE_GROUP = '내 규격';

interface DryRunResult {
  prompt: string;
  promptMode: string;
  refs: { kind: string; title: string; url?: string; swatchHex?: string }[];
  /** 선택한 제품 컬러의 힉스필드 Element 토큰 (있으면 힉스필드가 유리) */
  elementId?: string | null;
  aspect?: string;
  target?: { width: number; height: number };
}

interface GenResult {
  ok: boolean; id?: string; url?: string; width?: number; height?: number;
  /** 실측 토큰 기반 실제 원가 */
  cost?: { usd: number; krw: number } | null;
  tokenUsage?: { promptTokens: number; imageTokens: number; thoughtTokens: number; totalTokens: number } | null;
  deltaE?: number | null; measuredHex?: string | null; elapsedMs?: number;
  error?: string; blockReason?: string | null;
}

function Section({ n, title, hint, children, right, id }: {
  n: string; title: string; hint?: string; children: React.ReactNode; right?: React.ReactNode; id?: string;
}) {
  return (
    <section className="card p-4" id={id}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="w-[19px] h-[19px] rounded-md text-[10.5px] font-bold flex items-center justify-center shrink-0"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>{n}</span>
            <h2 className="text-[13.5px] font-bold">{title}</h2>
          </div>
          {hint && <p className="text-[11px] mt-1 ml-[27px]" style={{ color: 'var(--text-mute)' }}>{hint}</p>}
        </div>
        {right}
      </div>
      <div className="ml-[27px]">{children}</div>
    </section>
  );
}

export default function CreateStudio(p: Props) {
  /**
   * 작업 방식 — 이게 아래 섹션 구성을 결정한다.
   *   ref    = 가진 사진으로 제작 (사진이 출발점)
   *   direct = 자산으로 직접 제작 (제품·모델·포즈 조합이 출발점)
   */
  const [flow, setFlow] = useState<'ref' | 'direct'>('direct');
  const [engine, setEngine] = useState<'gemini' | 'higgs'>('gemini');
  const [balance, setBalance] = useState<{ gemini?: { count: number; limit: number; remaining: number }; higgs?: { credits?: number | null; configured?: boolean; perImage?: number; estimated?: boolean } } | null>(null);
  const [mode, setMode] = useState<'thumbnail' | 'banner'>('thumbnail');
  /** 프리셋 목록 — 커스텀 규격을 저장하면 여기 즉시 추가된다 */
  const [sizes, setSizes] = useState<WithId<SizePresetDoc>[]>(p.sizes);
  const [sizeValue, setSizeValue] = useState(p.sizes.find((s) => s.value === '1000x1000')?.value ?? p.sizes[0]?.value ?? '');
  const [customW, setCustomW] = useState('1200');
  const [customH, setCustomH] = useState('800');
  const [sizeName, setSizeName] = useState('');
  const [savingSize, setSavingSize] = useState(false);
  const [line, setLine] = useState('');
  const [colorKey, setColorKey] = useState('');
  /** 선택 순서 유지 — ①②③④ = 사진 왼쪽부터 */
  const [picks, setPicks] = useState<TalentPick[]>([]);
  const [baseTab, setBaseTab] = useState<'none' | 'cut' | 'pose'>('none');
  const [baseCutUrl, setBaseCutUrl] = useState('');
  const [poseRefKey, setPoseRefKey] = useState('');
  const [shapeRefKey, setShapeRefKey] = useState('');
  const [uploads, setUploads] = useState<UploadedRef[]>([]);
  const [library, setLibrary] = useState<ReferenceDoc[]>(p.references);
  const [showLibrary, setShowLibrary] = useState(false);
  const [preservation, setPreservation] = useState('similar');
  const [editTargets, setEditTargets] = useState<EditTarget[]>([]);
  const [variationIds, setVariationIds] = useState<Record<string, string>>({});
  const [direction, setDirection] = useState('');
  const [samples, setSamples] = useState(1);
  /** 품질 티어 — 초안은 Flash 로 싸게 돌려보고, 확정본만 Pro 로 */
  const [tier, setTier] = useState<'pro' | 'draft'>('pro');
  const [showStaging, setShowStaging] = useState(false);

  const [uploadNote, setUploadNote] = useState('');
  const [copied, setCopied] = useState<'prompt' | 'urls' | null>(null);
  const [zipping, setZipping] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dry, setDry] = useState<DryRunResult | null>(null);
  const [busy, setBusy] = useState<'dry' | 'gen' | null>(null);
  const [results, setResults] = useState<GenResult[]>([]);
  const [err, setErr] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  /** 힉스필드 실제 크레딧으로 기준값 재설정 (플랫폼 REST 에 잔액 API 가 없어 수동) */
  async function syncCredits() {
    const v = window.prompt('힉스필드 현재 크레딧 잔액을 입력하세요 (힉스필드 사이트에서 확인)', String(balance?.higgs?.credits ?? ''));
    if (v == null) return;
    const credits = Number(v.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(credits)) return;
    const r = await fetch('/api/balance', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credits }) });
    if ((await r.json()).ok) loadBalance();
  }

  const loadBalance = useCallback(async () => {
    try {
      const r = await fetch('/api/balance');
      const j = await r.json();
      if (j.ok) setBalance({ gemini: j.gemini, higgs: j.higgs });
    } catch { /* 잔액 조회 실패는 생성을 막지 않는다 */ }
  }, []);
  useEffect(() => { loadBalance(); }, [loadBalance]);

  const product = p.products.find((x) => x.line === line);
  const size = sizes.find((s) => s.value === sizeValue);
  const linePoses = p.poses.filter((x) => x.line === line);
  const hasBaseUpload = uploads.some((u) => u.role === 'base');
  const lineCuts = useMemo(
    () => p.baseCuts.filter((c) => (!line || c.line === line) && (!colorKey || c.colorKey === colorKey)).slice(0, 60),
    [p.baseCuts, line, colorKey],
  );

  const sizeGroups = useMemo(() => {
    const m = new Map<string, WithId<SizePresetDoc>[]>();
    for (const s of sizes) { if (!m.has(s.group)) m.set(s.group, []); m.get(s.group)!.push(s); }
    return [...m.entries()];
  }, [sizes]);

  const varAxes = useMemo(() => {
    const m = new Map<string, WithId<VariationDoc>[]>();
    for (const v of p.variations) { if (!m.has(v.axis)) m.set(v.axis, []); m.get(v.axis)!.push(v); }
    return [...m.entries()];
  }, [p.variations]);

  function togglePick(code: string) {
    setPicks((cur) => {
      const i = cur.findIndex((x) => x.code === code);
      if (i >= 0) return cur.filter((x) => x.code !== code);
      if (cur.length >= 4) return cur; // 최대 4명
      const t = p.talents.find((x) => x.code === code);
      return [...cur, { code, expression: 'soft_smile', outfitCode: t?.outfits[0]?.code ?? '' }];
    });
  }

  /** 선택된 모델의 순서 변경 — 순서가 곧 "사진 왼쪽부터" 배정이라 자리 바꿈이 필요하다 */
  function movePick(i: number, dir: -1 | 1) {
    setPicks((cur) => {
      const j = i + dir;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  /** 보관함에서 현재 작업으로 가져오기 (중복 제외) */
  function addFromLibrary(r: ReferenceDoc) {
    setUploads((cur) => (cur.some((u) => u.url === r.url) ? cur : [...cur, { url: r.url, title: r.title, role: 'style' }]));
  }

  /** 직접 지정 규격을 '내 규격' 프리셋으로 저장 */
  async function saveCustomSize() {
    setSavingSize(true); setErr('');
    try {
      const res = await fetch('/api/size-presets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ width: Number(customW), height: Number(customH), label: sizeName }),
      });
      const json = await res.json();
      if (!json.ok) { setErr(json.error || '저장 실패'); return; }
      const preset = json.preset as WithId<SizePresetDoc>;
      if (!json.existed) setSizes((cur) => [...cur, preset]);
      setSizeValue(preset.value); // 저장 즉시 그 규격이 선택된다
      setSizeName('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSavingSize(false);
    }
  }

  /** '내 규격' 프리셋 삭제 */
  async function deleteMySize(value: string) {
    if (!window.confirm('이 규격을 삭제할까요?')) return;
    const res = await fetch('/api/size-presets', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    if ((await res.json()).ok) {
      setSizes((cur) => cur.filter((s) => s.value !== value));
      setSizeValue('1000x1000');
    }
  }

  function payload(dryRun: boolean) {
    return {
      mode, dryRun, samples,
      sizeValue,
      ...(sizeValue === 'custom' ? { customSize: { width: Number(customW), height: Number(customH) } } : {}),
      ...(line ? { line } : {}),
      ...(colorKey ? { colorKey } : {}),
      ...(picks.length ? { talents: picks } : {}),
      ...(baseTab === 'cut' && baseCutUrl ? { baseCutId: baseCutUrl } : {}),
      ...(baseTab === 'pose' && poseRefKey ? { poseRefKey } : {}),
      ...(baseTab === 'pose' && shapeRefKey ? { shapeRefKey } : {}),
      ...(uploads.length ? { uploadedRefs: uploads, preservation } : {}),
      ...(hasBaseUpload && editTargets.length ? { editTargets } : {}),
      engine,
      variationIds: Object.values(variationIds).filter((v) => v && !v.endsWith(':auto')),
      ...(direction.trim() ? { direction: direction.trim() } : {}),
      tier,
    };
  }

  async function run(dryRun: boolean) {
    setErr(''); setBusy(dryRun ? 'dry' : 'gen');
    if (!dryRun) setResults([]);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload(dryRun)),
      });
      const json = await res.json();
      if (!json.ok && !json.results) { setErr(json.error || '실패'); return; }
      if (dryRun) setDry(json);
      else {
        setResults(json.results ?? []);
        if (json.prompt) setDry({ prompt: json.prompt, promptMode: json.promptMode, refs: json.refs, aspect: json.aspect, target: json.target });
        if (!json.ok) setErr(json.results?.find((r: GenResult) => r.error)?.error || '생성 실패');
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      if (!dryRun) loadBalance(); // 차감 결과를 즉시 반영
    }
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true); setErr(''); setUploadNote('');
    try {
      for (const f of Array.from(files).slice(0, 3)) {
        // Vercel 4.5MB 본문 한도 — 브라우저에서 먼저 줄인다 (11MB 사진도 여기서 3MB 이하로)
        const shrunk = await shrinkForUpload(f);
        if (shrunk.bytes !== shrunk.originalBytes) {
          setUploadNote(`${f.name}: ${formatBytes(shrunk.originalBytes)} → ${formatBytes(shrunk.bytes)} 로 줄여서 업로드`);
        }
        const fd = new FormData();
        fd.append('file', shrunk.file);
        fd.append('title', f.name);
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        const json = await res.json();
        if (json.ok) {
          setUploads((u) => [...u, { url: json.url, title: json.title, role: 'style' }]);
          // 보관함(서버에도 자동 등록됨)에 즉시 반영
          setLibrary((cur) => [
            { url: json.url, title: json.title, width: json.width, height: json.height, category: null, tags: [], source: 'upload', createdAt: new Date().toISOString() },
            ...cur.filter((x) => x.url !== json.url),
          ]);
        } else setErr(json.error || '업로드 실패');
      }
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const ORDS = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH', 'NINTH', 'TENTH', 'ELEVENTH', 'TWELFTH', 'THIRTEENTH', 'FOURTEENTH'];

  async function copyText(kind: 'prompt' | 'urls') {
    if (!dry) return;
    const text = kind === 'prompt'
      ? dry.prompt
      : dry.refs.map((r, i) => `[${ORDS[i]}] ${r.title} — ${r.url ?? `(단색 스와치 ${r.swatchHex}, 첨부 생략 가능)`}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      window.prompt('복사가 막혀 있습니다. 아래 내용을 직접 복사하세요.', text);
    }
  }

  /** 프롬프트 + 참조 이미지(순번 파일명) ZIP — ChatGPT/Gemini 앱에서 동등 비교용 */
  async function downloadTestKit() {
    if (!dry) return;
    setZipping(true); setErr('');
    try {
      const res = await fetch('/api/test-kit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: dry.prompt, refs: dry.refs, aspect: dry.aspect, target: dry.target }),
      });
      if (!res.ok) { setErr('ZIP 생성 실패'); return; }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'imgcreate-test-kit.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } finally {
      setZipping(false);
    }
  }

  const cost = samples * WON_BY_TIER[tier];
  const dryElement = !!dry?.elementId;
  const isMySize = size?.group === MY_SIZE_GROUP;

  return (
    <div className="flex h-full">
      {/* ── 좌: 선택 ── */}
      <div className="flex-1 min-w-0 p-7 overflow-y-auto">
        <header className="mb-5">
          <h1 className="text-[22px] font-extrabold tracking-tight">이미지 생성</h1>
          <p className="text-[13px] mt-1" style={{ color: 'var(--text-dim)' }}>
            어떻게 만들지 먼저 고르면, 그에 맞는 항목만 아래에 나옵니다.
          </p>
        </header>

        <div className="flex flex-col gap-3 max-w-[680px]">
          {/* 0. 작업 방식 — 이 선택이 아래 섹션 구성을 바꾼다 */}
          <div className="grid sm:grid-cols-2 gap-2.5">
            {([
              ['ref', '레퍼런스로 제작', '가진 사진에서 출발 — 그 사진을 편집하거나, 분위기·배경만 가져옵니다'],
              ['direct', '직접 제작', '제품·컬러·모델·포즈를 조합해 새로 만듭니다'],
            ] as const).map(([v, title, desc]) => {
              const on = flow === v;
              return (
                <button key={v} onClick={() => setFlow(v)} className="card p-3.5 text-left"
                        style={{ borderColor: on ? 'var(--accent)' : 'var(--line)', borderWidth: on ? 2 : 1,
                                 background: on ? 'var(--accent-soft)' : 'var(--surface)' }}>
                  <div className="text-[13.5px] font-bold" style={{ color: on ? 'var(--accent)' : 'var(--text)' }}>
                    {on ? '● ' : '○ '}{title}
                  </div>
                  <div className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--text-dim)' }}>{desc}</div>
                </button>
              );
            })}
          </div>

          {/* ① 용도 · 규격 */}
          <Section n="1" title="용도와 규격" hint="프리셋에서 고르거나 픽셀을 직접 지정합니다. 직접 지정한 규격은 저장해서 다시 쓸 수 있습니다.">
            <div className="flex gap-1.5 mb-3">
              {([['thumbnail', '상품 썸네일'], ['banner', '이벤트 배너 · SNS']] as const).map(([v, l]) => (
                <button key={v} onClick={() => setMode(v)} className="btn"
                        style={mode === v ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' } : {}}>
                  {l}
                </button>
              ))}
            </div>
            <select className="input" value={sizeValue} onChange={(e) => setSizeValue(e.target.value)}>
              {sizeGroups.map(([g, list]) => (
                <optgroup key={g} label={g}>
                  {list.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </optgroup>
              ))}
              <optgroup label="직접 지정">
                <option value="custom">📐 규격 직접 입력…</option>
              </optgroup>
            </select>

            {sizeValue === 'custom' && (
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <input className="input w-[110px]" type="number" min={64} max={8192} value={customW}
                         onChange={(e) => setCustomW(e.target.value)} placeholder="가로 px" />
                  <span style={{ color: 'var(--text-mute)' }}>×</span>
                  <input className="input w-[110px]" type="number" min={64} max={8192} value={customH}
                         onChange={(e) => setCustomH(e.target.value)} placeholder="세로 px" />
                  <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>px</span>
                </div>
                <div className="flex items-center gap-2">
                  <input className="input flex-1" value={sizeName} maxLength={40}
                         onChange={(e) => setSizeName(e.target.value)}
                         placeholder="규격 이름 (선택 — 예: 카카오 채널 배너)" />
                  <button className="btn" onClick={saveCustomSize} disabled={savingSize}>
                    {savingSize ? '저장 중…' : '내 규격으로 저장'}
                  </button>
                </div>
                <div className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>
                  저장하면 &lsquo;{MY_SIZE_GROUP}&rsquo; 그룹에 추가되고 다음부터 목록에서 바로 고를 수 있습니다.
                </div>
              </div>
            )}

            {sizeValue !== 'custom' && size && (
              <div className="text-[11px] mt-2 flex items-center gap-3 flex-wrap" style={{ color: 'var(--text-mute)' }}>
                <span>생성 비율 <b style={{ color: 'var(--text-dim)' }}>{size.genAspect}</b></span>
                {size.retention < 1 && (
                  <span style={{ color: size.retention < 0.7 ? 'var(--warn)' : 'var(--text-mute)' }}>
                    {size.cropAxis === 'vertical' ? '세로' : '가로'} {Math.round((1 - size.retention) * 100)}% 크롭
                    {size.retention < 0.7 && ' — 손실이 큽니다'}
                  </span>
                )}
                {size.variableHeight && <span>세로 가변</span>}
                {isMySize && (
                  <button onClick={() => deleteMySize(size.value)} className="text-[10.5px]"
                          style={{ color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer' }}>
                    이 규격 삭제
                  </button>
                )}
              </div>
            )}
          </Section>

          {/* ② 레퍼런스 — 가장 흔한 시작 행동이라 위로 올렸다 */}
          {flow === 'ref' && (
          <Section n="2" title="레퍼런스 이미지"
                   hint="새로 올리거나 보관함에서 가져옵니다. 올린 이미지는 자동으로 보관함에 등록돼 다른 썸네일·배너 작업에도 재사용됩니다."
                   right={
                     <button className="btn btn-ghost text-[11px]" onClick={() => setShowLibrary((v) => !v)}>
                       보관함 {showLibrary ? '접기' : `열기 (${library.length})`}
                     </button>
                   }>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
            <div className="flex gap-2 flex-wrap items-start mb-1">
              <button className="btn" onClick={() => fileInput.current?.click()} disabled={uploading}>
                {uploading ? '업로드 중…' : '＋ 이미지 추가'}
              </button>
            </div>
            {uploadNote && <div className="text-[10.5px] mb-2" style={{ color: 'var(--ok)' }}>{uploadNote}</div>}

            {showLibrary && (
              <div className="mb-3 p-2 rounded-lg" style={{ background: 'var(--surface-2)' }}>
                <div className="label mb-1.5">보관함 — 클릭하면 크게 보이고, 팝업에서 추가할 수 있습니다</div>
                {library.length ? (
                  <div className="grid grid-cols-6 gap-1.5 max-h-[180px] overflow-y-auto pr-1">
                    {library.map((r) => {
                      const used = uploads.some((u) => u.url === r.url);
                      return (
                        <div key={r.url} style={{ opacity: used ? 0.45 : 1 }}>
                          <Zoomable
                            src={r.url}
                            alt={r.title}
                            caption={`${r.title}${used ? ' — 이미 이번 작업에 들어가 있음' : ''}`}
                            action={{ label: used ? '이미 추가됨' : '＋ 이번 작업에 추가', onClick: () => addFromLibrary(r), disabled: used }}
                            className="w-full aspect-square object-cover rounded-md border"
                            style={{ borderColor: used ? 'var(--accent)' : 'var(--line)' }}
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-[11px] py-2" style={{ color: 'var(--text-mute)' }}>
                    아직 비어 있습니다. 자산관리 &gt; 레퍼런스에서 미리 등록해둘 수도 있습니다.
                  </div>
                )}
              </div>
            )}

            {uploads.map((u, i) => (
              <div key={u.url} className="flex gap-2.5 p-2 rounded-lg mb-2" style={{ background: 'var(--surface-2)' }}>
                <Zoomable src={u.url} alt={u.title} caption={u.title}
                          className="w-[76px] h-[76px] object-cover rounded-lg shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] truncate" style={{ color: 'var(--text-dim)' }}>{u.title}</div>
                    <button onClick={() => setUploads((a) => a.filter((_, j) => j !== i))}
                            className="text-[11px] shrink-0" style={{ color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer' }}>
                      빼기
                    </button>
                  </div>
                  <div className="flex gap-1.5 mt-1.5 flex-wrap">
                    {ROLE_META.map((r) => (
                      <button key={r.value} title={r.desc}
                              onClick={() => setUploads((a) => a.map((x, j) => j === i ? { ...x, role: r.value } : x))}
                              className="chip"
                              style={u.role === r.value ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                  <div className="text-[10px] mt-1" style={{ color: 'var(--text-mute)' }}>
                    {ROLE_META.find((r) => r.value === u.role)?.desc}
                  </div>
                </div>
              </div>
            ))}

            {/* base 역할이 있으면: 무엇을 바꿀지 */}
            {hasBaseUpload && (
              <div className="mt-2 p-2.5 rounded-lg" style={{ background: 'var(--accent-soft)' }}>
                <div className="label mb-1.5">이 사진에서 무엇을 바꿀까요 (복수 선택)</div>
                <div className="flex flex-wrap gap-1.5">
                  {EDIT_TARGETS.map((t) => {
                    const on = editTargets.includes(t.value);
                    return (
                      <button key={t.value} title={t.desc}
                              onClick={() => setEditTargets((c) => on ? c.filter((x) => x !== t.value) : [...c, t.value])}
                              className="chip"
                              style={on ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--surface)' } : {}}>
                        {t.label}
                      </button>
                    );
                  })}
                </div>
                {editTargets.includes('face') || editTargets.includes('person') || editTargets.includes('add-person') ? (
                  <div className="text-[10.5px] mt-2" style={{ color: 'var(--text-dim)' }}>
                    {editTargets.includes('add-person')
                      ? '앉힐 모델을 아래 ④에서 고르세요. 사진 왼쪽 좌석부터 ①②③④ 순서로 앉습니다. 제품(③)은 비워두세요 — 사진의 빈백을 그대로 씁니다.'
                      : '교체할 모델을 아래 ④에서 고르세요. 사진 왼쪽 사람부터 ①②③④ 순서로 들어갑니다.'}
                  </div>
                ) : null}
              </div>
            )}

            {uploads.some((u) => u.role !== 'base') && (
              <div className="mt-2">
                <div className="label mb-1">분위기 참고를 얼마나 살릴까요</div>
                <div className="flex flex-wrap gap-1.5">
                  {p.preservations.map((m) => (
                    <button key={m.value} onClick={() => setPreservation(m.value)} className="chip"
                            style={m.value === preservation ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Section>
          )}

          {/* ③ 제품 */}
          <Section n={flow === "ref" ? "3" : "2"} title="제품 · 컬러" hint={flow === "ref" ? "사진 속 제품을 그대로 쓸 거면 비워두세요. 다른 제품으로 바꿀 때만 고릅니다." : "선택하면 실측 치수·기하 서술·컬러 스와치가 자동으로 들어갑니다."}>
            <select className="input mb-2" value={line} onChange={(e) => { setLine(e.target.value); setColorKey(''); setPoseRefKey(''); setShapeRefKey(''); }}>
              <option value="">— 제품 없음 (인물/분위기만) —</option>
              {p.products.map((x) => <option key={x.line} value={x.line}>{x.emoji} {x.line} · {x.sizeText}</option>)}
            </select>
            {product && (
              <div className="flex flex-wrap gap-1.5">
                {product.colors.map((c) => (
                  <button key={c.key} onClick={() => setColorKey(c.key === colorKey ? '' : c.key)}
                          className="flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-lg border text-[11px]"
                          style={{ borderColor: c.key === colorKey ? 'var(--accent)' : 'var(--line)',
                                   background: c.key === colorKey ? 'var(--accent-soft)' : 'transparent' }}>
                    <span className="w-4 h-4 rounded" style={{ background: c.hex, border: '1px solid rgba(255,255,255,.15)' }} />
                    {c.name}
                  </button>
                ))}
              </div>
            )}
          </Section>

          {/* ④ 모델 — 다중 선택, 클릭 순서 = 사진 왼쪽부터 */}
          <Section n={flow === "ref" ? "4" : "3"} title="모델" hint="여러 명을 고르면 클릭한 순서대로 ①②③④ — 사진 왼쪽부터 배정됩니다. 다시 클릭하면 빠집니다.">
            <div className="flex flex-wrap gap-2 mb-3">
              {p.talents.map((t) => {
                const idx = picks.findIndex((x) => x.code === t.code);
                const on = idx >= 0;
                return (
                  <button key={t.code} onClick={() => togglePick(t.code)}
                          className="relative rounded-lg border overflow-hidden text-left"
                          style={{ borderColor: on ? 'var(--accent)' : 'var(--line)', borderWidth: on ? 2 : 1, width: 68 }}>
                    {on && (
                      <span className="absolute top-1 left-1 z-10 w-[18px] h-[18px] rounded-full text-[11px] font-bold flex items-center justify-center"
                            style={{ background: 'var(--accent)', color: '#fff' }}>{ORD[idx]}</span>
                    )}
                    {t.rep
                      /* eslint-disable-next-line @next/next/no-img-element */
                      ? <img src={t.rep} alt={t.code} className="w-full object-cover" style={{ aspectRatio: '3/4' }} />
                      : <div style={{ aspectRatio: '3/4', background: 'var(--surface-2)' }} />}
                    <div className="text-[10px] text-center py-1" style={{ color: on ? 'var(--accent)' : 'var(--text-mute)' }}>
                      {t.category}{t.slot}
                    </div>
                  </button>
                );
              })}
            </div>

            {picks.length > 0 && (
              <div className="flex flex-col gap-2">
                {picks.length > 1 && (
                  <div className="text-[11px] px-2.5 py-1.5 rounded-lg" style={{ background: 'var(--accent-soft)', color: 'var(--text-dim)' }}>
                    사진 <b style={{ color: 'var(--accent)' }}>왼쪽부터</b> ① → ④ 순서로 배정됩니다.
                  </div>
                )}
                {picks.map((pick, i) => {
                  const t = p.talents.find((x) => x.code === pick.code)!;
                  const arrow = (dir: -1 | 1, on: boolean, label: string) => (
                    <button onClick={() => movePick(i, dir)} disabled={!on} aria-label={label}
                            className="w-[18px] h-[15px] leading-none text-[10px] rounded"
                            style={{ background: 'none', border: 'none', cursor: on ? 'pointer' : 'default',
                                     color: on ? 'var(--text-dim)' : 'var(--line-strong)', padding: 0 }}>
                      {dir === -1 ? '▲' : '▼'}
                    </button>
                  );
                  const setExpr = (id: string) => setPicks((c) => c.map((x, j) => j === i ? { ...x, expression: id } : x));
                  const setOutfit = (code: string) => setPicks((c) => c.map((x, j) => j === i ? { ...x, outfitCode: code } : x));
                  const exprKr = p.expressions.find((e) => e.id === pick.expression)?.kr ?? '';
                  const outfitDesc = t.outfits.find((o) => o.code === pick.outfitCode)?.desc ?? '자동';
                  const sel = (on: boolean) => ({
                    borderColor: on ? 'var(--accent)' : 'var(--line)',
                    borderWidth: on ? 2 : 1,
                    opacity: on ? 1 : 0.7,
                  });
                  return (
                    <div key={pick.code} className="p-2 rounded-lg" style={{ background: 'var(--surface-2)' }}>
                      {/* 1행 — 순번·이동·이름·빼기 */}
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-[13px] font-bold w-5 text-center" style={{ color: 'var(--accent)' }}>{ORD[i]}</span>
                        {/* 순서 변경 — ①이 사진 맨 왼쪽 사람 */}
                        <span className="flex flex-col shrink-0">
                          {arrow(-1, i > 0, '왼쪽으로')}
                          {arrow(1, i < picks.length - 1, '오른쪽으로')}
                        </span>
                        <span className="text-[11.5px] font-semibold">{t.category}{t.slot}</span>
                        <span className="text-[10.5px] truncate" style={{ color: 'var(--text-mute)' }}>
                          {exprKr} · {outfitDesc}
                        </span>
                        <button onClick={() => setPicks((c) => c.filter((_, j) => j !== i))} aria-label="빼기"
                                className="text-[12px] shrink-0 ml-auto"
                                style={{ color: 'var(--text-mute)', background: 'none', border: 'none', cursor: 'pointer' }}>
                          ✕
                        </button>
                      </div>

                      {/* 2행 — 표정: 시트에서 잘라둔 표정컷 썸네일 (없으면 텍스트 칩) */}
                      <div className="label mb-1">표정</div>
                      <div className="flex items-start gap-1.5 mb-2 flex-wrap">
                        {p.expressions.map((ex) => {
                          const url = t.expressionCrops?.[ex.id];
                          const on = pick.expression === ex.id;
                          return url ? (
                            <div key={ex.id} className="text-center shrink-0">
                              <button onClick={() => setExpr(ex.id)} title={ex.kr}
                                      className="rounded-lg overflow-hidden border block" style={{ width: 78, height: 86, padding: 0, background: 'var(--surface)', ...sel(on) }}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={url} alt={ex.kr} loading="lazy" className="w-full h-full object-cover" />
                              </button>
                              <div className="text-[9.5px] mt-0.5" style={{ color: on ? 'var(--accent)' : 'var(--text-mute)' }}>{ex.kr}</div>
                            </div>
                          ) : (
                            <button key={ex.id} onClick={() => setExpr(ex.id)} className="chip"
                                    style={on ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                              {ex.kr}
                            </button>
                          );
                        })}
                      </div>

                      {/* 3행 — 의상: 컨셉 이미지 썸네일 */}
                      <div className="label mb-1">의상</div>
                      <div className="flex items-start gap-1.5 flex-wrap">
                        <button onClick={() => setOutfit('')} className="chip"
                                style={!pick.outfitCode ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                          자동
                        </button>
                        {t.outfits.map((o) => {
                          const on = pick.outfitCode === o.code;
                          return (
                            <div key={o.code} className="text-center shrink-0" style={{ width: 66 }}>
                              <button onClick={() => setOutfit(o.code)} title={`${o.code} · ${o.desc}`}
                                      className="rounded-lg overflow-hidden border block" style={{ width: 66, height: 86, padding: 0, background: 'var(--surface)', ...sel(on) }}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={o.imageUrl} alt={o.desc} loading="lazy" className="w-full h-full object-cover object-top" />
                              </button>
                              <div className="text-[9px] mt-0.5 truncate" style={{ color: on ? 'var(--accent)' : 'var(--text-mute)' }}>{o.desc}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          {/* ⑤ 베이스 (자산) */}
          {flow === 'direct' && (
          <Section n="4" title="베이스 (기존 자산)" hint="확정된 컷이나 실사 포즈 레퍼를 앵커로 씁니다. 레퍼런스를 '이 사진을 편집'으로 쓸 땐 비워두세요.">
            <div className="flex gap-1.5 mb-3">
              {([['none', '없음'], ['cut', '기존 컷'], ['pose', '포즈 레퍼']] as const).map(([v, l]) => (
                <button key={v} onClick={() => setBaseTab(v)} className="btn"
                        style={baseTab === v ? { background: 'var(--surface-3)', borderColor: 'var(--accent-dim)', color: 'var(--accent)' } : {}}>
                  {l}
                </button>
              ))}
            </div>
            {baseTab === 'cut' && (
              lineCuts.length ? (
                <div className="grid grid-cols-6 gap-1.5 max-h-[220px] overflow-y-auto pr-1">
                  {lineCuts.map((c) => (
                    <button key={c.url} onClick={() => setBaseCutUrl(c.url === baseCutUrl ? '' : c.url)} title={c.spec}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={c.url} alt={c.spec} loading="lazy" className="w-full aspect-square object-cover rounded-md border"
                           style={{ borderColor: c.url === baseCutUrl ? 'var(--accent)' : 'var(--line)', borderWidth: c.url === baseCutUrl ? 2 : 1 }} />
                    </button>
                  ))}
                </div>
              ) : <p className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>제품·컬러를 먼저 고르면 해당 컷이 나옵니다.</p>
            )}
            {baseTab === 'pose' && (
              linePoses.length ? (
                <>
                  <div className="text-[10.5px] mb-2" style={{ color: 'var(--text-mute)' }}>
                    <b style={{ color: 'var(--accent)' }}>형태</b>(사람 지운 눌림)와 <b style={{ color: 'var(--info)' }}>포즈</b>(각도·자세)를
                    <b> 둘 다</b> 고르는 게 가장 정확합니다.
                  </div>
                  <div className="grid grid-cols-4 gap-2 max-h-[240px] overflow-y-auto pr-1">
                    {linePoses.map((r) => (
                      <div key={r.key} className="text-center">
                        <div className="flex gap-1">
                          {([['off', r.offUrl, shapeRefKey], ['on', r.onUrl, poseRefKey]] as const).map(([kind, url, sel]) => (
                            <button key={kind} onClick={() => kind === 'off'
                                      ? setShapeRefKey(shapeRefKey === r.key ? '' : r.key)
                                      : setPoseRefKey(poseRefKey === r.key ? '' : r.key)}
                                    className="flex-1" title={`${r.name} · ${kind === 'off' ? '형태' : '포즈각도'}`}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={url} alt={r.name} loading="lazy" className="w-full aspect-square object-cover rounded-md border"
                                   style={{ borderColor: sel === r.key ? 'var(--accent)' : 'var(--line)', borderWidth: sel === r.key ? 2 : 1 }} />
                              <div className="text-[9px] mt-0.5" style={{ color: 'var(--text-mute)' }}>{kind === 'off' ? '형태' : '포즈'}</div>
                            </button>
                          ))}
                        </div>
                        <div className="text-[9.5px] mt-0.5 leading-tight" style={{ color: 'var(--text-mute)' }}>{r.name.replace(/^\S+\s/, '')}</div>
                      </div>
                    ))}
                  </div>
                </>
              ) : <p className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>제품을 먼저 고르면 그 제품의 실사 포즈 레퍼가 나옵니다.</p>
            )}
          </Section>
          )}

          {/* ⑥ 연출 */}
          <Section n={flow === "ref" ? "5" : "5"} title="연출" hint="비워두면 레퍼런스와 베이스를 따라갑니다."
                   right={<button className="btn btn-ghost text-[11px]" onClick={() => setShowStaging((v) => !v)}>{showStaging ? '접기' : '펼치기'}</button>}>
            {showStaging && (
              <div className="grid sm:grid-cols-2 gap-2">
                {varAxes.map(([axis, list]) => (
                  <div key={axis}>
                    <div className="label mb-1">{list[0].axisLabel}</div>
                    <select className="input" value={variationIds[axis] ?? ''} onChange={(e) => setVariationIds((v) => ({ ...v, [axis]: e.target.value }))}>
                      <option value="">— 지정 안 함 —</option>
                      {list.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* ⑦ 방향 지시 */}
          <Section n="6" title="방향 지시" hint="한글로 편하게 적으면 됩니다. 예: 배경을 밝은 거실로, 랩탑 들고 있게">
            <textarea className="input" rows={3} value={direction} onChange={(e) => setDirection(e.target.value)}
                      placeholder="예: 창가 자연광이 드는 아늑한 거실, 옆에 작은 화분" />
          </Section>
        </div>
      </div>

      {/* ── 우: 미리보기 · 실행 ── */}
      <aside className="w-[336px] shrink-0 border-l p-5 overflow-y-auto" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
        {dry?.prompt && (
          <div className="card p-3 mb-4" style={{ borderColor: 'var(--accent-dim)' }}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[13px] font-bold">프롬프트 <span className="font-normal" style={{ color: 'var(--text-mute)' }}>({dry.promptMode})</span></h2>
              <span className="text-[10px]" style={{ color: 'var(--text-mute)' }}>{dry.aspect ?? ''}</span>
            </div>
            <textarea
              readOnly
              value={dry.prompt}
              onFocus={(e) => e.currentTarget.select()}
              className="input font-mono text-[10px] leading-relaxed"
              style={{ height: 150, resize: 'vertical' }}
            />
            <div className="flex gap-1.5 mt-2 flex-wrap">
              <button className="btn text-[11px]" onClick={() => copyText('prompt')}>{copied === 'prompt' ? '복사됨 ✓' : '프롬프트 복사'}</button>
              <button className="btn text-[11px]" onClick={() => copyText('urls')}>{copied === 'urls' ? '복사됨 ✓' : '참조 URL 복사'}</button>
              <button className="btn text-[11px]" onClick={downloadTestKit} disabled={zipping}>{zipping ? '묶는 중…' : '테스트 키트 ZIP'}</button>
            </div>
            <div className="text-[10px] mt-2 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
              ChatGPT·Gemini 앱에서 비교하려면 <b>참조 이미지를 같은 순서로 첨부</b>한 뒤 프롬프트를 붙여넣으세요.
              ZIP에 순번 파일명 + 프롬프트 txt가 들어 있습니다.
            </div>
          </div>
        )}

        <h2 className="text-[13.5px] font-bold mb-3">참조 이미지</h2>
        {dry?.refs?.length ? (
          <div className="flex flex-col gap-1.5 mb-4">
            {dry.refs.map((r, i) => (
              <div key={i} className="flex items-center gap-2 p-1.5 rounded-lg" style={{ background: 'var(--surface-2)' }}>
                <span className="text-[9.5px] w-[46px] shrink-0 font-bold" style={{ color: 'var(--accent)' }}>
                  {['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH'][i]}
                </span>
                {r.swatchHex
                  ? <span className="w-8 h-8 rounded shrink-0" style={{ background: r.swatchHex, border: '1px solid rgba(255,255,255,.15)' }} />
                  /* eslint-disable-next-line @next/next/no-img-element */
                  : <img src={r.url} alt={r.title} className="w-8 h-8 object-cover rounded shrink-0" />}
                <span className="text-[10.5px] leading-tight" style={{ color: 'var(--text-dim)' }}>{r.title}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[11.5px] mb-4" style={{ color: 'var(--text-mute)' }}>
            선택을 마치고 <b>프롬프트 확인</b>을 누르면 어떤 이미지가 들어가는지 여기 표시됩니다.
          </p>
        )}

        <div className="flex flex-col gap-2 mb-4">
          <button className="btn" onClick={() => run(true)} disabled={!!busy}>
            {busy === 'dry'
              ? '만드는 중…'
              : p.promptMode === 'opus'
                ? '프롬프트 확인 (Opus · 약 ₩50)'
                : '프롬프트 확인 (무료)'}
          </button>
          {/* 엔진 — 힉스필드는 Element 토큰 보유 제품에서 형태·색이 더 정확 */}
          <div className="flex gap-1.5">
            {([
              ['gemini', '나노바나나', '범용 · 원화 한도에서 차감'],
              ['higgs', '힉스필드', 'Element 토큰 제품에서 형태·색 우세 · 크레딧 차감'],
            ] as const).map(([v, l, tip]) => {
              const off = v === 'higgs' && balance?.higgs?.configured === false;
              return (
                <button key={v} onClick={() => !off && setEngine(v)} title={off ? '힉스필드 설정이 없습니다 (.env.local)' : tip}
                        className="chip flex-1 justify-center"
                        style={{ ...(engine === v ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}),
                                 ...(off ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}>
                  {l}
                </button>
              );
            })}
          </div>

          {/* 잔액 — 생성 전에 "얼마 남았고 얼마 나간다" 를 항상 보여준다 */}
          <div className="text-[10.5px] px-1 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            {engine === 'higgs' ? (
              balance?.higgs?.credits != null ? (
                <>
                  힉스필드 잔액(추정) <b style={{ color: 'var(--text-dim)' }}>{balance.higgs.credits.toLocaleString()} 크레딧</b>
                  {' → 이번 생성 약 '}
                  <b style={{ color: 'var(--warn)' }}>{(samples * (balance?.higgs?.perImage ?? HF_CREDITS_FALLBACK)).toLocaleString()} 크레딧</b> 차감
                  <button onClick={syncCredits} className="ml-1"
                          style={{ color: 'var(--info)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 10 }}>
                    동기화
                  </button>
                  {dry && !dryElement && <><br />이 제품엔 Element 토큰이 없어 힉스필드 이점이 적습니다.</>}
                  {dry && dryElement && <><br /><span style={{ color: 'var(--ok)' }}>Element 토큰 보유 — 형태·색 정확도 우세</span></>}
                </>
              ) : (
                <>
                  힉스필드 잔액 미설정 —{' '}
                  <button onClick={syncCredits} style={{ color: 'var(--info)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 10.5 }}>
                    현재 크레딧 입력
                  </button>
                </>
              )
            ) : (
              balance?.gemini ? (
                <>
                  월 한도 <b style={{ color: 'var(--text-dim)' }}>{balance.gemini.count}/{balance.gemini.limit}장</b>
                  {` (남은 ${balance.gemini.remaining}장) → 이번 생성 `}
                  <b style={{ color: 'var(--warn)' }}>{samples}장 · 약 ₩{cost.toLocaleString()}</b>
                  <br />실제 원가는 생성마다 달라집니다 (사고 토큰 변동 — 1장 ₩230~₩314 실측)
                </>
              ) : '사용량을 불러오는 중…'
            )}
          </div>

          {engine === 'gemini' && (
          <div className="flex gap-1.5">
            {([['pro', '고품질 · ₩200'], ['draft', '초안 · ₩145']] as const).map(([v, l]) => (
              <button key={v} onClick={() => setTier(v)} className="chip flex-1 justify-center"
                      title={v === 'pro' ? '최종 컷용 — 얼굴·제품 참조 유지력 최상 (Pro 2K)' : '구도·분위기 확인용 — 참조 유지력이 낮아 얼굴이 덜 붙을 수 있음 (Flash 2K)'}
                      style={tier === v ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                {l}
              </button>
            ))}
          </div>
          )}
          {engine === 'gemini' && tier === 'draft' && (
            <div className="text-[10px] px-1" style={{ color: 'var(--warn)' }}>
              초안 모드는 얼굴·제품 참조 유지력이 낮습니다. 확정본은 고품질로 다시 뽑으세요.
            </div>
          )}
          <div className="flex gap-2">
            <select className="input flex-1" value={samples} onChange={(e) => setSamples(Number(e.target.value))}>
              <option value={1}>1장</option>
              <option value={2}>2장 (골라쓰기)</option>
            </select>
            <button className="btn btn-primary flex-1" onClick={() => run(false)} disabled={!!busy}>
              {busy === 'gen' ? '생성 중…' : '생성'}
            </button>
          </div>
          <div className="text-[10.5px] text-center" style={{ color: 'var(--text-mute)' }}>
            {engine === 'higgs'
              ? <>약 <b style={{ color: 'var(--text-dim)' }}>{(samples * (balance?.higgs?.perImage ?? HF_CREDITS_FALLBACK)).toLocaleString()} 크레딧</b> · 20~40초/장</>
              : <>생성 약 <b style={{ color: 'var(--text-dim)' }}>₩{cost.toLocaleString()}</b> · 25~35초/장 (생성 후 실측 표시)</>}
            {p.promptMode === 'local' && <span> · 프롬프트는 템플릿 조립(무과금)</span>}
          </div>
        </div>

        {err && (
          <div className="card p-2.5 mb-4 text-[11.5px]" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>{err}</div>
        )}

        {results.length > 0 && (
          <div className="mb-4">
            <h2 className="text-[13.5px] font-bold mb-2">결과</h2>
            <div className="flex flex-col gap-2">
              {results.map((r, i) => r.ok ? (
                <div key={i}>
                  <a href={r.url} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={r.url} alt="생성 결과" className="w-full rounded-lg border" style={{ borderColor: 'var(--line-strong)' }} />
                  </a>
                  <div className="text-[10px] mt-1 flex gap-2 flex-wrap" style={{ color: 'var(--text-mute)' }}>
                    <span>{r.width}×{r.height}</span>
                    <span>{((r.elapsedMs ?? 0) / 1000).toFixed(1)}초</span>
                    {r.deltaE != null && (
                      <span style={{ color: r.deltaE < 5 ? 'var(--ok)' : r.deltaE < 15 ? 'var(--warn)' : 'var(--danger)' }}>
                        컬러 ΔE {r.deltaE}
                      </span>
                    )}
                    {r.cost && (
                      <span title={r.tokenUsage ? `입력 ${r.tokenUsage.promptTokens} · 이미지 ${r.tokenUsage.imageTokens} · 사고 ${r.tokenUsage.thoughtTokens} 토큰` : ''}
                            style={{ color: 'var(--text-dim)' }}>
                        실제 ₩{r.cost.krw.toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <div key={i} className="card p-2 text-[11px]" style={{ color: 'var(--danger)' }}>
                  {r.blockReason ? `안전필터 차단 (${r.blockReason})` : r.error}
                </div>
              ))}
            </div>
          </div>
        )}


      </aside>
    </div>
  );
}
