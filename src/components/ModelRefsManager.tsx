'use client';

import { useEffect, useState } from 'react';
import { thumbUrl } from '@/lib/thumb';
import { AGE_BANDS, BODY_TYPES, composeSize } from '@/lib/model-profile';

/**
 * 모델 레퍼런스 — 전속 모델을 갤러리로 보고, 카드 하나를 열어 한 번에 설정한다.
 *
 * 카드 한 장이 곧 한 모델이다: 사진이 위, 그 아래에 나이대·키·체형·적합도가 붙는다.
 * 설정은 고르게만 하고, 프롬프트에 들어갈 영문 문장은 앱이 조립한다 — 손으로 적으면
 * "Max 170 기준" 같은 기준선을 빼먹어서 인물 크기가 흔들리기 때문이다.
 *
 * 사진은 두 갈래다:
 *   대표 이미지  — 이 모델을 알아보는 얼굴. 보관함에는 넣지 않는다.
 *   레퍼런스 추가 — 이때만 보관함(모델컷)에 쌓인다.
 */

interface Talent {
  code: string;
  label: string;
  name: string;
  rep: string;
  size: string;
  sizeEn: string;
  fitPct: number;
  age: string;
  heightCm: number;
  bodyType: string;
  refCount: number;
}

interface RefRow { url: string; title: string }

const PER = 12;

/** 우리 전속 모델과 얼마나 닮게 만들 것인가 — 엔진에 들어가는 건 숫자가 아니라 이 문장이다 */
const FIT_LEVELS = [
  { v: 60, label: '60%', desc: '원본 인물의 느낌을 많이 남긴다',
    line: '우리 전속 모델의 인상을 참고 수준으로만 반영하고, 원본 인물의 헤어·분위기·표정은 상당 부분 그대로 유지해 주세요.' },
  { v: 70, label: '70%', desc: '반반 — 모델 인상이 분명히 보인다',
    line: '우리 전속 모델의 인상이 분명히 보이게 하되, 원본 인물의 헤어스타일과 표정 느낌은 절반쯤 남겨 주세요.' },
  { v: 80, label: '80%', desc: '권장 — 모델 기준, 분위기만 이어감',
    line: '얼굴은 우리 전속 모델을 기준으로 만들고, 원본의 헤어스타일·분위기·조명만 자연스럽게 이어가 주세요.' },
  { v: 90, label: '90%', desc: '거의 동일 — 원본 이목구비를 남기지 않음',
    line: '얼굴은 우리 전속 모델과 사실상 동일해야 합니다. 원본 인물의 이목구비는 남기지 말고, 포즈와 공간만 유지해 주세요.' },
];

export default function ModelRefsManager({ initial }: { initial: Talent[] }) {
  const [talents, setTalents] = useState<Talent[]>(initial);
  const [open, setOpen] = useState('');

  /** 편집값 — 모델별로 담아둔다. 저장 전까지는 여기만 바뀐다 (이펙트로 동기화하지 않는다) */
  const [edits, setEdits] = useState<Record<string, Partial<Talent>>>({});
  const [list, setList] = useState<{ key: string; rows: RefRow[]; total: number } | null>(null);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [converting, setConverting] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');

  const cur = talents.find((t) => t.code === open);
  const draft = (t: Talent): Talent => ({ ...t, ...edits[t.code] });
  const d = cur ? draft(cur) : null;

  const key = cur ? `${cur.label}|${page}` : '';
  const loading = !!cur && list?.key !== key;
  const refs = list?.key === key ? list.rows : [];
  const total = list?.key === key ? list.total : 0;
  const pages = Math.ceil(total / PER);

  useEffect(() => {
    if (!cur) return;
    let alive = true;
    const k = `${cur.label}|${page}`;
    fetch(`/api/references?category=model&sub=${encodeURIComponent(cur.label)}&skip=${page * PER}&limit=${PER}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive || !j.ok) return;
        setList({ key: k, rows: j.references.map((r: RefRow) => ({ url: r.url, title: r.title })), total: j.total ?? 0 });
      })
      .catch(() => { /* 목록이 없어도 설정은 계속 쓸 수 있다 */ });
    return () => { alive = false; };
  }, [cur, page]);

  function patch(code: string, next: Partial<Talent>) {
    setEdits((c) => ({ ...c, [code]: { ...c[code], ...next } }));
  }
  function toggle(code: string) {
    setOpen((c) => (c === code ? '' : code));
    setPage(0); setNote(''); setErr('');
  }

  async function save() {
    if (!cur || !d) return;
    setBusy(true); setErr(''); setNote('');
    try {
      const j = await (await fetch('/api/talents', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: cur.code, name: d.name, age: d.age,
          heightCm: d.heightCm, bodyType: d.bodyType, fitPct: d.fitPct, rep: d.rep,
        }),
      })).json();
      if (!j.ok) throw new Error(j.error || '저장 실패');
      const composed = composeSize({ age: d.age, heightCm: d.heightCm, bodyType: d.bodyType });
      setTalents((c) => c.map((t) => (t.code === cur.code ? { ...d, ...composed } : t)));
      setEdits((c) => ({ ...c, [cur.code]: {} }));
      setNote('저장했습니다 — 다음 생성부터 이 설정이 들어갑니다.');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  /**
   * 사진 올리기.
   *  asRep=true  — 대표 이미지. 보관함에는 넣지 않는다 (register=0).
   *  asRep=false — 레퍼런스 추가. 이때만 모델컷으로 보관함에 쌓인다.
   */
  async function upload(files: FileList | null, asRep = false) {
    if (!files?.length || !cur) return;
    setBusy(true); setErr(''); setNote('');
    let ok = 0; let lastUrl = '';
    try {
      for (const f of Array.from(files).slice(0, asRep ? 1 : 12)) {
        const fd = new FormData();
        fd.append('file', f);
        fd.append('title', `${cur.label} · ${f.name}`);
        if (asRep) {
          fd.append('register', '0');            // 대표 이미지는 보관함에 안 남긴다
        } else {
          fd.append('category', 'model');
          fd.append('sub', cur.label);
        }
        const j = await (await fetch('/api/upload', { method: 'POST', body: fd })).json();
        if (j.ok) { ok += 1; lastUrl = j.url; }
      }
      if (asRep) {
        if (lastUrl) {
          patch(cur.code, { rep: lastUrl });
          setNote('대표 이미지로 넣었습니다 — [설정 저장] 을 눌러 확정해 주세요. (보관함에는 남지 않습니다)');
        }
        return;
      }
      setNote(`${ok}장을 ${cur.label} 레퍼런스로 올렸습니다.`);
      setTalents((c) => c.map((t) => (t.code === cur.code ? { ...t, refCount: t.refCount + ok } : t)));
      setPage(0);
      const j2 = await (await fetch(`/api/references?category=model&sub=${encodeURIComponent(cur.label)}&limit=${PER}`)).json();
      if (j2.ok) setList({ key: `${cur.label}|0`, rows: j2.references.map((r: RefRow) => ({ url: r.url, title: r.title })), total: j2.total ?? 0 });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  /** 사진 속 인물을 이 전속 모델로 바꿔, 그 결과를 이 모델 레퍼런스로 넣는다 */
  async function convert(url: string) {
    if (!cur || !d) return;
    const lv = FIT_LEVELS.find((f) => f.v === d.fitPct) ?? FIT_LEVELS[2];
    setConverting(url); setErr(''); setNote('');
    try {
      const j = await (await fetch('/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine: 'gemini',                       // 얼굴이 걸린 작업이라 제미나이 고정
          origin: 'model-ref',
          sizeValue: 'custom',
          customSize: { width: 1152, height: 1536 },
          samples: 1,
          talents: [{ code: cur.code, expression: 'soft_smile' }],
          uploadedRefs: [{ url, title: `${cur.label} 원본`, role: 'base' }],
          editTargets: ['person'],
          direction: lv.line,
          title: `${cur.label} 모델 레퍼런스 (적합도 ${lv.label})`,
        }),
      })).json();
      const hit = (j.results ?? []).find((r: { ok: boolean; url?: string }) => r.ok && r.url);
      if (!hit) throw new Error(j.error || (j.results ?? [])[0]?.error || '변환 실패');
      await fetch('/api/references', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: hit.url, title: `${cur.label} · 적합도 ${lv.label}`,
          category: 'model', sub: cur.label, width: hit.width, height: hit.height, source: 'generated',
        }),
      });
      setList((c) => (c ? { ...c, rows: [{ url: hit.url, title: `${cur.label} · 적합도 ${lv.label}` }, ...c.rows], total: c.total + 1 } : c));
      setTalents((c) => c.map((t) => (t.code === cur.code ? { ...t, refCount: t.refCount + 1 } : t)));
      setNote(`${cur.label} 로 변환해 레퍼런스에 넣었습니다 (적합도 ${lv.label}).`);
    } catch (e) { setErr((e as Error).message); } finally { setConverting(''); }
  }

  async function unlink(url: string) {
    if (!cur) return;
    if (!confirm('이 사진을 이 모델에서 뗄까요? 사진 자체는 보관함에 남습니다.')) return;
    await fetch('/api/references', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, sub: null }),
    });
    setList((c) => (c ? { ...c, rows: c.rows.filter((r) => r.url !== url), total: Math.max(0, c.total - 1) } : c));
    setTalents((c) => c.map((t) => (t.code === cur.code ? { ...t, refCount: Math.max(0, t.refCount - 1) } : t)));
  }

  const ageKr = (v: string) => AGE_BANDS.find((a) => a.v === v)?.kr ?? '';
  const bodyKr = (v: string) => BODY_TYPES.find((b) => b.v === v)?.kr ?? '';

  return (
    <div>
      {/* 갤러리 — 사진이 위, 설명이 아래 */}
      <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))' }}>
        {talents.map((t) => {
          const v = draft(t);
          const on = open === t.code;
          return (
            <button key={t.code} onClick={() => toggle(t.code)}
                    className="card p-2 text-left"
                    style={on ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
              <div className="rounded-lg overflow-hidden border w-full"
                   style={{ aspectRatio: '3/4', borderColor: 'var(--line-strong)', background: 'var(--surface-2)' }}>
                {v.rep ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumbUrl(v.rep, 256)} alt={t.label} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[11px]"
                       style={{ color: 'var(--text-mute)' }}>사진 없음</div>
                )}
              </div>
              <div className="mt-1.5">
                <div className="text-[12.5px] font-bold" style={{ color: on ? 'var(--accent)' : 'var(--text)' }}>
                  {t.label}
                  {v.name && <span className="font-normal" style={{ color: 'var(--text-dim)' }}> · {v.name}</span>}
                </div>
                <div className="text-[10.5px] mt-0.5 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                  {[ageKr(v.age), v.heightCm ? `${v.heightCm}cm` : '', bodyKr(v.bodyType)].filter(Boolean).join(' · ')}
                </div>
                <div className="flex items-center gap-1 mt-1">
                  <span className="chip" style={{ padding: '1px 6px', fontSize: 10, color: 'var(--accent)' }}>
                    적합도 {v.fitPct}%
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--text-mute)' }}>
                    레퍼 {t.refCount.toLocaleString()}
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* 펼친 카드 — 설정과 레퍼런스 */}
      {cur && d && (
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="text-[13px] font-bold">{cur.label} 설정</span>
            <div className="flex-1" />
            <button className="chip" onClick={() => setOpen('')}>닫기</button>
          </div>

          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <div>
              <div className="label mb-1">
                대표 이미지 <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>— 보관함에는 안 남습니다</span>
              </div>
              <div className="flex items-start gap-2">
                <div className="rounded-lg overflow-hidden border shrink-0"
                     style={{ width: 74, aspectRatio: '3/4', borderColor: 'var(--line-strong)', background: 'var(--surface-2)' }}>
                  {d.rep && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumbUrl(d.rep, 256)} alt="" className="w-full h-full object-cover" />
                  )}
                </div>
                <label className="chip cursor-pointer" style={{ color: 'var(--accent)' }}>
                  사진 올리기
                  <input type="file" accept="image/*" className="hidden" disabled={busy}
                         onChange={(e) => { upload(e.target.files, true); e.target.value = ''; }} />
                </label>
              </div>
            </div>

            <div>
              <div className="label mb-1">이름</div>
              <input className="input w-full" value={d.name} placeholder="모델 이름 (선택)"
                     onChange={(e) => patch(cur.code, { name: e.target.value })} />

              <div className="label mt-2.5 mb-1">나이대</div>
              <select className="input w-full" value={d.age}
                      onChange={(e) => patch(cur.code, { age: e.target.value })}>
                {AGE_BANDS.map((a) => <option key={a.v} value={a.v}>{a.kr}</option>)}
              </select>
            </div>

            <div>
              <div className="label mb-1">키 (cm)</div>
              <input className="input w-[110px]" type="number" min={60} max={220} value={d.heightCm}
                     onChange={(e) => patch(cur.code, { heightCm: Number(e.target.value) || 0 })} />

              <div className="label mt-2.5 mb-1">
                체형 <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>— 몸무게 대신 고릅니다</span>
              </div>
              <div className="flex gap-1 flex-wrap">
                {BODY_TYPES.map((b) => (
                  <button key={b.v} className="chip" onClick={() => patch(cur.code, { bodyType: b.v })}
                          style={d.bodyType === b.v ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                    {b.kr}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="label mb-1">
                AI 적합도 <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>— 우리 모델로 얼마나 강하게</span>
              </div>
              <div className="flex gap-1 flex-wrap">
                {FIT_LEVELS.map((f) => (
                  <button key={f.v} className="chip" title={f.desc} onClick={() => patch(cur.code, { fitPct: f.v })}
                          style={d.fitPct === f.v ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="text-[11px] mt-1.5" style={{ color: 'var(--text-mute)' }}>
                {FIT_LEVELS.find((f) => f.v === d.fitPct)?.desc}
              </div>
            </div>
          </div>

          {/* 조립 결과 — 실제로 프롬프트에 들어가는 문장 */}
          <div className="mt-3 p-2.5 rounded-lg" style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
            <div className="label mb-1">생성 프롬프트에 들어갈 문장</div>
            <div className="text-[11.5px] font-mono leading-relaxed" style={{ color: 'var(--text-dim)' }}>
              {composeSize({ age: d.age, heightCm: d.heightCm, bodyType: d.bodyType }).sizeEn}
            </div>
          </div>

          <button className="btn btn-primary mt-3" onClick={save} disabled={busy}>
            {busy ? '저장 중…' : '설정 저장'}
          </button>

          <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--line)' }}>
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="label">모델 레퍼런스 {total.toLocaleString()}장</span>
              <div className="flex-1" />
              <label className="chip cursor-pointer" style={{ color: 'var(--accent)' }}>
                + 레퍼런스 추가
                <input type="file" accept="image/*" multiple className="hidden" disabled={busy}
                       onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
              </label>
            </div>
            <div className="text-[11.5px] leading-relaxed mb-2.5" style={{ color: 'var(--text-dim)' }}>
              여기서 올린 사진만 보관함(모델컷)에 쌓입니다. 사진 위{' '}
              <b>[{cur.label} 로 변환]</b> 을 누르면 그 사진 속 인물을 이 모델로 바꾼 컷을 만들어
              레퍼런스에 함께 넣습니다 — 적합도 {d.fitPct}% 로 적용됩니다.
            </div>

            {loading ? (
              <div className="text-[12px] py-6 text-center" style={{ color: 'var(--text-mute)' }}>불러오는 중…</div>
            ) : refs.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-[12px]"
                   style={{ borderColor: 'var(--line-strong)', color: 'var(--text-mute)' }}>
                아직 이 모델의 레퍼런스가 없습니다.
              </div>
            ) : (
              <>
                <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))' }}>
                  {refs.map((r) => (
                    <div key={r.url} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={thumbUrl(r.url, 256)} alt={r.title} loading="lazy"
                           className="w-full rounded-lg border object-cover"
                           style={{ aspectRatio: '3/4', borderColor: 'var(--line)' }} />
                      <button onClick={() => unlink(r.url)}
                              className="absolute top-1 right-1 text-[9.5px] px-1.5 py-0.5 rounded"
                              title="이 모델에서 떼기 (사진은 보관함에 남습니다)"
                              style={{ background: 'rgba(0,0,0,.62)', color: '#fff' }}>떼기</button>
                      <button onClick={() => convert(r.url)} disabled={!!converting}
                              className="absolute bottom-1 left-1 right-1 text-[9.5px] px-1.5 py-0.5 rounded"
                              style={{ background: converting === r.url ? 'var(--accent)' : 'rgba(0,0,0,.62)', color: '#fff' }}>
                        {converting === r.url ? '변환 중…' : `${cur.label} 로 변환`}
                      </button>
                    </div>
                  ))}
                </div>
                {pages > 1 && (
                  <div className="flex gap-1.5 mt-3 flex-wrap">
                    {Array.from({ length: Math.min(pages, 30) }).map((_, n) => (
                      <button key={n} className="chip" onClick={() => setPage(n)}
                              style={page === n ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                        {n + 1}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {note && <div className="text-[11.5px] mt-3" style={{ color: 'var(--ok)' }}>{note}</div>}
          {err && <div className="text-[11.5px] mt-3" style={{ color: 'var(--danger)' }}>{err}</div>}
        </div>
      )}
    </div>
  );
}
