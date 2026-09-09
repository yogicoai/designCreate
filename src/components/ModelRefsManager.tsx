'use client';

import { useEffect, useState } from 'react';
import { thumbUrl } from '@/lib/thumb';

/**
 * 모델 레퍼런스 — 전속 모델별로 인물 레퍼런스를 모으고, 신체 사이즈를 직접 고친다.
 *
 * 탭 두 개로 나눈다:
 *   레퍼런스 — 그 모델로 태깅된 사진을 보고, 새로 올리면 자동으로 그 모델에 묶인다
 *   모델 설정 — 키·체형. 이 값이 프롬프트의 SCALE 문장으로 그대로 들어가서
 *              제품 대비 인물 크기를 결정한다 (잘못 적히면 빈백이 방석처럼 나온다)
 */

interface Talent {
  code: string;
  label: string;
  name: string;
  rep: string;
  size: string;
  sizeEn: string;
  /** 이 모델을 AI 로 만들 때의 기본 적합도(%) */
  fitPct: number;
  refCount: number;
}

interface RefRow { url: string; title: string }

const PER = 24;

/**
 * 우리 전속 모델과 얼마나 닮게 만들 것인가.
 *
 * 엔진에 넣는 건 숫자가 아니라 문장이다 — 퍼센트는 담당자가 감을 잡기 위한 눈금이고,
 * 실제로는 아래 지시문 강도가 결과를 만든다. 그래서 정확히 몇 %가 나오는 건 아니다.
 */
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
  const [pick, setPick] = useState(initial[0]?.code ?? '');
  const [tab, setTab] = useState<'refs' | 'size'>('refs');

  /*
   * 목록은 "어떤 조건으로 받아온 것인지"를 같이 들고 있는다.
   * 이러면 불러오는 중 여부를 조건과 비교해 알 수 있어서, 이펙트 안에서
   * setState 를 먼저 때릴 필요가 없다 (그건 렌더를 연쇄로 부른다).
   */
  const [list, setList] = useState<{ key: string; rows: RefRow[]; total: number } | null>(null);
  const [page, setPage] = useState(0);

  /** 사이즈 입력값 — 모델별로 따로 담아둔다. 저장 전까지는 여기만 바뀐다. */
  const [edits, setEdits] = useState<Record<string, { size: string; sizeEn: string }>>({});
  /** 적합도 편집값 — 모델별. 저장 전까지는 여기만 바뀐다 */
  const [fitEdits, setFitEdits] = useState<Record<string, number>>({});
  /** 변환 중인 사진 — 카드에 그대로 표시된다 */
  const [converting, setConverting] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');

  const cur = talents.find((t) => t.code === pick);

  const key = cur ? `${cur.label}|${page}` : '';
  const loading = !!cur && list?.key !== key;
  const refs = list?.key === key ? list.rows : [];
  const total = list?.key === key ? list.total : 0;

  // 저장 전 편집값이 있으면 그걸, 없으면 서버 값을 보여준다
  const fit = fitEdits[pick] ?? cur?.fitPct ?? 80;
  const setFit = (v: number) => setFitEdits((c) => ({ ...c, [pick]: v }));
  const size = edits[pick]?.size ?? cur?.size ?? '';
  const sizeEn = edits[pick]?.sizeEn ?? cur?.sizeEn ?? '';
  const setSize = (v: string) => setEdits((c) => ({ ...c, [pick]: { size: v, sizeEn } }));
  const setSizeEn = (v: string) => setEdits((c) => ({ ...c, [pick]: { size, sizeEn: v } }));

  /** 모델 바꾸기 — 목록 쪽 상태는 이펙트가 아니라 여기서 정리한다 */
  function choose(code: string) {
    setPick(code); setPage(0); setNote(''); setErr('');
  }

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
      .catch(() => { /* 목록 실패는 조용히 — 설정 탭은 계속 쓸 수 있다 */ });
    return () => { alive = false; };
  }, [cur, page]);

  async function saveSize() {
    if (!cur) return;
    setBusy(true); setErr(''); setNote('');
    try {
      const j = await (await fetch('/api/talents', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: cur.code, size, sizeEn, fitPct: fit }),
      })).json();
      if (!j.ok) throw new Error(j.error || '저장 실패');
      setTalents((c) => c.map((t) => (t.code === cur.code ? { ...t, size, sizeEn, fitPct: fit } : t)));
      setNote('저장했습니다 — 다음 생성부터 이 값이 들어갑니다.');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  /** 이 모델 앞으로 사진을 올린다 — 분류·모델 태그가 자동으로 붙는다 */
  async function upload(files: FileList | null) {
    if (!files?.length || !cur) return;
    setBusy(true); setErr(''); setNote('');
    let ok = 0;
    try {
      for (const f of Array.from(files).slice(0, 12)) {
        const fd = new FormData();
        fd.append('file', f);
        fd.append('title', `${cur.label} · ${f.name}`);
        fd.append('category', 'model');
        fd.append('sub', cur.label);      // 이 모델로 묶는다
        const j = await (await fetch('/api/upload', { method: 'POST', body: fd })).json();
        if (j.ok) ok += 1;
      }
      setNote(`${ok}장을 ${cur.label} 레퍼런스로 올렸습니다.`);
      setTalents((c) => c.map((t) => (t.code === cur.code ? { ...t, refCount: t.refCount + ok } : t)));
      setPage(0);
      // 방금 올린 것이 보이도록 목록을 다시 받는다
      const j2 = await (await fetch(`/api/references?category=model&sub=${encodeURIComponent(cur.label)}&limit=${PER}`)).json();
      if (j2.ok) {
        setList({ key: `${cur.label}|0`, rows: j2.references.map((r: RefRow) => ({ url: r.url, title: r.title })), total: j2.total ?? 0 });
      }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  /**
   * 이 사진 속 인물을 우리 전속 모델로 바꿔서, 그 결과를 이 모델의 레퍼런스로 넣는다.
   * 사진을 그냥 쌓아두는 게 아니라 "우리 모델 자산"으로 만들어 두는 것이 목적이다.
   */
  async function convert(url: string) {
    if (!cur) return;
    const lv = FIT_LEVELS.find((f) => f.v === fit) ?? FIT_LEVELS[2];
    setConverting(url); setErr(''); setNote('');
    try {
      const j = await (await fetch('/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine: 'gemini',                    // 얼굴이 걸린 작업이라 제미나이 고정
          origin: 'model-ref',
          sizeValue: 'custom',
          customSize: { width: 1152, height: 1536 },
          samples: 1,
          talents: [{ code: cur.code, expression: 'soft_smile' }],
          uploadedRefs: [{ url, title: `${cur.label} 원본`, role: 'base' }],
          editTargets: ['person'],
          direction: lv.line,
          title: `${cur.label} 모델 레퍼런스 (적합성 ${lv.label})`,
        }),
      })).json();
      const hit = (j.results ?? []).find((r: { ok: boolean; url?: string }) => r.ok && r.url);
      if (!hit) throw new Error(j.error || (j.results ?? [])[0]?.error || '변환 실패');

      // 결과를 이 모델의 레퍼런스로 등록 — 다음부터 보관함에서 바로 골라 쓸 수 있다
      await fetch('/api/references', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: hit.url, title: `${cur.label} · 적합성 ${lv.label}`,
          category: 'model', sub: cur.label, width: hit.width, height: hit.height, source: 'generated',
        }),
      });
      setList((c) => (c ? { ...c, rows: [{ url: hit.url, title: `${cur.label} · 적합성 ${lv.label}` }, ...c.rows], total: c.total + 1 } : c));
      setTalents((c) => c.map((t) => (t.code === cur.code ? { ...t, refCount: t.refCount + 1 } : t)));
      setNote(`${cur.label} 로 변환해 레퍼런스에 넣었습니다 (적합성 ${lv.label}).`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setConverting('');
    }
  }

  /** 이 모델에서 떼어낸다 — 사진은 보관함에 남고 모델 태그만 지운다 */
  async function unlink(url: string) {
    if (!confirm('이 사진을 이 모델에서 뗄까요? 사진 자체는 보관함에 남습니다.')) return;
    await fetch('/api/references', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, sub: null }),
    });
    setList((c) => (c ? { ...c, rows: c.rows.filter((r) => r.url !== url), total: Math.max(0, c.total - 1) } : c));
    if (cur) setTalents((c) => c.map((t) => (t.code === cur.code ? { ...t, refCount: Math.max(0, t.refCount - 1) } : t)));
  }

  const pages = Math.ceil(total / PER);

  return (
    <div>
      {/* 모델 고르기 */}
      <div className="flex gap-2 flex-wrap mb-4">
        {talents.map((t) => (
          <button key={t.code} onClick={() => choose(t.code)}
                  className="rounded-lg border p-1.5 flex items-center gap-2"
                  style={pick === t.code
                    ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' }
                    : { borderColor: 'var(--line)' }}>
            {t.rep ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumbUrl(t.rep, 128)} alt="" className="w-8 h-10 object-cover rounded" />
            ) : (
              <span className="w-8 h-10 rounded" style={{ background: 'var(--surface-2)' }} />
            )}
            <span className="text-left">
              <span className="block text-[12px] font-bold"
                    style={{ color: pick === t.code ? 'var(--accent)' : 'var(--text)' }}>{t.label}</span>
              <span className="block text-[10px]" style={{ color: 'var(--text-mute)' }}>
                레퍼런스 {t.refCount.toLocaleString()}장
              </span>
            </span>
          </button>
        ))}
      </div>

      {!cur ? (
        <div className="card p-8 text-center text-[12px]" style={{ color: 'var(--text-mute)' }}>
          전속 모델이 없습니다.
        </div>
      ) : (
        <div className="card p-4">
          {/* 탭 */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {([['refs', `모델 레퍼런스 (${cur.refCount.toLocaleString()})`], ['size', '전속 모델 설정']] as const).map(([k, label]) => (
              <button key={k} className="chip" onClick={() => setTab(k)}
                      style={tab === k ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                {label}
              </button>
            ))}
            <div className="flex-1" />
            <span className="text-[12px] font-bold">{cur.label} · {cur.name}</span>
          </div>

          {tab === 'refs' ? (
            <>
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <label className="btn btn-primary">
                  + 이 모델 레퍼런스 추가
                  <input type="file" accept="image/*" multiple className="hidden" disabled={busy}
                         onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
                </label>
                <span className="mx-1" style={{ color: 'var(--line-strong)' }}>|</span>
                <span className="chip" style={{ color: 'var(--accent)' }}>적합도 {fit}%</span>
                <button className="text-[11px] underline" style={{ color: 'var(--text-mute)' }}
                        onClick={() => setTab('size')}>모델 설정에서 바꾸기</button>
              </div>
              <div className="text-[11.5px] leading-relaxed mb-3" style={{ color: 'var(--text-dim)' }}>
                올린 사진은 <b>모델컷 · {cur.label}</b> 로 분류돼, 이미지 생성 화면의 보관함에서 이 모델 것만 골라 볼 수 있습니다.
                사진 위의 <b>[모델로 변환]</b> 을 누르면 그 사진 속 인물을 <b>{cur.label}</b> 로 바꾼 컷을 만들어
                레퍼런스에 함께 넣습니다 —{' '}
                <b style={{ color: 'var(--accent)' }}>적합성</b> 은 우리 모델을 얼마나 강하게 입힐지입니다
                (숫자가 아니라 지시 강도라 정확히 그 퍼센트가 나오는 건 아닙니다).
              </div>

              {loading ? (
                <div className="text-[12px] py-6 text-center" style={{ color: 'var(--text-mute)' }}>불러오는 중…</div>
              ) : refs.length === 0 ? (
                <div className="rounded-lg border border-dashed p-8 text-center text-[12px]"
                     style={{ borderColor: 'var(--line-strong)', color: 'var(--text-mute)' }}>
                  아직 이 모델로 묶인 레퍼런스가 없습니다.
                </div>
              ) : (
                <>
                  <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))' }}>
                    {refs.map((r) => (
                      <div key={r.url} className="relative group">
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
                                title={`이 사진 속 인물을 ${cur.label} 로 바꾼 컷을 만들어 레퍼런스에 넣습니다`}
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
            </>
          ) : (
            <>
              <div className="text-[11.5px] leading-relaxed mb-3" style={{ color: 'var(--text-dim)' }}>
                여기 적은 키·체형이 생성 프롬프트에 <b>그대로</b> 들어가 제품 대비 인물 크기를 정합니다.
                Max 는 길이 170cm 이므로 <b>&ldquo;Max 170 기준으로 크다/작다&rdquo;</b> 를 같이 적어주면 훨씬 정확해집니다.
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
                <div>
                  <div className="label mb-1">신체 사이즈 (한글)</div>
                  <input className="input w-full" value={size}
                         placeholder="키 172cm · 슬림 롱라인 (Max 170 기준 살짝 크게)"
                         onChange={(e) => setSize(e.target.value)} />
                </div>
                <div>
                  <div className="label mb-1">
                    영문 서술 <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>— 실제 프롬프트에 들어가는 문장</span>
                  </div>
                  <input className="input w-full" value={sizeEn}
                         placeholder="172cm, slim long-limbed build — slightly taller than the 170cm Max"
                         onChange={(e) => setSizeEn(e.target.value)} />
                </div>
              </div>
              <div className="label mt-3 mb-1">
                AI 적합도{' '}
                <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>
                  — 사진 속 인물을 이 모델로 바꿀 때 얼마나 강하게 우리 모델 쪽으로 끌어올지
                </span>
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {FIT_LEVELS.map((f) => (
                  <button key={f.v} className="chip" onClick={() => setFit(f.v)}
                          style={fit === f.v ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="text-[11.5px] mt-1.5" style={{ color: 'var(--text-mute)' }}>
                {FIT_LEVELS.find((f) => f.v === fit)?.desc}
              </div>

              <button className="btn btn-primary mt-3" onClick={saveSize} disabled={busy}>
                {busy ? '저장 중…' : '저장'}
              </button>
            </>
          )}

          {note && <div className="text-[11.5px] mt-3" style={{ color: 'var(--ok)' }}>{note}</div>}
          {err && <div className="text-[11.5px] mt-3" style={{ color: 'var(--danger)' }}>{err}</div>}
        </div>
      )}
    </div>
  );
}
