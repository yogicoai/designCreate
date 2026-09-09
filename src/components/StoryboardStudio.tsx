'use client';

import { useEffect, useMemo, useState } from 'react';
import { thumbUrl } from '@/lib/thumb';
import {
  PURPOSES, CAMERA_MOVES, draftShots, shotPrompt, sceneDirection, endDirection, timeLabel,
  type Shot, type VideoPurpose, type StoryboardInput,
} from '@/lib/video-storyboard';

/**
 * 스토리보드 — 실제 CF 콘티 양식(START/END 프레임 표)으로 짜고, 게시판으로 관리한다.
 *
 * 왜 START/END 두 장인가: 영상 엔진(Kling·Seedance)이 실제로 받는 입력이 시작 프레임 +
 * 끝 프레임이다. 두 장을 주면 엔진은 그 사이만 채운다 — 움직임을 글로 설명하는 것보다
 * 훨씬 정확하다. 끝 프레임은 시작 프레임을 베이스로 파생시켜 만들어서(인물·방·옷·앵글
 * 고정, 동작만 변경) 컷 안에서 얼굴이나 공간이 흔들리지 않는다.
 *
 * 컷과 컷은 '앞 컷 끝 → 다음 컷 시작' 으로 이어붙일 수 있다. 그러면 이음새가 물리적으로
 * 사라져서, 컷을 따로 뽑고 나중에 톤 보정으로 메우던 일이 없어진다.
 *
 * 나레이션·SFX 칸은 편집용 지시다 — 영상 생성에는 넣지 않는다(엔진이 한국어 대사를 못 만든다).
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

interface BoardRow {
  id: string; title: string; status: string; aspect: string;
  total: number; shotCount: number; filled: number; thumb: string; updatedAt: string | null;
}

const STATUSES = ['작성중', '검증중', '영상완료'];

/** 콘티표 컬럼 — xl 이상에서만 표처럼 눕고, 좁아지면 컷마다 세로로 접힌다 */
const GRID_XL = 'xl:grid-cols-[100px_minmax(0,auto)_minmax(220px,1fr)_150px_minmax(0,auto)_28px]';
const STATUS_COLOR: Record<string, string> = {
  작성중: 'var(--text-mute)', 검증중: 'var(--warn)', 영상완료: 'var(--ok)',
};

/** 비율 → 생성 규격. 스틸은 영상 첫 프레임이라 넉넉하게 뽑는다. */
const SIZE: Record<string, { width: number; height: number }> = {
  '9:16': { width: 1152, height: 2048 },
  '1:1': { width: 1536, height: 1536 },
  '16:9': { width: 2048, height: 1152 },
};

/** 어느 칸을 만들고 있는지 — 카드에 그대로 표시된다 */
type Gen = { i: number; kind: 'start' | 'end' } | null;

export default function StoryboardStudio({ cuts, refs, products, talents }: Props) {
  const [view, setView] = useState<'board' | 'edit'>('board');
  const [boards, setBoards] = useState<BoardRow[]>([]);

  const [boardId, setBoardId] = useState('');
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('작성중');
  const [purpose, setPurpose] = useState<VideoPurpose>('product');
  const [total, setTotal] = useState(15);
  const [aspect, setAspect] = useState<'9:16' | '1:1' | '16:9'>('9:16');
  const [line, setLine] = useState('');
  const [colorKey, setColorKey] = useState('');
  const [model, setModel] = useState('');
  const [note, setNote] = useState('');
  const [shots, setShots] = useState<Shot[]>([]);
  /** 사람이 쓴 시나리오 — 이걸 읽고 컷을 나눈다 */
  const [scenario, setScenario] = useState('');
  const [splitting, setSplitting] = useState(false);
  /** 전체 컷을 한 장에 담은 콘티 시트 — 승인·보고용 */
  const [sheet, setSheet] = useState('');
  const [sheeting, setSheeting] = useState(false);
  // 컷을 다 이어붙인 최종 영상 — 콘티 맨 아래에 붙는다
  const [finalClip, setFinalClip] = useState('');
  const [finalNote, setFinalNote] = useState('');

  const [gen, setGen] = useState<Gen>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');

  const [pickFor, setPickFor] = useState<{ i: number; kind: 'start' | 'end' } | null>(null);
  const [pickSrc, setPickSrc] = useState<'cuts' | 'refs'>('cuts');
  const [page, setPage] = useState(0);
  const PER = 24;

  const product = products.find((p) => p.line === line);
  const colorName = product?.colors.find((c) => c.key === colorKey)?.name ?? '';
  const productLabel = line ? `${line}${colorName ? ` ${colorName}` : ''}` : '';
  const modelLabel = talents.find((t) => t.code === model)?.label ?? '';

  const input: StoryboardInput = useMemo(
    () => ({ purpose, total, productLabel, modelLabel }),
    [purpose, total, productLabel, modelLabel],
  );

  const sumSec = shots.reduce((s, x) => s + (Number(x.seconds) || 0), 0);
  const filled = shots.filter((s) => s.image).length;
  const filledEnd = shots.filter((s) => s.endImage).length;

  useEffect(() => { loadBoards(); }, []);

  async function loadBoards() {
    try {
      const j = await (await fetch('/api/storyboards')).json();
      if (j.ok) setBoards(j.boards);
    } catch { /* 목록이 없어도 작업에는 지장이 없다 */ }
  }

  function reset() {
    setBoardId(''); setTitle(''); setStatus('작성중'); setPurpose('product');
    setTotal(15); setAspect('9:16'); setLine(''); setColorKey(''); setModel('');
    setNote(''); setScenario(''); setSheet(''); setShots([]); setFinalClip(''); setFinalNote(''); setErr(''); setSaved('');
  }

  async function open(id: string) {
    setBusy(true); setErr('');
    try {
      const j = await (await fetch(`/api/storyboards?id=${encodeURIComponent(id)}`)).json();
      if (!j.ok) throw new Error(j.error || '불러오기 실패');
      const b = j.board;
      setBoardId(b.id); setTitle(b.title ?? ''); setStatus(b.status ?? '작성중');
      setPurpose(b.purpose ?? 'product'); setTotal(b.total ?? 15); setAspect(b.aspect ?? '9:16');
      setLine(b.line ?? ''); setColorKey(b.colorKey ?? ''); setModel(b.model ?? '');
      setNote(b.note ?? ''); setScenario(b.scenario ?? ''); setShots(Array.isArray(b.shots) ? b.shots : []);
      setFinalClip(b.finalClip ?? ''); setFinalNote(b.finalNote ?? ''); setSheet(b.sheet ?? '');
      setSaved(''); setView('edit');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function save(nextStatus?: string) {
    setBusy(true); setErr('');
    try {
      const j = await (await fetch('/api/storyboards', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: boardId || undefined, title, status: nextStatus ?? status,
          purpose, total: sumSec || total, aspect, line, colorKey, model, note, scenario, sheet, shots,
          finalClip, finalNote,
        }),
      })).json();
      if (!j.ok) throw new Error(j.error || '저장 실패');
      setBoardId(j.id);
      if (nextStatus) setStatus(nextStatus);
      setSaved('저장했습니다.');
      await loadBoards();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function removeBoard(b: BoardRow) {
    if (!confirm(`"${b.title}" 을 지울까요?`)) return;
    await fetch(`/api/storyboards?id=${encodeURIComponent(b.id)}`, { method: 'DELETE' });
    await loadBoards();
  }

  /**
   * 시나리오를 컷으로 나눈다.
   * 용도 뼈대(makeDraft)와 달리 사람이 쓴 글을 읽어야 해서 모델 판단이 들어간다 —
   * 시나리오 하나당 한 번 호출된다.
   */
  async function splitFromScenario() {
    if (scenario.trim().length < 10) { setErr('시나리오를 조금 더 적어주세요.'); return; }
    setSplitting(true); setErr(''); setSaved('');
    try {
      const j = await (await fetch('/api/storyboards/split', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario, total, aspect, productLabel, modelLabel }),
      })).json();
      if (!j.ok) throw new Error(j.error || '컷 나누기 실패');
      setShots(j.shots as Shot[]);
      if (j.intent) setNote((c) => c || String(j.intent));
      setSaved(`${(j.shots as Shot[]).length}컷으로 나눴습니다 — 컷마다 장면·동작을 고친 뒤 이미지를 만드세요.`);
    } catch (e) { setErr((e as Error).message); } finally { setSplitting(false); }
  }

  /**
   * 콘티 시트 한 장 만들기 — 컷을 한 화면에 늘어놓고 칸별로 잘라 각 컷에 붙인다.
   * 한 장 안에 같이 그리게 하면 방·조명·인물이 저절로 맞는다. 컷을 따로 뽑으면
   * 서로 다른 사람이 되기 쉽다.
   */
  async function makeSheet() {
    if (!shots.length) { setErr('먼저 컷을 나눠주세요.'); return; }
    setSheeting(true); setErr(''); setSaved('');
    try {
      const j = await (await fetch('/api/storyboards/sheet', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shots, aspect, productLabel, modelLabel }),
      })).json();
      if (!j.ok) throw new Error(j.error || '시트 생성 실패');
      setSheet(j.sheetUrl);
      // 잘린 칸을 각 컷의 시작 프레임으로 넣는다 (확인용 — 승인 뒤 크게 다시 뽑는다)
      const urls = (j.panels ?? []) as string[];
      setShots((cur) => cur.map((s2, i) => (urls[i] ? { ...s2, image: urls[i], imageTitle: `콘티 칸 ${i + 1}` } : s2)));
      setSaved(`콘티 시트를 만들고 ${urls.length}컷에 붙였습니다.${j.note ? ` ${j.note}` : ''} 확인용 크기라, 확정되면 컷별로 크게 다시 뽑으세요.`);
    } catch (e) { setErr((e as Error).message); } finally { setSheeting(false); }
  }

  function makeDraft() {
    setShots(draftShots(input).map((s, i) => ({ ...s, action: '', chain: i > 0 })));
    setErr(''); setSaved('');
  }

  function patch(i: number, next: Partial<Shot>) {
    setShots((cur) => cur.map((s, j) => (j === i ? { ...s, ...next } : s)));
  }
  function addShot() {
    setShots((cur) => [...cur, {
      no: cur.length + 1, seconds: 2, scene: '', action: '', camera: CAMERA_MOVES[1], chain: cur.length > 0,
    }]);
  }
  function removeShot(i: number) {
    setShots((cur) => cur.filter((_, j) => j !== i).map((s, j) => ({ ...s, no: j + 1 })));
  }
  function move(i: number, dir: -1 | 1) {
    setShots((cur) => {
      const j = i + dir;
      if (j < 0 || j >= cur.length) return cur;
      const n = [...cur];
      [n[i], n[j]] = [n[j], n[i]];
      return n.map((s, k) => ({ ...s, no: k + 1 }));
    });
  }

  /**
   * 클립 주소를 재생 주소로. cafe24 에는 .jpg 로 위장 저장돼 있어서
   * /api/video 프록시를 태워야 video/mp4 로 나온다.
   */
  function videoSrc(raw: string): string {
    if (!raw) return '';
    if (raw.startsWith('/api/video/')) return raw;
    // 힉스필드 CDN 처럼 남의 서버에 있는 mp4 는 그대로 재생된다 — 프록시를 태우면 오히려 깨진다
    try {
      const u = new URL(raw);
      const ours = u.hostname.endsWith('cafe24.com') || u.hostname.endsWith('yogibo.kr');
      if (!ours) return raw;
      if (/\.mp4($|\?)/i.test(u.pathname)) return raw;
      return `/api/video/${u.pathname.replace(/^\/+/, '')}`;
    } catch {
      return `/api/video/${raw.replace(/^\/+/, '')}`;
    }
  }

  /** 완성 클립 붙이기 — 제작은 대화에서 돌고, 나온 주소를 여기 달아 콘티에 반영한다 */
  function attachClip(i: number) {
    const cur = shots[i]?.clip ?? '';
    const v = prompt(
      `컷 ${shots[i]?.no} 의 완성 영상 주소를 붙여넣어 주세요. (비우고 확인하면 등록이 해제됩니다)`,
      cur,
    );
    if (v === null) return;
    patch(i, { clip: v.trim() });
  }

  /** 앞 컷의 끝 프레임을 이 컷의 시작으로 — 이음새가 물리적으로 사라진다 */
  function inheritPrevEnd(i: number) {
    const prev = shots[i - 1];
    if (!prev?.endImage) { setErr(`컷 ${i}: 앞 컷의 끝 프레임이 아직 없습니다.`); return; }
    patch(i, { image: prev.endImage, imageTitle: `컷 ${prev.no} 끝에서 이어받음`, chain: true });
    setErr('');
  }

  /**
   * 칸 하나를 생성한다.
   *  - start: 장면 글로 새로 만든다 (이어받기가 켜져 있으면 앞 컷 스틸을 배경 레퍼런스로)
   *  - end:   이 컷의 시작 프레임을 베이스로, 동작만 바꿔 파생시킨다
   */
  async function generate(i: number, kind: 'start' | 'end') {
    const s = shots[i];
    if (kind === 'start' && !s.scene.trim()) { setErr(`컷 ${s.no}: 장면을 먼저 적어주세요.`); return; }
    if (kind === 'end' && !s.image) { setErr(`컷 ${s.no}: 끝 프레임은 시작 프레임에서 만듭니다 — 시작을 먼저 채워주세요.`); return; }
    setGen({ i, kind }); setErr(''); setSaved('');
    try {
      const prev = kind === 'start' && s.chain
        ? [...shots.slice(0, i)].reverse().find((x) => x.endImage || x.image)
        : null;
      const prevUrl = prev ? (prev.endImage || prev.image) : '';
      const body = {
        samples: 1,
        sizeValue: 'custom',
        customSize: SIZE[aspect],
        engine: 'gemini',
        origin: 'storyboard',
        direction: kind === 'end' ? endDirection(s) : sceneDirection(s, aspect),
        ...(line ? { line, ...(colorKey ? { colorKey } : {}) } : {}),
        ...(model ? { talents: [{ code: model, expression: 'soft_smile', outfitCode: '' }] } : {}),
        ...(kind === 'end'
          // 시작 프레임을 base 로 넣으면 "그대로 재현하고 지정한 것만 바꿔라"로 조립된다
          ? { uploadedRefs: [{ url: s.image!, title: `컷 ${s.no} 시작`, role: 'base' as const }] }
          : prevUrl
            ? { uploadedRefs: [{ url: prevUrl, title: '앞 컷', role: 'background' as const }] }
            : {}),
        title: `스토리보드 · ${title || '무제'} · 컷 ${s.no} ${kind === 'end' ? '끝' : '시작'}`,
      };
      const j = await (await fetch('/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })).json();
      const hit = (j.results ?? []).find((r: { ok: boolean; url?: string }) => r.ok && r.url);
      if (!hit) throw new Error(j.error || (j.results ?? [])[0]?.error || '생성 실패');
      patch(i, kind === 'end'
        ? { endImage: hit.url, endImageTitle: `컷 ${s.no} 끝` }
        : { image: hit.url, imageTitle: `컷 ${s.no} 시작` });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setGen(null);
    }
  }

  async function sendToQueue() {
    if (!shots.length) { setErr('컷이 없습니다.'); return; }
    const missing = shots.filter((s) => !s.image).length;
    if (missing && !confirm(`시작 프레임이 없는 컷이 ${missing}개 있습니다. 그대로 넘길까요?`)) return;
    setBusy(true); setErr('');
    try {
      const j = await (await fetch('/api/video-queue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title || '무제 영상',
          purpose, total: sumSec, aspect,
          firstFrame: shots.find((s) => s.image)?.image ?? '',
          product: productLabel, model: modelLabel, note,
          shots: shots.map((s) => ({
            no: s.no, seconds: s.seconds, time: timeLabel(shots, s.no - 1),
            scene: s.scene, action: s.action ?? '', camera: s.camera,
            startImage: s.image ?? '', endImage: s.endImage ?? '',
            narration: s.narration ?? '', sfx: s.sfx ?? '',
            prompt: shotPrompt(s, input, aspect),
          })),
        }),
      })).json();
      if (!j.ok) throw new Error(j.error || '대기열 등록 실패');
      await save('검증중');
      setSaved('영상 대기열에 넣었습니다 — 대화에서 "영상 대기열 돌려줘" 라고 하면 제작해 올려드립니다.');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const pool = pickSrc === 'cuts' ? cuts : refs;
  const shown = pool.slice(page * PER, (page + 1) * PER);
  const ratio = aspect.replace(':', '/');
  // 프레임 폭 — 좁은 화면에서도 두 장이 나란히 들어가도록 줄어든다
  const frameW = aspect === '16:9' ? 'w-[124px] sm:w-[150px]' : 'w-[76px] sm:w-[92px]';

  // ── 게시판 ─────────────────────────────────────────────────────
  if (view === 'board') {
    return (
      <div>
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <button className="btn btn-primary" onClick={() => { reset(); setView('edit'); }}>+ 새 스토리보드</button>
          <div className="flex-1" />
          <span className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
            작성중 → 검증중 → 영상완료 순으로 진행 상태를 바꿔가며 관리합니다.
          </span>
        </div>

        {boards.length === 0 ? (
          <div className="card p-8 text-center text-[12px]" style={{ color: 'var(--text-mute)' }}>
            아직 스토리보드가 없습니다.
          </div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line-strong)' }}>
                  {['', '제목', '컷', '길이', '스틸', '상태', '수정', ''].map((h, i) => (
                    <th key={i} className="label text-left px-2.5 py-2 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {boards.map((b) => (
                  <tr key={b.id} style={{ borderBottom: '1px solid var(--line)' }}>
                    <td className="px-2.5 py-2">
                      <div className="rounded overflow-hidden border" style={{
                        width: 34, height: 48, borderColor: 'var(--line-strong)', background: 'var(--surface-2)',
                      }}>
                        {b.thumb && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={thumbUrl(b.thumb, 128)} alt="" className="w-full h-full object-cover" />
                        )}
                      </div>
                    </td>
                    <td className="px-2.5 py-2">
                      <button className="text-left font-bold hover:underline" style={{ color: 'var(--accent)' }}
                              onClick={() => open(b.id)}>{b.title}</button>
                    </td>
                    <td className="px-2.5 py-2 tabular-nums whitespace-nowrap">{b.shotCount}컷</td>
                    <td className="px-2.5 py-2 tabular-nums whitespace-nowrap">{b.total}초 · {b.aspect}</td>
                    <td className="px-2.5 py-2 tabular-nums whitespace-nowrap"
                        style={{ color: b.filled === b.shotCount && b.shotCount ? 'var(--ok)' : 'var(--text-mute)' }}>
                      {b.filled}/{b.shotCount}
                    </td>
                    <td className="px-2.5 py-2 whitespace-nowrap">
                      <span className="chip" style={{ color: STATUS_COLOR[b.status] ?? 'var(--text-mute)' }}>{b.status}</span>
                    </td>
                    <td className="px-2.5 py-2 whitespace-nowrap" style={{ color: 'var(--text-mute)' }}>
                      {b.updatedAt ? b.updatedAt.slice(0, 10) : ''}
                    </td>
                    <td className="px-2.5 py-2 text-right">
                      <button className="text-[10.5px]" style={{ color: 'var(--danger)' }}
                              onClick={() => removeBoard(b)}>삭제</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {err && <div className="card p-3 mt-3 text-[12px]" style={{ color: 'var(--danger)' }}>{err}</div>}
      </div>
    );
  }

  // ── 콘티 편집 ───────────────────────────────────────────────────
  return (
    <div>
      <div className="card p-4 mb-4">
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <button className="btn" onClick={() => { setView('board'); loadBoards(); }}>← 목록</button>
          <input className="input flex-1 min-w-[220px]" value={title}
                 placeholder="제목 (예: 하루의 끝, 요기보 — 18초 라이프스타일 CF)"
                 onChange={(e) => setTitle(e.target.value)} />
          <div className="flex gap-1">
            {STATUSES.map((st) => (
              <button key={st} className="chip" onClick={() => setStatus(st)}
                      style={status === st ? { borderColor: STATUS_COLOR[st], color: STATUS_COLOR[st] } : {}}>
                {st}
              </button>
            ))}
          </div>
          <button className="btn" onClick={() => save()} disabled={busy}>저장</button>
        </div>

        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
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
                        style={aspect === a ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>{a}</button>
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

        {/* 시나리오 → 컷 분할. 글로 쓰면 연출부가 끊어주듯 컷이 나온다 */}
        <div className="mt-3 p-3 rounded-lg" style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
          <div className="label mb-1">
            시나리오{' '}
            <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>
              — 어떤 영상인지 편하게 적어주세요. 읽고 컷을 나눠 드립니다.
            </span>
          </div>
          <textarea
            className="input w-full" rows={3} value={scenario}
            placeholder="예: 직장인 여성이 퇴근하고 집에 와서 빈백에 몸을 던지고 편안하게 쉬는 20초 CF. 저녁 무드, 따뜻한 조명. 마지막은 로고로 마무리."
            onChange={(e) => setScenario(e.target.value)}
          />
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <button className="btn btn-primary" onClick={splitFromScenario} disabled={splitting || !!busy}>
              {splitting ? '컷 나누는 중…' : '✂ 시나리오로 컷 나누기'}
            </button>
            <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
              위에서 고른 <b>길이 · 비율 · 제품 · 모델</b>을 반영합니다. 컷은 나눈 뒤에도 고칠 수 있습니다.
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <button className="btn" onClick={makeDraft} title="시나리오 없이 용도별 기본 컷 구성으로 시작합니다">
            {shots.length ? '기본 구성으로 다시' : '기본 구성으로 시작'}
          </button>
          {shots.length > 0 && (
            <button className="btn" onClick={makeSheet} disabled={sheeting || !!busy}
                    title="전체 컷을 한 장에 그려서 칸별로 잘라 붙입니다 — 방·조명·인물이 저절로 맞습니다">
              {sheeting ? '콘티 시트 만드는 중…' : '🎞 콘티 시트 한 장으로'}
            </button>
          )}
          {shots.length > 0 && (
            <>
              <button className="btn" onClick={addShot}>+ 컷 추가</button>
              <span className="text-[12px] tabular-nums" style={{ color: 'var(--text-dim)' }}>
                {shots.length}컷 · {sumSec.toFixed(0)}초 · 시작 {filled}/{shots.length} · 끝 {filledEnd}/{shots.length}
              </span>
              <div className="flex-1" />
              <button className="btn btn-primary" onClick={sendToQueue} disabled={busy}>▶ 영상 대기열로</button>
            </>
          )}
        </div>
      </div>

      {/* 콘티 시트 — 전체 흐름을 한 장으로. 승인·보고용이라 크게 보여준다 */}
      {sheet && (
        <div className="card p-3 mb-3">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="label">콘티 시트 — 전체 컷을 한 장에</span>
            <div className="flex-1" />
            <a href={sheet} target="_blank" rel="noreferrer" className="chip">크게 보기</a>
            <button className="chip" onClick={() => setSheet('')}>닫기</button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={sheet} alt="콘티 시트" className="w-full rounded-lg border"
               style={{ borderColor: 'var(--line-strong)' }} />
          <div className="text-[11px] mt-1.5 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            한 장에 같이 그려서 방·조명·인물이 맞습니다. <b>확인용 크기</b>라 각 칸은 작습니다 —
            확정되면 컷별 [만들기] 로 크게 다시 뽑으세요.
          </div>
        </div>
      )}

      {shots.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="text-[13px] font-bold mb-1.5">컷을 짜면 여기에 콘티표가 그려집니다</div>
          <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
            컷마다 <b>시작 프레임</b>과 <b>끝 프레임</b> 두 장을 채웁니다 — 영상 엔진이 그 사이를 채웁니다.<br />
            끝 프레임은 시작에서 파생시켜 만들고, 앞 컷의 끝을 다음 컷의 시작으로 이어붙일 수 있습니다.
          </div>
        </div>
      ) : (
        <div className="card p-2 sm:p-3">
          {/* 표 머리 — 넓은 화면에서만. 좁아지면 컷마다 카드처럼 접힌다 */}
          <div className={`hidden xl:grid ${GRID_XL} gap-2 px-2 pb-2 mb-1`}
               style={{ borderBottom: '1px solid var(--line-strong)' }}>
            {['SHOT / TIME', 'START · END FRAME', 'CAMERA · ACTION / DIRECTION', '나레이션 · SFX', 'CLIP · 완성 영상', ''].map((h, n) => (
              <div key={n} className="label">{h}</div>
            ))}
          </div>

          {shots.map((s, i) => {
            const gs = gen?.i === i && gen.kind === 'start';
            const ge = gen?.i === i && gen.kind === 'end';

            const cell = (kind: 'start' | 'end') => {
              const url = kind === 'start' ? s.image : s.endImage;
              const working = kind === 'start' ? gs : ge;
              return (
                <div className={`flex flex-col gap-1 ${frameW}`}>
                  <div className="label text-center" style={{ fontSize: 9.5 }}>
                    {kind === 'start' ? 'START' : 'END'}
                  </div>
                  <div className="rounded border overflow-hidden w-full flex items-center justify-center"
                       style={{
                         aspectRatio: ratio,
                         borderColor: working ? 'var(--accent)' : url ? 'var(--line-strong)' : 'var(--line)',
                         borderStyle: url ? 'solid' : 'dashed',
                         background: url ? '#000' : 'var(--surface-2)',
                       }}>
                    {url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumbUrl(url, 256)} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-[10px] text-center px-1"
                            style={{ color: working ? 'var(--accent)' : 'var(--text-mute)' }}>
                        {working ? '만드는 중…' : '비어 있음'}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-1 w-full">
                    <button className="chip flex-1" style={{ padding: '1px 4px', fontSize: 10 }}
                            onClick={() => generate(i, kind)} disabled={gen !== null}>
                      {url ? '다시' : '만들기'}
                    </button>
                    <button className="chip" style={{ padding: '1px 4px', fontSize: 10 }}
                            onClick={() => { setPickFor({ i, kind }); setPage(0); }}>고르기</button>
                  </div>
                  {kind === 'start' && i > 0 && (
                    <button className="chip w-full" style={{ padding: '1px 4px', fontSize: 10, color: 'var(--accent)' }}
                            title="앞 컷의 끝 프레임을 그대로 이 컷의 시작으로 — 이음새가 사라집니다"
                            onClick={() => inheritPrevEnd(i)}>
                      ↑ 앞 컷 끝에서
                    </button>
                  )}
                </div>
              );
            };

            const tools = (
              <>
                <button className="text-[11px]" style={{ color: 'var(--text-mute)' }}
                        onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                <button className="text-[11px]" style={{ color: 'var(--text-mute)' }}
                        onClick={() => move(i, 1)} disabled={i === shots.length - 1}>↓</button>
                <button className="text-[11px]" style={{ color: 'var(--danger)' }}
                        onClick={() => removeShot(i)}>×</button>
              </>
            );

            return (
              <div key={i} className={`grid grid-cols-1 ${GRID_XL} gap-2 px-2 py-3`}
                   style={{ borderTop: i ? '1px solid var(--line)' : undefined }}>
                {/* 컷 번호·시간·길이 — 좁을 땐 한 줄로 눕고 도구가 오른쪽에 붙는다 */}
                <div className="flex xl:block items-center gap-2 flex-wrap">
                  <div className="font-extrabold text-[13px]">CUT{s.no}</div>
                  <div className="text-[10.5px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
                    {timeLabel(shots, i)}
                  </div>
                  <div className="flex items-center gap-1 xl:mt-1.5">
                    <input className="input w-[56px] text-right" type="number" min={1} max={30} step={0.5}
                           value={s.seconds} onChange={(e) => patch(i, { seconds: Number(e.target.value) || 0 })} />
                    <span className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>초</span>
                  </div>
                  <div className="flex-1 xl:hidden" />
                  <div className="flex items-center gap-2 xl:hidden">{tools}</div>
                </div>

                <div className="flex gap-2">
                  {cell('start')}
                  {cell('end')}
                </div>

                <div className="min-w-0">
                  <select className="input w-full" value={s.camera}
                          onChange={(e) => patch(i, { camera: e.target.value })}>
                    {CAMERA_MOVES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <textarea className="input w-full mt-1" rows={2} value={s.scene}
                            placeholder="장면 — 시작 프레임에 무엇이 보이나"
                            onChange={(e) => patch(i, { scene: e.target.value })} />
                  <textarea className="input w-full mt-1" rows={2} value={s.action ?? ''}
                            placeholder="동작 — 시작에서 끝으로 무엇이 바뀌나 (예: 눈을 감고 있다 → 고개 살짝 듦)"
                            onChange={(e) => patch(i, { action: e.target.value })} />
                </div>

                {/* 나레이션·SFX — 좁을 땐 나란히 두 칸, 넓을 땐 위아래 */}
                <div className="grid grid-cols-2 xl:grid-cols-1 gap-2 min-w-0">
                  <textarea className="input w-full" rows={2} value={s.narration ?? ''}
                            placeholder="나레이션·대사" onChange={(e) => patch(i, { narration: e.target.value })} />
                  <textarea className="input w-full" rows={2} value={s.sfx ?? ''}
                            placeholder="SFX" onChange={(e) => patch(i, { sfx: e.target.value })} />
                </div>

                {/* 이 컷의 완성 영상 — 제작은 대화에서 돌고, 결과 주소를 여기 달아 콘티에 붙인다 */}
                <div className={`flex flex-col gap-1 ${frameW}`}>
                  <div className="label text-center" style={{ fontSize: 9.5 }}>CLIP</div>
                  <div className="rounded border overflow-hidden w-full flex items-center justify-center"
                       style={{
                         aspectRatio: ratio,
                         borderColor: s.clip ? 'var(--ok)' : 'var(--line)',
                         borderStyle: s.clip ? 'solid' : 'dashed',
                         background: s.clip ? '#000' : 'var(--surface-2)',
                       }}>
                    {s.clip ? (
                      <video src={videoSrc(s.clip)} controls loop playsInline preload="metadata"
                             className="w-full h-full" style={{ objectFit: 'cover' }} />
                    ) : (
                      <span className="text-[9.5px] text-center px-1 leading-tight" style={{ color: 'var(--text-mute)' }}>
                        아직<br />없음
                      </span>
                    )}
                  </div>
                  <button className="chip w-full" style={{ padding: '1px 4px', fontSize: 10 }}
                          onClick={() => attachClip(i)}>
                    {s.clip ? '영상 교체' : '영상 등록'}
                  </button>
                </div>

                <div className="hidden xl:flex flex-col items-center gap-1">{tools}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* 완성본 — 컷을 다 이어붙인 최종 영상. 사람들이 콘티와 결과를 한 화면에서 본다 */}
      {shots.length > 0 && (
        <div className="card p-3 mt-3">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <div className="label">완성 영상 — 위 컷들을 이어붙인 최종본</div>
            <div className="flex-1" />
            <button className="chip" style={{ color: 'var(--accent)' }}
                    onClick={() => {
                      const v = prompt('완성 영상 주소를 붙여넣어 주세요. (비우고 확인하면 해제됩니다)', finalClip);
                      if (v !== null) setFinalClip(v.trim());
                    }}>
              {finalClip ? '완성본 교체' : '완성본 등록'}
            </button>
          </div>
          {finalClip ? (
            <div className="flex gap-3 items-start flex-wrap">
              <video src={videoSrc(finalClip)} controls loop playsInline preload="metadata"
                     className="rounded-lg" style={{ width: 260, aspectRatio: ratio, background: '#000' }} />
              <div className="flex-1 min-w-[200px]">
                <input className="input w-full" value={finalNote} placeholder="완성본 메모 (예: 20초 · 자막 B안)"
                       onChange={(e) => setFinalNote(e.target.value)} />
                <div className="text-[11px] mt-1.5 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                  컷별 클립은 각 행의 <b>CLIP</b> 칸에, 이어붙인 최종본은 여기에 답니다.
                  콘티와 결과물을 한 화면에서 같이 보여줄 수 있습니다.
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-5 text-center text-[11.5px]"
                 style={{ borderColor: 'var(--line-strong)', color: 'var(--text-mute)' }}>
              아직 완성본이 없습니다 — 컷별 클립이 다 나오면 이어붙여 여기 답니다.
            </div>
          )}
        </div>
      )}

      {shots.length > 0 && (
        <div className="card p-3 mt-3">
          <div className="label mb-1">
            제작 메모{' '}
            <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>
              — 나레이션·SFX 칸은 편집용 지시입니다. 영상 생성에는 넣지 않습니다 (엔진이 한국어 대사를 못 만듭니다).
            </span>
          </div>
          <input className="input w-full" value={note} placeholder="예: 톤 = 채도 낮은 자연 필름톤 · 엔딩 로고 리빌"
                 onChange={(e) => setNote(e.target.value)} />
        </div>
      )}

      {err && <div className="card p-3 mt-3 text-[12px]" style={{ color: 'var(--danger)' }}>{err}</div>}
      {saved && <div className="card p-3 mt-3 text-[12px]" style={{ color: 'var(--ok)' }}>{saved}</div>}

      {pickFor !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,.6)' }}
             onClick={() => setPickFor(null)}>
          <div className="card p-4 max-w-[min(1100px,94vw)] max-h-[92vh] overflow-y-auto w-full"
               onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <div className="text-[13px] font-bold">
                컷 {shots[pickFor.i]?.no} · {pickFor.kind === 'end' ? '끝' : '시작'} 프레임 고르기
              </div>
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
                        onClick={() => {
                          patch(pickFor.i, pickFor.kind === 'end'
                            ? { endImage: p.url, endImageTitle: p.title }
                            : { image: p.url, imageTitle: p.title });
                          setPickFor(null);
                        }}>
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
