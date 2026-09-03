'use client';

/**
 * SNS 이미지 생성 (자동화 파일럿) — 매일 5장 목표의 수동 실행 도구.
 *
 * 흐름: 인스타 자산(2천여 장)에서 랜덤 후보 N장 + 전속 모델 랜덤 배정을 먼저 보여주고,
 * 사람이 몇 초 검수(컷 교체·모델 재추첨·제외)한 뒤 실행한다.
 * "2천 장 중 뭘 고르나"를 기계 추첨 + 사람 검수 5초로 푸는 구조다.
 *
 * 스케줄(진짜 자동)은 아직 걸지 않는다 — 클라이언트 확정이 다음 주라서,
 * 확정되면 이 화면의 실행부를 그대로 크론으로 옮기면 된다.
 * 생성은 앱 엔진(나노바나나)이고 결과는 생성이미지 갤러리에 자동 등록된다.
 */

import { useMemo, useState } from 'react';

interface RefItem { url: string; title: string }
interface Props {
  pool: RefItem[];
  /** 배정 후보 모델 — 성인만 (아동은 SNS 랜덤 배정에서 제외) */
  models: { code: string; label: string }[];
}

interface Row {
  ref: RefItem;
  code: string;
  status: 'ready' | 'running' | 'done' | 'fail';
  resultUrl?: string;
  error?: string;
}

const WON_MIN = 230, WON_MAX = 314; // 나노바나나 실측 단가 범위

export default function SnsAutomation({ pool, models }: Props) {
  const [n, setN] = useState(5);
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState('');

  const randRef = (exclude: Set<string>) => {
    for (let i = 0; i < 50; i++) {
      const r = pool[Math.floor(Math.random() * pool.length)];
      if (!exclude.has(r.url)) return r;
    }
    return pool[Math.floor(Math.random() * pool.length)];
  };
  const randModel = () => models[Math.floor(Math.random() * models.length)].code;

  function draw() {
    if (!pool.length) return;
    const used = new Set<string>();
    const out: Row[] = [];
    for (let i = 0; i < Math.max(1, Math.min(10, n)); i++) {
      const ref = randRef(used);
      used.add(ref.url);
      out.push({ ref, code: randModel(), status: 'ready' });
    }
    setRows(out);
    setNote('');
  }

  function swapRef(i: number) {
    setRows((cur) => {
      const used = new Set(cur.map((r) => r.ref.url));
      const ref = randRef(used);
      return cur.map((r, j) => (j === i ? { ...r, ref, status: 'ready', resultUrl: undefined, error: undefined } : r));
    });
  }
  function swapModel(i: number) {
    setRows((cur) => cur.map((r, j) => (j === i ? { ...r, code: randModel(), status: 'ready', resultUrl: undefined } : r)));
  }
  function removeRow(i: number) {
    setRows((cur) => cur.filter((_, j) => j !== i));
  }

  async function runAll() {
    if (running || !rows.length) return;
    setRunning(true); setNote('');
    for (let i = 0; i < rows.length; i++) {
      // 이미 완료된 건 건너뛴다 — 실패분만 다시 돌릴 수 있게
      let skip = false;
      setRows((cur) => {
        if (cur[i]?.status === 'done') skip = true;
        return cur.map((r, j) => (j === i && r.status !== 'done' ? { ...r, status: 'running' } : r));
      });
      if (skip) continue;
      const row = rows[i];
      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            engine: 'gemini',
            sizeValue: '1080x1350',            // SNS 4:5
            mode: 'thumbnail',
            samples: 1,
            talents: [{ code: row.code, expression: 'soft_smile' }],
            uploadedRefs: [{ url: row.ref.url, title: row.ref.title || 'SNS 소스', role: 'base' }],
            editTargets: ['person'],
          }),
        });
        const j = await res.json();
        const r0 = j.results?.[0];
        if (j.ok && r0?.ok && r0.url) {
          setRows((cur) => cur.map((r, k) => (k === i ? { ...r, status: 'done', resultUrl: r0.url } : r)));
        } else {
          const msg = r0?.error || j.error || '실패';
          setRows((cur) => cur.map((r, k) => (k === i ? { ...r, status: 'fail', error: msg } : r)));
        }
      } catch (e) {
        setRows((cur) => cur.map((r, k) => (k === i ? { ...r, status: 'fail', error: (e as Error).message } : r)));
      }
    }
    setRunning(false);
    setNote('끝났습니다 — 완료된 컷은 생성이미지 갤러리에 자동 등록돼 있습니다.');
  }

  const doneCount = rows.filter((r) => r.status === 'done').length;
  const todo = rows.filter((r) => r.status !== 'done').length;
  const cost = useMemo(() => `약 ₩${(todo * WON_MIN).toLocaleString()}~${(todo * WON_MAX).toLocaleString()}`, [todo]);
  const modelLabel = (code: string) => models.find((m) => m.code === code)?.label ?? code;

  return (
    <div>
      {/* 아직 스케줄은 안 건다 — 확정(다음 주) 전까지는 사람이 버튼을 누르는 수동 파일럿 */}
      <div className="px-3 py-2 rounded-[10px] text-[11.5px] leading-relaxed mb-3"
           style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text-dim)' }}>
        인스타 자산 <b>{pool.length.toLocaleString()}장</b>에서 랜덤 후보를 뽑고, 전속 모델을 랜덤 배정해 SNS(4:5) 컷을 만듭니다.
        <b> 인물이 없는 원본은 어색하게 나오니</b> 후보 미리보기에서 🔄 로 걸러주세요.
        자동 스케줄은 아직 미적용 — 확정되면 이 실행을 그대로 예약으로 옮깁니다.
      </div>

      <div className="flex items-center gap-2 flex-wrap mb-3">
        <span className="label">오늘 만들 장수</span>
        <input type="number" min={1} max={10} value={n}
               onChange={(e) => setN(Number(e.target.value) || 5)}
               className="w-[64px] px-2 py-1 text-[13px] rounded-[8px]"
               style={{ background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text)' }} />
        <button className="btn" onClick={draw} disabled={running || !pool.length}>
          🎲 후보 뽑기 (컷 + 모델 랜덤)
        </button>
        {rows.length > 0 && (
          <button className="btn btn-primary" onClick={runAll} disabled={running || !todo}
                  title="나노바나나로 순차 생성합니다. 완료된 컷은 갤러리에 자동 등록됩니다.">
            {running ? `생성 중… (${doneCount}/${rows.length})` : todo ? `▶ ${todo}장 생성 실행 (${cost})` : '전부 완료됨'}
          </button>
        )}
        {note && <span className="text-[11.5px]" style={{ color: 'var(--ok)' }}>{note}</span>}
      </div>

      {!rows.length ? (
        <div className="card p-8 text-center text-[13px]" style={{ color: 'var(--text-dim)' }}>
          {pool.length
            ? '🎲 후보 뽑기를 누르면 랜덤 후보와 모델 배정이 나타납니다. 검수 후 실행하세요.'
            : '인스타그램 분류의 레퍼런스가 없습니다 — 자산관리 > 레퍼런스에서 확인하세요.'}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {rows.map((r, i) => (
            <div key={r.ref.url + i} className="card p-2">
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={r.resultUrl ?? r.ref.url} alt={r.ref.title}
                     className="w-full aspect-[4/5] object-cover rounded-lg border"
                     style={{ borderColor: r.status === 'done' ? 'var(--ok)' : r.status === 'fail' ? 'var(--danger)' : 'var(--line)' }} />
                <span className="absolute top-1 left-1 text-[9px] px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(0,0,0,.62)', color: '#fff' }}>
                  {r.status === 'done' ? '✓ 완료' : r.status === 'running' ? '생성 중…' : r.status === 'fail' ? '실패' : '후보'}
                </span>
                <span className="absolute bottom-1 left-1 text-[9.5px] px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(0,0,0,.62)', color: '#ffd34d' }}>
                  {modelLabel(r.code)}
                </span>
              </div>
              <div className="text-[10px] truncate mt-1" style={{ color: 'var(--text-mute)' }}>{r.ref.title || '(제목 없음)'}</div>
              {r.error && <div className="text-[9.5px] mt-0.5" style={{ color: 'var(--danger)' }}>{r.error}</div>}
              <div className="flex gap-1 mt-1">
                <button className="chip flex-1 justify-center" title="다른 컷으로 교체" disabled={running} onClick={() => swapRef(i)}>🔄 컷</button>
                <button className="chip flex-1 justify-center" title="모델 재추첨" disabled={running} onClick={() => swapModel(i)}>🎲 모델</button>
                <button className="chip" title="후보에서 제외" disabled={running} onClick={() => removeRow(i)}>✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
