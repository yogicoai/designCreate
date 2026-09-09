'use client';

import { useState } from 'react';
import { thumbUrl } from '@/lib/thumb';
import { AGE_BANDS, BODY_TYPES, composeSize } from '@/lib/model-profile';

/**
 * 모델 레퍼런스 등록 — "이런 느낌의 사람" 을 사진과 조건으로 등록해 두는 곳.
 *
 * 전속 모델(얼굴 아이덴티티 시트를 가진 고정 모델)과는 다른 자산이다.
 * 여기 등록한 것은 사진 한 장으로 끝나지 않고, 나이대·키·체형·AI 적합도가 함께 붙는다 —
 * 그래야 생성 때 "누구를, 얼마나 닮게" 가 결정된다.
 *
 * 프롬프트에 들어갈 영문 문장은 앱이 조립한다: 손으로 적으면 "Max 170 기준" 같은
 * 기준선을 빼먹어서 빈백 대비 인물 크기가 흔들린다.
 */

export interface ModelRef {
  id: string;
  name: string;
  rep: string;
  age: string;
  heightCm: number;
  bodyType: string;
  fitPct: number;
  note: string;
  size: string;
  sizeEn: string;
  refs: { url: string; title: string }[];
  /** AI 생성컷 — 등록한 느낌으로 다시 뽑은 정면샷 (힉스필드) */
  aiCut: string;
  /** '' 미요청 | 'requested' 생성 대기 | 'done' 완료 */
  aiStatus: string;
  /** 얼굴 시트의 정면 칸 — 카드 썸네일은 시트 전체가 아니라 이걸 쓴다 */
  aiFront: string;
  /** 시트를 칸별로 자른 것 (정면·3/4·측면 좌우) */
  aiPanels: string[];
}

/** 우리 모델로 얼마나 강하게 끌어올지 — 엔진에 들어가는 건 숫자가 아니라 이 문장이다 */
export const FIT_LEVELS = [
  { v: 60, label: '60%', desc: '원본 인물의 느낌을 많이 남긴다' },
  { v: 70, label: '70%', desc: '반반 — 모델 인상이 분명히 보인다' },
  { v: 80, label: '80%', desc: '권장 — 모델 기준, 분위기만 이어감' },
  { v: 90, label: '90%', desc: '거의 동일 — 원본 이목구비를 남기지 않음' },
];

const BLANK: Omit<ModelRef, 'id' | 'size' | 'sizeEn'> = {
  name: '', rep: '', age: '20e', heightCm: 170, bodyType: 'slim', fitPct: 80, note: '', refs: [],
  aiCut: '', aiStatus: '', aiFront: '', aiPanels: [],
};

export default function ModelRefsManager({ initial }: { initial: ModelRef[] }) {
  const [models, setModels] = useState<ModelRef[]>(initial);
  const [editing, setEditing] = useState<string | null>(null);   // id | 'new' | null
  const [form, setForm] = useState({ ...BLANK });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  /** 펼친 카드 id — 상세(모델 정보 + AI 생성 이미지)를 연다 */
  const [detail, setDetail] = useState('');
  /** 카드마다 '등록 사진 / AI 생성 이미지' 중 무엇을 보여줄지 */
  const [viewAi, setViewAi] = useState<Record<string, boolean>>({});

  const ageKr = (v: string) => AGE_BANDS.find((a) => a.v === v)?.kr ?? '';
  const bodyKr = (v: string) => BODY_TYPES.find((b) => b.v === v)?.kr ?? '';
  const preview = composeSize({ age: form.age, heightCm: form.heightCm, bodyType: form.bodyType });

  function startNew() {
    setEditing('new'); setForm({ ...BLANK }); setNote(''); setErr('');
  }
  function startEdit(m: ModelRef) {
    setEditing(m.id);
    setForm({
      name: m.name, rep: m.rep, age: m.age, heightCm: m.heightCm,
      bodyType: m.bodyType, fitPct: m.fitPct, note: m.note, refs: m.refs,
      aiCut: m.aiCut, aiStatus: m.aiStatus, aiFront: m.aiFront, aiPanels: m.aiPanels,
    });
    setNote(''); setErr('');
  }

  /** 사진 올리기 — 대표 한 장(asRep) 또는 레퍼런스 여러 장 */
  async function upload(files: FileList | null, asRep = false) {
    if (!files?.length) return;
    setBusy(true); setErr('');
    try {
      const added: { url: string; title: string }[] = [];
      for (const f of Array.from(files).slice(0, asRep ? 1 : 12)) {
        const fd = new FormData();
        fd.append('file', f);
        fd.append('title', `${form.name || '모델'} · ${f.name}`);
        // 이 화면의 사진은 여기서만 관리한다 — 레퍼런스 보관함에는 섞지 않는다
        fd.append('register', '0');
        const j = await (await fetch('/api/upload', { method: 'POST', body: fd })).json();
        if (!j.ok) throw new Error(j.error || '업로드 실패');
        added.push({ url: j.url, title: j.title ?? f.name });
      }
      setForm((c) => (asRep
        ? { ...c, rep: added[0].url }
        : { ...c, refs: [...added, ...c.refs].slice(0, 60), rep: c.rep || added[0].url }));
      setNote(asRep ? '대표 사진을 넣었습니다.' : `${added.length}장을 넣었습니다.`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function save() {
    if (!form.name.trim()) { setErr('이름을 적어주세요.'); return; }
    setBusy(true); setErr('');
    try {
      const j = await (await fetch('/api/model-refs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, ...(editing !== 'new' ? { id: editing } : {}) }),
      })).json();
      if (!j.ok) throw new Error(j.error || '저장 실패');
      const fresh = await (await fetch('/api/model-refs')).json();
      if (fresh.ok) setModels(fresh.models);
      setEditing(null);
      setNote('등록했습니다.');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  /**
   * AI 생성컷 요청 — 앱 키에는 힉스필드 크레딧이 없어 여기서 바로 못 뽑는다.
   * 대기로 표시해 두면 대화에서 "모델 AI컷 뽑아줘" 로 한꺼번에 처리한다.
   */
  async function requestAi(m: ModelRef) {
    setBusy(true); setErr('');
    try {
      const j = await (await fetch('/api/model-refs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...m, id: m.id, aiStatus: m.aiStatus === 'requested' ? '' : 'requested' }),
      })).json();
      if (!j.ok) throw new Error(j.error || '요청 실패');
      setModels((c) => c.map((x) => (x.id === m.id
        ? { ...x, aiStatus: x.aiStatus === 'requested' ? '' : 'requested' } : x)));
      setNote(m.aiStatus === 'requested' ? '요청을 취소했습니다.' : 'AI 생성 대기로 넣었습니다 — 제작 후 옆에 붙습니다.');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  /** 완성된 AI컷 주소를 직접 붙이기 */
  async function attachAi(m: ModelRef) {
    const v = prompt(`"${m.name}" 의 AI 생성컷 주소를 붙여넣어 주세요. (비우면 해제)`, m.aiCut);
    if (v === null) return;
    setBusy(true); setErr('');
    try {
      const url = v.trim();
      const j = await (await fetch('/api/model-refs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...m, id: m.id, aiCut: url, aiStatus: url ? 'done' : '' }),
      })).json();
      if (!j.ok) throw new Error(j.error || '저장 실패');
      setModels((c) => c.map((x) => (x.id === m.id ? { ...x, aiCut: url, aiStatus: url ? 'done' : '' } : x)));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function remove(m: ModelRef) {
    if (!confirm(`"${m.name}" 을 목록에서 뺄까요?`)) return;
    await fetch(`/api/model-refs?id=${encodeURIComponent(m.id)}`, { method: 'DELETE' });
    setModels((c) => c.filter((x) => x.id !== m.id));
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <button className="btn btn-primary" onClick={startNew}>+ 모델 레퍼런스 등록</button>
        <span className="text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
          사진과 함께 <b>나이대 · 키 · 체형 · AI 적합도</b>를 같이 등록합니다 — 생성할 때 이 조건이 그대로 쓰입니다.
        </span>
      </div>

      {/* 등록 / 수정 폼 */}
      {editing && (
        <div className="card p-4 mb-4" style={{ borderColor: 'var(--accent-dim)' }}>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[13px] font-bold">
              {editing === 'new' ? '모델 레퍼런스 등록' : '수정'}
            </span>
            <div className="flex-1" />
            <button className="chip" onClick={() => setEditing(null)}>취소</button>
          </div>

          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))' }}>
            {/* 대표 사진 */}
            <div>
              <div className="label mb-1">대표 사진</div>
              <div className="flex items-start gap-2">
                <div className="rounded-lg overflow-hidden border shrink-0"
                     style={{ width: 84, aspectRatio: '3/4', borderColor: 'var(--line-strong)', background: 'var(--surface-2)' }}>
                  {form.rep ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumbUrl(form.rep, 256)} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[10px]"
                         style={{ color: 'var(--text-mute)' }}>없음</div>
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
              <input className="input w-full" value={form.name} placeholder="예: 20대 여성 A · 내추럴"
                     onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))} />

              <div className="label mt-2.5 mb-1">나이대</div>
              <select className="input w-full" value={form.age}
                      onChange={(e) => setForm((c) => ({ ...c, age: e.target.value }))}>
                {AGE_BANDS.map((a) => <option key={a.v} value={a.v}>{a.kr}</option>)}
              </select>
            </div>

            <div>
              <div className="label mb-1">키 (cm)</div>
              <input className="input w-[110px]" type="number" min={60} max={220} value={form.heightCm}
                     onChange={(e) => setForm((c) => ({ ...c, heightCm: Number(e.target.value) || 0 }))} />

              <div className="label mt-2.5 mb-1">
                체형 <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>— 몸무게 대신 고릅니다</span>
              </div>
              <div className="flex gap-1 flex-wrap">
                {BODY_TYPES.map((b) => (
                  <button key={b.v} className="chip" onClick={() => setForm((c) => ({ ...c, bodyType: b.v }))}
                          style={form.bodyType === b.v ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                    {b.kr}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="label mb-1">
                AI 적합도 <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>— 얼마나 이 얼굴에 맞출지</span>
              </div>
              <div className="flex gap-1 flex-wrap">
                {FIT_LEVELS.map((f) => (
                  <button key={f.v} className="chip" title={f.desc}
                          onClick={() => setForm((c) => ({ ...c, fitPct: f.v }))}
                          style={form.fitPct === f.v ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="text-[11px] mt-1.5" style={{ color: 'var(--text-mute)' }}>
                {FIT_LEVELS.find((f) => f.v === form.fitPct)?.desc}
              </div>
            </div>
          </div>

          {/* 참고 사진 여러 장 */}
          <div className="label mt-3 mb-1">참고 사진 (여러 장)</div>
          <div className="flex gap-2 flex-wrap items-start">
            {form.refs.map((r) => (
              <div key={r.url} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={thumbUrl(r.url, 128)} alt="" className="rounded border object-cover"
                     style={{ width: 56, aspectRatio: '3/4', borderColor: 'var(--line)' }} />
                <button className="absolute -top-1 -right-1 text-[9px] w-4 h-4 rounded-full"
                        title="빼기" style={{ background: 'var(--danger)', color: '#fff' }}
                        onClick={() => setForm((c) => ({ ...c, refs: c.refs.filter((x) => x.url !== r.url) }))}>×</button>
              </div>
            ))}
            <label className="chip cursor-pointer" style={{ color: 'var(--accent)' }}>
              + 사진 추가
              <input type="file" accept="image/*" multiple className="hidden" disabled={busy}
                     onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
            </label>
          </div>

          <div className="label mt-3 mb-1">메모 (선택)</div>
          <input className="input w-full" value={form.note} placeholder="예: 밝은 톤 · 캐주얼 · 실내 컷 위주"
                 onChange={(e) => setForm((c) => ({ ...c, note: e.target.value }))} />

          {/* 실제로 프롬프트에 들어가는 문장 */}
          <div className="mt-3 p-2.5 rounded-lg" style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
            <div className="label mb-1">생성 프롬프트에 들어갈 문장</div>
            <div className="text-[11.5px] font-mono leading-relaxed" style={{ color: 'var(--text-dim)' }}>
              {preview.sizeEn || '(키를 적으면 문장이 만들어집니다)'}
            </div>
          </div>

          <button className="btn btn-primary mt-3" onClick={save} disabled={busy}>
            {busy ? '저장 중…' : editing === 'new' ? '등록' : '수정 저장'}
          </button>
        </div>
      )}

      {/* 등록된 목록 — 사진 위, 설명 아래. 카드를 누르면 상세가 열린다 */}
      {models.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="text-[13px] font-bold mb-1.5">아직 등록된 모델 레퍼런스가 없습니다</div>
          <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
            [+ 모델 레퍼런스 등록] 으로 사진과 조건을 함께 넣어주세요.
          </div>
        </div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
          {models.map((m) => {
            const showAi = !!m.aiCut && !!viewAi[m.id];
            const shown = showAi ? (m.aiFront || m.aiCut) : m.rep;
            const isOpen = detail === m.id;
            return (
              <div key={m.id} className="card p-2"
                   style={isOpen ? { borderColor: 'var(--accent)' } : {}}>
                <button onClick={() => setDetail(isOpen ? '' : m.id)} className="block w-full text-left"
                        style={{ padding: 0 }}>
                  <div className="rounded-lg overflow-hidden border w-full relative"
                       style={{ aspectRatio: '3/4', borderColor: 'var(--line-strong)', background: 'var(--surface-2)' }}>
                    {shown ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumbUrl(shown, 256)} alt={m.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[11px]"
                           style={{ color: 'var(--text-mute)' }}>사진 없음</div>
                    )}
                    {showAi && (
                      <span className="absolute top-1 left-1 text-[9px] px-1.5 py-0.5 rounded"
                            style={{ background: 'var(--ok)', color: '#04210f' }}>AI</span>
                    )}
                  </div>
                </button>

                <div className="mt-1.5">
                  <div className="text-[12.5px] font-bold leading-snug">{m.name}</div>
                  <div className="text-[10.5px] mt-0.5 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                    {[ageKr(m.age), m.heightCm ? `${m.heightCm}cm` : '', bodyKr(m.bodyType)].filter(Boolean).join(' · ')}
                  </div>
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    <span className="chip" style={{ padding: '1px 6px', fontSize: 10, color: 'var(--accent)' }}>
                      적합도 {m.fitPct}%
                    </span>
                  </div>
                  {/* 적합도 아래 — AI 생성 상태 */}
                  <div className="mt-1">
                    {m.aiCut ? (
                      <span className="chip" style={{ padding: '1px 6px', fontSize: 10, color: 'var(--ok)', borderColor: 'var(--ok)' }}>
                        ✓ AI생성 완료
                      </span>
                    ) : m.aiStatus === 'requested' ? (
                      <span className="chip" style={{ padding: '1px 6px', fontSize: 10, color: 'var(--warn)' }}>
                        생성 대기 중
                      </span>
                    ) : (
                      <button className="chip" style={{ padding: '1px 6px', fontSize: 10 }}
                              disabled={busy} onClick={() => requestAi(m)}>
                        AI 생성 요청
                      </button>
                    )}
                  </div>

                  {/* 보기 전환 — 등록 사진 ↔ AI 생성 이미지 */}
                  {m.aiCut && (
                    <button className="chip w-full justify-center mt-1.5" style={{ fontSize: 10 }}
                            onClick={() => setViewAi((c) => ({ ...c, [m.id]: !c[m.id] }))}>
                      {showAi ? '↩ 등록 사진으로 보기' : 'AI 생성된 이미지로 보기'}
                    </button>
                  )}
                </div>

                {/* 상세 — 모델 정보와 AI 생성 이미지 */}
                {isOpen && (
                  <div className="mt-2 pt-2 border-t" style={{ borderColor: 'var(--line)' }}>
                    <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                      <div><b>나이대</b> {ageKr(m.age)}</div>
                      <div><b>키</b> {m.heightCm}cm</div>
                      <div><b>체형</b> {bodyKr(m.bodyType)}</div>
                      <div><b>적합도</b> {m.fitPct}%</div>
                      {m.note && <div className="mt-1">{m.note}</div>}
                    </div>
                    <div className="mt-1.5 p-1.5 rounded text-[9.5px] font-mono leading-relaxed"
                         style={{ background: 'var(--surface-2)', color: 'var(--text-mute)' }}>
                      {m.sizeEn}
                    </div>

                    <div className="label mt-2 mb-1">AI 생성 이미지</div>
                    {m.aiCut ? (
                      <>
                        {/* 시트 전체 — 다섯 각도가 한 장에 */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={thumbUrl(m.aiCut, 384)} alt="AI 얼굴 시트"
                             className="w-full rounded-lg border"
                             style={{ borderColor: 'var(--ok)' }} />
                        {/* 칸별로 자른 것 — 정면이 맨 앞 */}
                        {m.aiPanels.length > 0 && (
                          <div className="flex gap-1 mt-1">
                            {m.aiPanels.map((u, n) => (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img key={u} src={thumbUrl(u, 128)} alt={`각도 ${n + 1}`} loading="lazy"
                                   className="flex-1 rounded border object-cover"
                                   title={['정면', '3/4 좌', '좌측면', '3/4 우', '우측면'][n] ?? ''}
                                   style={{ aspectRatio: '3/4', borderColor: n === 0 ? 'var(--ok)' : 'var(--line)' }} />
                            ))}
                          </div>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          <a href={m.aiCut} target="_blank" rel="noreferrer" className="text-[10px]"
                             style={{ color: 'var(--text-mute)' }}>원본 보기</a>
                          <button className="text-[10px]" style={{ color: 'var(--text-mute)' }}
                                  onClick={() => attachAi(m)}>주소 바꾸기</button>
                        </div>
                      </>
                    ) : (
                      <div className="rounded-lg border border-dashed p-3 text-center text-[10.5px]"
                           style={{ borderColor: 'var(--line-strong)', color: 'var(--text-mute)' }}>
                        아직 없습니다 — 힉스필드로 이 느낌의 얼굴 시트를 뽑아 여기 붙입니다.
                      </div>
                    )}

                    {m.refs.length > 0 && (
                      <>
                        <div className="label mt-2 mb-1">참고 사진 {m.refs.length}</div>
                        <div className="flex gap-1 flex-wrap">
                          {m.refs.slice(0, 8).map((r) => (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img key={r.url} src={thumbUrl(r.url, 128)} alt="" loading="lazy"
                                 className="rounded border object-cover"
                                 style={{ width: 40, aspectRatio: '3/4', borderColor: 'var(--line)' }} />
                          ))}
                        </div>
                      </>
                    )}

                    <div className="flex items-center gap-2 mt-2">
                      <button className="text-[10.5px]" style={{ color: 'var(--text-dim)' }}
                              onClick={() => startEdit(m)}>수정</button>
                      <button className="text-[10.5px]" style={{ color: 'var(--danger)' }}
                              onClick={() => remove(m)}>빼기</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {note && <div className="text-[11.5px] mt-3" style={{ color: 'var(--ok)' }}>{note}</div>}
      {err && <div className="text-[11.5px] mt-3" style={{ color: 'var(--danger)' }}>{err}</div>}
    </div>
  );
}
