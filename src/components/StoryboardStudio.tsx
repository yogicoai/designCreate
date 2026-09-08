'use client';

import { useEffect, useMemo, useState } from 'react';
import { thumbUrl } from '@/lib/thumb';
import {
  PURPOSES, CAMERA_MOVES, draftShots, shotPrompt, sceneDirection,
  type Shot, type VideoPurpose, type StoryboardInput,
} from '@/lib/video-storyboard';

/**
 * 스토리보드 — 컷을 세로로 이어붙이며 각 컷의 시작 프레임을 그 자리에서 만든다.
 *
 * 글로 된 시트가 아니라 그림으로 보는 기획안이다. 컷과 컷은 '이어받기' 로 묶이는데,
 * 켜면 앞 컷의 스틸이 다음 컷 생성의 배경 레퍼런스로 들어간다 — 방·조명·컬러가
 * 이어져서, 컷을 따로 뽑고 나중에 톤 보정으로 메우던 일이 사라진다.
 *
 * 완성되면 그대로 영상 대기열로 넘어간다. 컷마다 스틸이 붙어 있으므로
 * 제작 쪽에서 "이 컷은 어느 이미지냐"를 되물을 일이 없다.
 */

interface Pick { url: string; title: string }
interface ProductOpt { line: string; colors: { key: string; name: string }[] }
interface TalentOpt { code: string; label: string }

interface Props {
  cuts: Pick[];
  refs: Pick[];
  products: ProductOpt[];
  talents: TalentOpt[];
}

/** 비율 → 생성 규격. 스틸은 영상 첫 프레임이라 넉넉하게 뽑는다. */
const SIZE: Record<string, { width: number; height: number }> = {
  '9:16': { width: 1152, height: 2048 },
  '1:1': { width: 1536, height: 1536 },
  '16:9': { width: 2048, height: 1152 },
};

export default function StoryboardStudio({ cuts, refs, products, talents }: Props) {
  const [boardId, setBoardId] = useState('');
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState<VideoPurpose>('product');
  const [total, setTotal] = useState(15);
  const [aspect, setAspect] = useState<'9:16' | '1:1' | '16:9'>('9:16');
  const [line, setLine] = useState('');
  const [colorKey, setColorKey] = useState('');
  const [model, setModel] = useState('');
  const [note, setNote] = useState('');
  const [shots, setShots] = useState<Shot[]>([]);

  /** 지금 이미지를 만들고 있는 컷 번호 — 카드에 그대로 표시된다 */
  const [genIdx, setGenIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');

  // 이미지 고르기 팝업
  const [pickFor, setPickFor] = useState<number | null>(null);
  const [pickSrc, setPickSrc] = useState<'cuts' | 'refs'>('cuts');
  const [page, setPage] = useState(0);
  const PER = 24;

  const [boards, setBoards] = useState<{ id: string; title: string; shotCount: number; thumb: string }[]>([]);

  const product = products.find((p) => p.line === line);
  const colorName = product?.colors.find((c) => c.key === colorKey)?.name ?? '';
  const productLabel = line ? `${line}${colorName ? ` ${colorName}` : ''}` : '';
  const modelLabel = talents.find((t) => t.code === model)?.label ?? '';

  const input: StoryboardInput = useMemo(
    () => ({ purpose, total, productLabel, modelLabel }),
    [purpose, total, productLabel, modelLabel],
  );

  const sumSec = shots.reduce((s, x) => s + (Number(x.seconds) || 0), 0);
  const doneCount = shots.filter((s) => s.image).length;

  useEffect(() => { loadBoards(); }, []);

  async function loadBoards() {
    try {
      const j = await (await fetch('/api/storyboards')).json();
      if (j.ok) setBoards(j.boards);
    } catch { /* 목록은 없어도 작업에 지장이 없다 */ }
  }

  function makeDraft() {
    // 이어받기는 두 번째 컷부터 기본 켜짐 — 첫 컷은 이어받을 게 없다
    setShots(draftShots(input).map((s, i) => ({ ...s, chain: i > 0 })));
    setErr(''); setSaved('');
  }

  function patch(i: number, next: Partial<Shot>) {
    setShots((cur) => cur.map((s, j) => (j === i ? { ...s, ...next } : s)));
  }

  function addShot() {
    setShots((cur) => [
      ...cur,
      { no: cur.length + 1, seconds: 4, scene: '', camera: CAMERA_MOVES[1], chain: cur.length > 0 },
    ]);
  }

  function removeShot(i: number) {
    setShots((cur) => cur.filter((_, j) => j !== i).map((s, j) => ({ ...s, no: j + 1 })));
  }

  function move(i: number, dir: -1 | 1) {
    setShots((cur) => {
      const j = i + dir;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j], next[i]];
      return next.map((s, k) => ({ ...s, no: k + 1 }));
    });
  }

  /**
   * 컷 하나의 시작 프레임을 만든다.
   * 이어받기가 켜져 있으면 바로 앞 컷의 스틸을 배경 레퍼런스로 넣는다 —
   * 같은 방·같은 조명에서 다음 순간이 이어지도록.
   */
  async function generateStill(i: number) {
    const s = shots[i];
    if (!s.scene.trim()) { setErr(`컷 ${s.no}: 어떤 장면인지 먼저 적어주세요.`); return; }
    setGenIdx(i); setErr(''); setSaved('');
    try {
      const prev = s.chain ? [...shots.slice(0, i)].reverse().find((x) => x.image) : null;
      const body = {
        samples: 1,
        sizeValue: 'custom',
        customSize: SIZE[aspect],
        engine: 'gemini',
        origin: 'storyboard',          // 생성이미지 갤러리와 섞이지 않게 따로 분류
        direction: sceneDirection(s, aspect),
        ...(line ? { line, ...(colorKey ? { colorKey } : {}) } : {}),
        ...(model ? { talents: [{ code: model, expression: 'soft_smile', outfitCode: '' }] } : {}),
        ...(prev?.image
          ? { uploadedRefs: [{ url: prev.image, title: `컷 ${prev.no} 스틸`, role: 'background' as const }] }
          : {}),
        title: `스토리보드 · ${title || '무제'} · 컷 ${s.no}`,
      };
      const j = await (await fetch('/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })).json();
      const hit = (j.results ?? []).find((r: { ok: boolean; url?: string }) => r.ok && r.url);
      if (!hit) throw new Error(j.error || (j.results ?? [])[0]?.error || '생성 실패');
      patch(i, { image: hit.url, imageTitle: `컷 ${s.no}` });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setGenIdx(null);
    }
  }

  async function save() {
    setBusy(true); setErr('');
    try {
      const j = await (await fetch('/api/storyboards', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: boardId || undefined, title, purpose, total, aspect, line, colorKey, model, note, shots }),
      })).json();
      if (!j.ok) throw new Error(j.error || '저장 실패');
      setBoardId(j.id); setSaved('저장했습니다.');
      await loadBoards();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function open(id: string) {
    setBusy(true); setErr('');
    try {
      const j = await (await fetch(`/api/storyboards?id=${encodeURIComponent(id)}`)).json();
      if (!j.ok) throw new Error(j.error || '불러오기 실패');
      const b = j.board;
      setBoardId(b.id); setTitle(b.title ?? ''); setPurpose(b.purpose ?? 'product');
      setTotal(b.total ?? 15); setAspect(b.aspect ?? '9:16');
      setLine(b.line ?? ''); setColorKey(b.colorKey ?? ''); setModel(b.model ?? '');
      setNote(b.note ?? ''); setShots(Array.isArray(b.shots) ? b.shots : []);
      setSaved('');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  /** 완성된 스토리보드를 영상 대기열로 — 컷마다 스틸이 붙은 채로 넘어간다 */
  async function sendToQueue() {
    if (!shots.length) { setErr('컷이 없습니다.'); return; }
    const missing = shots.filter((s) => !s.image).length;
    if (missing && !confirm(`스틸이 없는 컷이 ${missing}개 있습니다. 그대로 넘길까요?`)) return;
    setBusy(true); setErr('');
    try {
      const j = await (await fetch('/api/video-queue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title || '무제 영상',
          purpose, total: sumSec, aspect,
          firstFrame: shots.find((s) => s.image)?.image ?? '',
          product: productLabel, model: modelLabel, note,
          // 컷마다 사람이 읽는 내용 + 스틸 + 그대로 넣을 영어 프롬프트
          shots: shots.map((s) => ({
            no: s.no, seconds: s.seconds, scene: s.scene, camera: s.camera,
            image: s.image ?? '', chain: !!s.chain,
            prompt: shotPrompt(s, input, aspect),
          })),
        }),
      })).json();
      if (!j.ok) throw new Error(j.error || '대기열 등록 실패');
      setSaved('영상 대기열에 넣었습니다 — 대화에서 "영상 대기열 돌려줘" 라고 하면 제작해 올려드립니다.');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const pool = pickSrc === 'cuts' ? cuts : refs;
  const shown = pool.slice(page * PER, (page + 1) * PER);
  const ratio = aspect.replace(':', '/');

  return (
    <div>
      {/* ── 공통 설정 — 한 번 고르면 전 컷에 적용된다 ───────────────── */}
      <div className="card p-4 mb-4">
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <input className="input flex-1 min-w-[220px]" value={title} placeholder="스토리보드 이름 (예: 드롭 네이비 · 가을 라운지)"
                 onChange={(e) => setTitle(e.target.value)} />
          <button className="btn" onClick={save} disabled={busy}>저장</button>
          {boards.length > 0 && (
            <select className="input" value="" onChange={(e) => e.target.value && open(e.target.value)}>
              <option value="">불러오기…</option>
              {boards.map((b) => <option key={b.id} value={b.id}>{b.title} · {b.shotCount}컷</option>)}
            </select>
          )}
        </div>

        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <div>
            <div className="label mb-1">무엇을 위한 영상인가</div>
            <div className="flex gap-1 flex-wrap">
              {PURPOSES.map((p) => (
                <button key={p.value} className="chip" title={p.desc} onClick={() => setPurpose(p.value)}
                        style={purpose === p.value ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="label mb-1">비율</div>
            <div className="flex gap-1">
              {(['9:16', '1:1', '16:9'] as const).map((a) => (
                <button key={a} className="chip" onClick={() => setAspect(a)}
                        style={aspect === a ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                  {a}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="label mb-1">전체 길이 (초)</div>
            <input className="input w-[90px]" type="number" min={4} max={60} value={total}
                   onChange={(e) => setTotal(Number(e.target.value) || 0)} />
          </div>
          <div>
            <div className="label mb-1">제품</div>
            <div className="flex gap-1">
              <select className="input flex-1" value={line} onChange={(e) => { setLine(e.target.value); setColorKey(''); }}>
                <option value="">제품 없음</option>
                {products.map((p) => <option key={p.line} value={p.line}>{p.line}</option>)}
              </select>
              {product && (
                <select className="input flex-1" value={colorKey} onChange={(e) => setColorKey(e.target.value)}>
                  <option value="">컬러 자동</option>
                  {product.colors.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                </select>
              )}
            </div>
          </div>
          <div>
            <div className="label mb-1">모델</div>
            <select className="input w-full" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">인물 없음</option>
              {talents.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <button className="btn btn-primary" onClick={makeDraft}>
            {shots.length ? '컷 다시 짜기' : '컷 짜기 시작'}
          </button>
          <span className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
            용도에 맞는 컷 구성을 만들어 드립니다 — 장면 글은 고쳐 쓰시면 됩니다.
          </span>
        </div>
      </div>

      {shots.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="text-[13px] font-bold mb-1.5">컷을 짜면 여기에 스토리보드가 그려집니다</div>
          <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
            컷마다 장면을 적고 [이미지 만들기] 를 누르면 그 자리에 시작 프레임이 생깁니다.<br />
            컷과 컷은 <b>이어받기</b>로 묶여서, 앞 컷의 방·조명·색이 다음 컷으로 이어집니다.
          </div>
        </div>
      ) : (
        <>
          {/* ── 진행 요약 ─────────────────────────────────────── */}
          <div className="card p-3 mb-3 flex items-center gap-3 flex-wrap">
            <span className="text-[12.5px] font-bold">{shots.length}컷 · 합계 {sumSec.toFixed(1)}초</span>
            <span className="chip" style={{ color: doneCount === shots.length ? 'var(--ok)' : 'var(--warn)' }}>
              스틸 {doneCount}/{shots.length}
            </span>
            {productLabel && <span className="chip" style={{ color: 'var(--info)' }}>{productLabel}</span>}
            {modelLabel && <span className="chip" style={{ color: 'var(--info)' }}>{modelLabel}</span>}
            <div className="flex-1" />
            <button className="btn" onClick={addShot}>+ 컷 추가</button>
            <button className="btn btn-primary" onClick={sendToQueue} disabled={busy}>▶ 영상 대기열로</button>
          </div>

          {/* ── 컷 체인 ───────────────────────────────────────── */}
          <div className="relative">
            {shots.map((s, i) => {
              const generating = genIdx === i;
              const prevHasImage = shots.slice(0, i).some((x) => x.image);
              return (
                <div key={i}>
                  {/* 컷 사이의 연결 — 이어받기를 켜고 끄는 자리 */}
                  {i > 0 && (
                    <div className="flex items-center gap-2 pl-[26px] py-1.5">
                      <div style={{ width: 2, height: 26, background: s.chain ? 'var(--accent)' : 'var(--line-strong)' }} />
                      <button
                        onClick={() => patch(i, { chain: !s.chain })}
                        className="chip"
                        title="앞 컷의 스틸을 배경 레퍼런스로 물려서 만듭니다 — 방·조명·색이 이어집니다"
                        style={s.chain
                          ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' }
                          : { color: 'var(--text-mute)' }}
                      >
                        {s.chain ? '🔗 앞 컷에서 이어받기' : '이어받지 않음 (독립된 컷)'}
                      </button>
                      {s.chain && !prevHasImage && (
                        <span className="text-[10.5px]" style={{ color: 'var(--warn)' }}>
                          앞 컷 스틸이 아직 없어서 이번엔 그냥 새로 만들어집니다
                        </span>
                      )}
                    </div>
                  )}

                  <div className="card p-3" style={generating ? { borderColor: 'var(--accent)' } : {}}>
                    <div className="flex gap-3 items-start flex-wrap">
                      {/* 스틸 — 스토리보드의 주인공 */}
                      <div className="shrink-0" style={{ width: aspect === '16:9' ? 220 : 132 }}>
                        <div
                          className="rounded-lg border overflow-hidden relative flex items-center justify-center"
                          style={{
                            aspectRatio: ratio,
                            borderColor: s.image ? 'var(--line-strong)' : 'var(--line)',
                            background: s.image ? '#000' : 'var(--surface-2)',
                            borderStyle: s.image ? 'solid' : 'dashed',
                          }}
                        >
                          {s.image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={thumbUrl(s.image, 384)} alt={`컷 ${s.no}`} className="w-full h-full object-cover" />
                          ) : generating ? (
                            <div className="text-[11px] text-center px-2" style={{ color: 'var(--accent)' }}>
                              만드는 중…
                            </div>
                          ) : (
                            <div className="text-[10.5px] text-center px-2" style={{ color: 'var(--text-mute)' }}>
                              아직 없음
                            </div>
                          )}
                          <div
                            className="absolute top-1 left-1 text-[10.5px] font-extrabold px-1.5 rounded"
                            style={{ background: 'var(--accent)', color: '#fff' }}
                          >
                            {s.no}
                          </div>
                        </div>
                        <div className="flex gap-1 mt-1.5">
                          <button className="chip flex-1" onClick={() => generateStill(i)} disabled={genIdx !== null}
                                  style={{ color: 'var(--accent)', borderColor: 'var(--accent-dim)' }}>
                            {s.image ? '다시 만들기' : '이미지 만들기'}
                          </button>
                          <button className="chip" title="생성 컷·보관함에서 고르기"
                                  onClick={() => { setPickFor(i); setPage(0); }}>고르기</button>
                        </div>
                      </div>

                      {/* 장면 — 이 글이 그대로 생성 지시가 된다 */}
                      <div className="flex-1 min-w-[260px]">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="label">컷 {s.no} — 어떤 장면인가</span>
                          <div className="flex-1" />
                          <button className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}
                                  onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                          <button className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}
                                  onClick={() => move(i, 1)} disabled={i === shots.length - 1}>↓</button>
                          <button className="text-[10.5px]" style={{ color: 'var(--danger)' }}
                                  onClick={() => removeShot(i)}>삭제</button>
                        </div>
                        <textarea
                          className="input w-full" rows={2} value={s.scene}
                          placeholder="예: 창가 소파 옆에 드롭이 놓여 있고, 아침 햇살이 바닥에 길게 떨어진다"
                          onChange={(e) => patch(i, { scene: e.target.value })}
                        />
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <select className="input" value={s.camera} onChange={(e) => patch(i, { camera: e.target.value })}>
                            {CAMERA_MOVES.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                          <div className="flex items-center gap-1">
                            <input className="input w-[68px] text-right" type="number" min={1} max={30} step={0.5}
                                   value={s.seconds}
                                   onChange={(e) => patch(i, { seconds: Number(e.target.value) || 0 })} />
                            <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>초</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="card p-3 mt-3">
            <div className="label mb-1">제작 메모 (선택)</div>
            <input className="input w-full" value={note} placeholder="예: 음원은 잔잔한 피아노 · 엔딩에 로고 리빌"
                   onChange={(e) => setNote(e.target.value)} />
          </div>
        </>
      )}

      {err && <div className="card p-3 mt-3 text-[12px]" style={{ color: 'var(--danger)' }}>{err}</div>}
      {saved && <div className="card p-3 mt-3 text-[12px]" style={{ color: 'var(--ok)' }}>{saved}</div>}

      {/* ── 이미지 고르기 팝업 ─────────────────────────────── */}
      {pickFor !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,.6)' }}
             onClick={() => setPickFor(null)}>
          <div className="card p-4 max-w-[min(1100px,94vw)] max-h-[92vh] overflow-y-auto w-full"
               onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <div className="text-[13px] font-bold">컷 {shots[pickFor]?.no} 의 시작 프레임 고르기</div>
              <div className="flex-1" />
              {(['cuts', 'refs'] as const).map((k) => (
                <button key={k} className="chip" onClick={() => { setPickSrc(k); setPage(0); }}
                        style={pickSrc === k ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                  {k === 'cuts' ? '생성 컷' : '레퍼런스'}
                </button>
              ))}
              <button className="btn" onClick={() => setPickFor(null)}>닫기</button>
            </div>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
              {shown.map((p) => (
                <button key={p.url} className="rounded-lg overflow-hidden border block" style={{ padding: 0 }}
                        onClick={() => { patch(pickFor, { image: p.url, imageTitle: p.title }); setPickFor(null); }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={thumbUrl(p.url, 256)} alt={p.title} loading="lazy"
                       className="w-full object-cover" style={{ aspectRatio: '1/1' }} />
                </button>
              ))}
            </div>
            {pool.length > PER && (
              <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                {Array.from({ length: Math.ceil(pool.length / PER) }).slice(0, 20).map((_, n) => (
                  <button key={n} className="chip" onClick={() => setPage(n)}
                          style={page === n ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                    {n + 1}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
