'use client';

import { useMemo, useState, useRef } from 'react';
import type { ProductDoc, TalentDoc, PoseRefDoc, ExpressionDoc } from '@/lib/types';
import type { SizePresetDoc, VariationDoc, PreservationDoc } from '@/lib/queries';

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
}

interface UploadedRef { url: string; title: string }

interface DryRunResult {
  prompt: string;
  promptMode: string;
  refs: { kind: string; title: string; url?: string; swatchHex?: string }[];
  aspect: string;
  target: { width: number; height: number };
}

interface GenResult {
  ok: boolean; id?: string; url?: string; width?: number; height?: number;
  deltaE?: number | null; measuredHex?: string | null; elapsedMs?: number;
  error?: string; blockReason?: string | null;
}

/** 장당 단가 — Pro 2K 기준 (₩1,400/$ 환산) */
const WON_PER_IMAGE = 188;

function Section({ n, title, hint, children, right }: {
  n: string; title: string; hint?: string; children: React.ReactNode; right?: React.ReactNode;
}) {
  return (
    <section className="card p-4">
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
  const [mode, setMode] = useState<'thumbnail' | 'banner'>('thumbnail');
  const [sizeValue, setSizeValue] = useState(p.sizes.find((s) => s.value === '1000x1000')?.value ?? p.sizes[0]?.value ?? '');
  const [line, setLine] = useState('');
  const [colorKey, setColorKey] = useState('');
  const [talentCode, setTalentCode] = useState('');
  const [expression, setExpression] = useState('soft_smile');
  const [outfitCode, setOutfitCode] = useState('');
  const [baseTab, setBaseTab] = useState<'none' | 'cut' | 'pose'>('none');
  const [baseCutUrl, setBaseCutUrl] = useState('');
  const [poseRefKey, setPoseRefKey] = useState('');
  const [shapeRefKey, setShapeRefKey] = useState('');
  const [uploads, setUploads] = useState<UploadedRef[]>([]);
  const [preservation, setPreservation] = useState('similar');
  const [variationIds, setVariationIds] = useState<Record<string, string>>({});
  const [direction, setDirection] = useState('');
  const [samples, setSamples] = useState(1);
  const [showStaging, setShowStaging] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [dry, setDry] = useState<DryRunResult | null>(null);
  const [busy, setBusy] = useState<'dry' | 'gen' | null>(null);
  const [results, setResults] = useState<GenResult[]>([]);
  const [err, setErr] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const product = p.products.find((x) => x.line === line);
  const color = product?.colors.find((c) => c.key === colorKey);
  const talent = p.talents.find((t) => t.code === talentCode);
  const size = p.sizes.find((s) => s.value === sizeValue);
  const linePoses = p.poses.filter((x) => x.line === line);
  const lineCuts = useMemo(
    () => p.baseCuts.filter((c) => (!line || c.line === line) && (!colorKey || c.colorKey === colorKey)).slice(0, 60),
    [p.baseCuts, line, colorKey],
  );

  const sizeGroups = useMemo(() => {
    const m = new Map<string, WithId<SizePresetDoc>[]>();
    for (const s of p.sizes) { if (!m.has(s.group)) m.set(s.group, []); m.get(s.group)!.push(s); }
    return [...m.entries()];
  }, [p.sizes]);

  const varAxes = useMemo(() => {
    const m = new Map<string, WithId<VariationDoc>[]>();
    for (const v of p.variations) { if (!m.has(v.axis)) m.set(v.axis, []); m.get(v.axis)!.push(v); }
    return [...m.entries()];
  }, [p.variations]);

  function payload(dryRun: boolean) {
    return {
      mode, sizeValue, dryRun,
      ...(line ? { line } : {}),
      ...(colorKey ? { colorKey } : {}),
      ...(talentCode ? { talentCode, expression } : {}),
      ...(outfitCode ? { outfitCode } : {}),
      ...(baseTab === 'cut' && baseCutUrl ? { baseCutId: baseCutUrl } : {}),
      ...(baseTab === 'pose' && poseRefKey ? { poseRefKey } : {}),
      ...(baseTab === 'pose' && shapeRefKey ? { shapeRefKey } : {}),
      ...(uploads.length ? { uploadedRefs: uploads, preservation } : {}),
      variationIds: Object.values(variationIds).filter((v) => v && !v.endsWith(':auto')),
      ...(direction.trim() ? { direction: direction.trim() } : {}),
      samples,
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
        if (json.prompt) setDry({ prompt: json.prompt, promptMode: json.promptMode, refs: json.refs, aspect: json.aspect ?? '', target: { width: 0, height: 0 } });
        if (!json.ok) setErr(json.results?.find((r: GenResult) => r.error)?.error || '생성 실패');
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true); setErr('');
    try {
      for (const f of Array.from(files).slice(0, 3)) {
        const fd = new FormData();
        fd.append('file', f);
        fd.append('title', f.name);
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        const json = await res.json();
        if (json.ok) setUploads((u) => [...u, { url: json.url, title: json.title }]);
        else setErr(json.error || '업로드 실패');
      }
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const cost = samples * WON_PER_IMAGE;

  return (
    <div className="flex h-full">
      {/* ── 좌: 선택 ── */}
      <div className="flex-1 min-w-0 p-7 overflow-y-auto">
        <header className="mb-5">
          <h1 className="text-[22px] font-extrabold tracking-tight">이미지 생성</h1>
          <p className="text-[13px] mt-1" style={{ color: 'var(--text-dim)' }}>
            모델과 레퍼런스를 고르고 방향만 적으면 됩니다. 프롬프트는 자동으로 만들어집니다.
          </p>
        </header>

        <div className="flex flex-col gap-3 max-w-[680px]">
          {/* ① 용도 · 규격 */}
          <Section n="1" title="용도와 규격" hint="등록된 사이즈에서 고르면 생성 비율과 크롭까지 자동 계산됩니다.">
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
            </select>
            {size && (
              <div className="text-[11px] mt-2 flex gap-3 flex-wrap" style={{ color: 'var(--text-mute)' }}>
                <span>생성 비율 <b style={{ color: 'var(--text-dim)' }}>{size.genAspect}</b></span>
                {size.retention < 1 && (
                  <span style={{ color: size.retention < 0.7 ? 'var(--warn)' : 'var(--text-mute)' }}>
                    {size.cropAxis === 'vertical' ? '세로' : '가로'} {Math.round((1 - size.retention) * 100)}% 크롭
                    {size.retention < 0.7 && ' — 손실이 큽니다'}
                  </span>
                )}
                {size.variableHeight && <span>세로 가변</span>}
              </div>
            )}
          </Section>

          {/* ② 제품 */}
          <Section n="2" title="제품 · 컬러" hint="선택하면 실측 치수·기하 서술·컬러 스와치가 자동으로 들어갑니다.">
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

          {/* ③ 모델 */}
          <Section n="3" title="모델" hint="표정 시트가 아이덴티티 앵커로 함께 들어가 얼굴이 흔들리지 않습니다.">
            <div className="flex flex-wrap gap-2 mb-3">
              <button onClick={() => { setTalentCode(''); setOutfitCode(''); }}
                      className="rounded-lg border px-2.5 py-2 text-[11px]"
                      style={{ borderColor: !talentCode ? 'var(--accent)' : 'var(--line)', color: !talentCode ? 'var(--accent)' : 'var(--text-mute)' }}>
                제품만<br />(인물 없음)
              </button>
              {p.talents.map((t) => (
                <button key={t.code} onClick={() => { setTalentCode(t.code); setOutfitCode(t.outfits[0]?.code ?? ''); }}
                        className="rounded-lg border overflow-hidden text-left"
                        style={{ borderColor: t.code === talentCode ? 'var(--accent)' : 'var(--line)', width: 68 }}>
                  {t.rep
                    /* eslint-disable-next-line @next/next/no-img-element */
                    ? <img src={t.rep} alt={t.code} className="w-full object-cover" style={{ aspectRatio: '3/4' }} />
                    : <div style={{ aspectRatio: '3/4', background: 'var(--surface-2)' }} />}
                  <div className="text-[10px] text-center py-1" style={{ color: t.code === talentCode ? 'var(--accent)' : 'var(--text-mute)' }}>
                    {t.category}{t.slot}
                  </div>
                </button>
              ))}
            </div>
            {talent && (
              <div className="grid sm:grid-cols-2 gap-2">
                <div>
                  <div className="label mb-1">표정</div>
                  <select className="input" value={expression} onChange={(e) => setExpression(e.target.value)}>
                    {p.expressions.map((e) => <option key={e.id} value={e.id}>{e.kr}</option>)}
                  </select>
                </div>
                <div>
                  <div className="label mb-1">의상</div>
                  <select className="input" value={outfitCode} onChange={(e) => setOutfitCode(e.target.value)}>
                    {talent.outfits.map((o) => <option key={o.code} value={o.code}>{o.code} · {o.desc}</option>)}
                  </select>
                </div>
              </div>
            )}
          </Section>

          {/* ④ 베이스 */}
          <Section n="4" title="베이스" hint="확정된 컷을 베이스로 쓰면 각도·형태가 그대로 유지됩니다. 가장 정확한 방법입니다.">
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
              ) : <p className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>제품을 먼저 고르면 그 제품의 실사 포즈 레퍼가 나옵니다.</p>
            )}
          </Section>

          {/* ⑤ 레퍼런스 업로드 */}
          <Section n="5" title="레퍼런스 업로드" hint="원하는 분위기의 이미지를 올리면 조명·색감·구도를 따라갑니다.">
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
            <div className="flex gap-2 flex-wrap items-start">
              <button className="btn" onClick={() => fileInput.current?.click()} disabled={uploading}>
                {uploading ? '업로드 중…' : '＋ 이미지 추가'}
              </button>
              {uploads.map((u, i) => (
                <div key={u.url} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u.url} alt={u.title} className="w-[62px] h-[62px] object-cover rounded-lg border" style={{ borderColor: 'var(--line-strong)' }} />
                  <button onClick={() => setUploads((a) => a.filter((_, j) => j !== i))}
                          className="absolute -top-1.5 -right-1.5 w-[18px] h-[18px] rounded-full text-[11px] leading-none"
                          style={{ background: 'var(--danger)', color: '#fff', border: 'none', cursor: 'pointer' }}>×</button>
                </div>
              ))}
            </div>
            {uploads.length > 0 && (
              <div className="mt-3">
                <div className="label mb-1">올린 레퍼런스를 얼마나 살릴까요</div>
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

          {/* ⑥ 연출 */}
          <Section n="6" title="연출" hint="비워두면 레퍼런스와 베이스를 따라갑니다."
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
          <Section n="7" title="방향 지시" hint="한글로 편하게 적으면 됩니다. 예: 배경을 밝은 거실로, 랩탑 들고 있게">
            <textarea className="input" rows={3} value={direction} onChange={(e) => setDirection(e.target.value)}
                      placeholder="예: 창가 자연광이 드는 아늑한 거실, 옆에 작은 화분" />
          </Section>
        </div>
      </div>

      {/* ── 우: 미리보기 · 실행 ── */}
      <aside className="w-[336px] shrink-0 border-l p-5 overflow-y-auto" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
        <h2 className="text-[13.5px] font-bold mb-3">참조 이미지</h2>
        {dry?.refs?.length ? (
          <div className="flex flex-col gap-1.5 mb-4">
            {dry.refs.map((r, i) => (
              <div key={i} className="flex items-center gap-2 p-1.5 rounded-lg" style={{ background: 'var(--surface-2)' }}>
                <span className="text-[9.5px] w-[38px] shrink-0 font-bold" style={{ color: 'var(--accent)' }}>
                  {['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH'][i]}
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
            {busy === 'dry' ? '만드는 중…' : '프롬프트 확인 (무료)'}
          </button>
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
            예상 비용 약 <b style={{ color: 'var(--text-dim)' }}>₩{cost.toLocaleString()}</b> · 25~30초/장
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

        {dry?.prompt && (
          <details>
            <summary className="text-[12px] cursor-pointer mb-2" style={{ color: 'var(--text-dim)' }}>
              프롬프트 전문 <span style={{ color: 'var(--text-mute)' }}>({dry.promptMode})</span>
            </summary>
            <pre className="text-[10px] leading-relaxed whitespace-pre-wrap p-2.5 rounded-lg font-mono"
                 style={{ background: 'var(--surface-2)', color: 'var(--text-dim)' }}>{dry.prompt}</pre>
          </details>
        )}
      </aside>
    </div>
  );
}
