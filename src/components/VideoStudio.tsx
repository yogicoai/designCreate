'use client';

/**
 * 영상 제작 — 컷 분할 스토리 시트를 만들어 대기열에 넘긴다.
 *
 * 앱은 "무엇을 찍을지"까지만 정하고, 실제 렌더는 오너가 힉스필드에서 돌린 뒤
 * 완성 영상을 다시 등록한다 (이미지 대기열과 같은 흐름 — 앱 키에는 영상 크레딧이 없다).
 */

import { useEffect, useMemo, useState } from 'react';
import { thumbUrl } from '@/lib/thumb';
import {
  PURPOSES, CAMERA_MOVES, draftShots, shotPrompt,
  type Shot, type VideoPurpose, type StoryboardInput,
} from '@/lib/video-storyboard';

interface Pick { url: string; title: string }

export default function VideoStudio({
  cuts, refs, products, talents,
}: {
  cuts: Pick[];
  refs: Pick[];
  products: { line: string; colors: { key: string; name: string }[] }[];
  talents: { code: string; label: string }[];
}) {
  const [frame, setFrame] = useState<Pick | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSrc, setPickerSrc] = useState<'cuts' | 'refs'>('cuts');
  const [page, setPage] = useState(0);
  const PER = 24;

  const [purpose, setPurpose] = useState<VideoPurpose>('product');
  const [total, setTotal] = useState(10);
  const [aspect, setAspect] = useState<'9:16' | '1:1' | '16:9'>('9:16');
  const [line, setLine] = useState('');
  const [colorKey, setColorKey] = useState('');
  const [model, setModel] = useState('');
  const [note, setNote] = useState('');

  const [shots, setShots] = useState<Shot[]>([]);
  const [saved, setSaved] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<{ id: string; title: string; total: number; shots: unknown[] }[]>([]);

  // 대기 중인 요청서 — 로컬 전용 라우트라 배포에선 조용히 빈 목록이 된다
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const j = await (await fetch('/api/video-queue')).json();
        if (alive && j.ok) setQueue(j.items ?? []);
      } catch { /* 무시 */ }
    })();
    return () => { alive = false; };
  }, []);

  const product = products.find((p) => p.line === line);
  const colorName = product?.colors.find((c) => c.key === colorKey)?.name ?? '';
  const productLabel = line ? `${line}${colorName ? ` ${colorName}` : ''}` : '';
  const modelLabel = talents.find((t) => t.code === model)?.label ?? '';

  const input: StoryboardInput = useMemo(() => ({
    purpose, total, productLabel, modelLabel,
  }), [purpose, total, productLabel, modelLabel]);

  const sumSec = shots.reduce((s, x) => s + (Number(x.seconds) || 0), 0);

  function makeDraft() {
    setShots(draftShots(input));
    setSaved('');
    setErr('');
  }
  function patchShot(i: number, next: Partial<Shot>) {
    setShots((cur) => cur.map((s, k) => (k === i ? { ...s, ...next } : s)));
    setSaved('');
  }
  function addShot() {
    setShots((cur) => [...cur, { no: cur.length + 1, seconds: 3, scene: '', camera: CAMERA_MOVES[0] }]);
  }
  function removeShot(i: number) {
    setShots((cur) => cur.filter((_, k) => k !== i).map((s, k) => ({ ...s, no: k + 1 })));
  }

  async function refreshQueue() {
    try {
      const j = await (await fetch('/api/video-queue')).json();
      if (j.ok) setQueue(j.items ?? []);
    } catch { /* 무시 */ }
  }

  async function sendToQueue() {
    if (!frame) { setErr('첫 프레임으로 쓸 이미지를 골라주세요.'); return; }
    if (!shots.length) { setErr('컷 시트를 먼저 만들어주세요.'); return; }
    setBusy(true); setErr('');
    try {
      const purposeLabel = PURPOSES.find((p) => p.value === purpose)?.label ?? '';
      const body = {
        title: `${productLabel || '영상'} · ${purposeLabel} ${total}초`,
        purpose, total, aspect,
        firstFrame: frame.url,
        product: productLabel, model: modelLabel,
        note,
        // 컷마다 사람이 읽는 시트와 힉스필드용 영어 프롬프트를 함께 남긴다
        shots: shots.map((s) => ({ ...s, prompt: shotPrompt(s, input, aspect) })),
      };
      const j = await (await fetch('/api/video-queue', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })).json();
      if (!j.ok) { setErr(j.error || '실패'); return; }
      setSaved('영상 대기열에 넣었습니다 — 대화에서 "영상 대기열 돌려줘" 라고 하면 제작해 올려드립니다.');
      refreshQueue();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const pool = pickerSrc === 'cuts' ? cuts : refs;
  const shown = pool.slice(page * PER, (page + 1) * PER);
  const card = 'card p-3 mb-3';

  return (
    <div className="flex flex-col xl:flex-row gap-4 xl:items-start">
      {/* ── 왼쪽: 컷 시트 ── */}
      <div className="flex-1 min-w-0">
        <div className={card}>
          <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
            <div className="label">컷 분할 스토리 시트</div>
            <div className="flex gap-1.5">
              <button className="btn" onClick={makeDraft}>✎ 자동 초안 만들기</button>
              <button className="btn btn-primary" onClick={sendToQueue} disabled={busy || !shots.length}>
                {busy ? '보내는 중…' : '▶ 영상 대기열에 넣기'}
              </button>
            </div>
          </div>
          <div className="text-[11px] mb-2 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            컷마다 <b style={{ color: 'var(--text-dim)' }}>무엇을 보여줄지 · 카메라 움직임</b>을 적습니다.
            대기열에 넣으면 오너가 힉스필드로 제작해 완성 영상을 올려드립니다 —
            <b style={{ color: 'var(--text-dim)' }}> 이 화면에서는 생성되지 않습니다.</b>
            {shots.length > 0 && (
              <>
                {' '}지금 합계{' '}
                <b style={{ color: sumSec === total ? 'var(--ok)' : 'var(--warn)' }}>{sumSec}초</b> / 목표 {total}초
              </>
            )}
          </div>

          {!shots.length ? (
            <div className="text-[12px] py-8 text-center" style={{ color: 'var(--text-mute)' }}>
              오른쪽에서 첫 프레임·제품·길이를 고른 뒤 <b style={{ color: 'var(--text-dim)' }}>[✎ 자동 초안 만들기]</b> 를 누르세요.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {shots.map((s, i) => (
                <div key={i} className="p-2 rounded-[10px]"
                     style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                    <span className="chip px-2" style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>컷 {s.no}</span>
                    <input type="number" min={1} max={20} step={0.5} value={s.seconds}
                           onChange={(e) => patchShot(i, { seconds: Number(e.target.value) || 1 })}
                           className="w-[62px] px-1.5 py-0.5 text-[12px] rounded-[6px] tabular-nums text-right"
                           style={{ background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text)' }} />
                    <span className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>초</span>
                    <select className="input py-0.5 text-[11.5px] flex-1 min-w-[150px]" value={s.camera}
                            onChange={(e) => patchShot(i, { camera: e.target.value })}>
                      {CAMERA_MOVES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <button className="chip px-1.5" style={{ color: 'var(--danger)' }}
                            title="이 컷 지우기" onClick={() => removeShot(i)}>✕</button>
                  </div>
                  <textarea value={s.scene} onChange={(e) => patchShot(i, { scene: e.target.value })}
                            placeholder="이 컷에서 무엇을 보여줄지 — 예: 모델이 앉으며 몸이 잠기는 순간"
                            rows={2}
                            className="w-full px-2 py-1 text-[12px] rounded-[8px]"
                            style={{ background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text)' }} />
                </div>
              ))}
              <button className="chip self-start" onClick={addShot}>＋ 컷 추가</button>
            </div>
          )}
          {saved && <div className="text-[11.5px] mt-2" style={{ color: 'var(--ok)' }}>{saved}</div>}
          {err && <div className="text-[11.5px] mt-2" style={{ color: 'var(--danger)' }}>{err}</div>}
        </div>

        {queue.length > 0 && (
          <div className={card}>
            <div className="label mb-1.5">대기 중인 영상 요청 ({queue.length})</div>
            <div className="flex flex-col gap-1">
              {queue.map((q) => (
                <div key={q.id} className="text-[11.5px] px-2 py-1 rounded-[8px]"
                     style={{ background: 'var(--surface-2)', color: 'var(--text-dim)' }}>
                  {q.title} · 컷 {q.shots.length}개 · {q.total}초
                </div>
              ))}
            </div>
            <div className="text-[10px] mt-1.5" style={{ color: 'var(--text-mute)' }}>
              제작이 끝나면 이 목록에서 사라지고, 완성 영상이 등록됩니다.
            </div>
          </div>
        )}
      </div>

      {/* ── 오른쪽: 설정 ── */}
      <aside className="w-full xl:w-[340px] shrink-0">
        <div className={card}>
          <div className="label mb-1.5">1. 첫 프레임</div>
          {frame ? (
            <div className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumbUrl(frame.url, 256)} alt="" className="w-[76px] h-[76px] object-cover rounded-lg border"
                   style={{ borderColor: 'var(--line)' }} />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] truncate" style={{ color: 'var(--text-dim)' }}>{frame.title}</div>
                <button className="chip mt-1" onClick={() => { setPickerOpen(true); setPage(0); }}>바꾸기</button>
              </div>
            </div>
          ) : (
            <button className="btn w-full" onClick={() => { setPickerOpen(true); setPage(0); }}>＋ 이미지 고르기</button>
          )}
          <div className="text-[10px] mt-1.5 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            영상은 이 사진에서 시작해 움직입니다. 제품·인물이 이미 확정된 컷을 고르면 형태가 흔들리지 않습니다.
          </div>
        </div>

        <div className={card}>
          <div className="label mb-1.5">2. 용도 · 길이</div>
          <div className="flex flex-col gap-1">
            {PURPOSES.map((p) => (
              <button key={p.value} className="chip text-left" onClick={() => setPurpose(p.value)}
                      style={purpose === p.value ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                {p.label} <span style={{ color: 'var(--text-mute)' }}>— {p.desc}</span>
              </button>
            ))}
          </div>
          <div className="flex gap-1.5 mt-2 items-center flex-wrap">
            <span className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>길이</span>
            {[6, 10, 15].map((t) => (
              <button key={t} className="chip" onClick={() => setTotal(t)}
                      style={total === t ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>{t}초</button>
            ))}
            <span className="mx-1" style={{ color: 'var(--line-strong)' }}>|</span>
            {(['9:16', '1:1', '16:9'] as const).map((a) => (
              <button key={a} className="chip" onClick={() => setAspect(a)}
                      style={aspect === a ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>{a}</button>
            ))}
          </div>
        </div>

        <div className={card}>
          <div className="label mb-1.5">3. 제품 · 모델</div>
          <select className="input py-1 text-[12px] mb-1.5" value={line}
                  onChange={(e) => { setLine(e.target.value); setColorKey(''); }}>
            <option value="">제품 선택 (선택 사항)</option>
            {products.map((p) => <option key={p.line} value={p.line}>{p.line}</option>)}
          </select>
          {product && (
            <select className="input py-1 text-[12px] mb-1.5" value={colorKey} onChange={(e) => setColorKey(e.target.value)}>
              <option value="">컬러 선택</option>
              {product.colors.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
            </select>
          )}
          <select className="input py-1 text-[12px]" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">인물 없음</option>
            {talents.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
          </select>
        </div>

        <div className={card}>
          <div className="label mb-1.5">4. 제작 메모</div>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
                    placeholder="제작자에게 남길 말 (선택) — 예: 저녁 조명 느낌으로, 첫 컷은 조금 더 천천히"
                    className="input py-1 text-[12px]" />
          <div className="text-[10px] mt-1.5 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            <b style={{ color: 'var(--text-dim)' }}>문구(자막)는 영상 생성에 넣지 않습니다</b> — 힉스필드가 글자를
            제대로 못 만들어서, 화면에 글자가 구워지면 고칠 수도 없습니다.
            자막은 완성된 영상 위에 편집에서 얹는 게 맞습니다.
          </div>
        </div>
      </aside>

      {/* ── 첫 프레임 고르기 팝업 ── */}
      {pickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,.8)' }}
             onClick={() => setPickerOpen(false)}>
          <div className="card p-4 max-w-[min(1100px,94vw)] max-h-[92vh] overflow-y-auto w-full"
               onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-1.5 mb-3 flex-wrap">
              <button className="chip" onClick={() => { setPickerSrc('cuts'); setPage(0); }}
                      style={pickerSrc === 'cuts' ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                생성 컷 ({cuts.length})
              </button>
              <button className="chip" onClick={() => { setPickerSrc('refs'); setPage(0); }}
                      style={pickerSrc === 'refs' ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                레퍼런스 ({refs.length.toLocaleString()})
              </button>
              <button className="chip ml-auto" onClick={() => setPickerOpen(false)}>닫기</button>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
              {shown.map((it) => (
                <button key={it.url} className="rounded-lg overflow-hidden border text-left"
                        style={{ padding: 0, borderColor: 'var(--line)' }}
                        onClick={() => { setFrame(it); setPickerOpen(false); }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={thumbUrl(it.url, 256)} alt={it.title} loading="lazy"
                       className="w-full aspect-square object-cover" style={{ background: 'var(--surface-2)' }} />
                  <div className="text-[10px] px-1.5 py-1 truncate" style={{ color: 'var(--text-dim)' }}>{it.title}</div>
                </button>
              ))}
            </div>
            {pool.length > PER && (
              <div className="flex items-center justify-center gap-2 mt-3">
                <button className="btn" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>이전</button>
                <span className="text-[12px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
                  {page + 1} / {Math.ceil(pool.length / PER)}
                </span>
                <button className="btn" disabled={(page + 1) * PER >= pool.length}
                        onClick={() => setPage((n) => n + 1)}>다음</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
