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

interface RefItem { url: string; title: string; cat: 'instagram' | 'shoot' }
interface Props {
  pool: RefItem[];
  /** 배정 후보 모델 — 성인만 (아동은 SNS 랜덤 배정에서 제외) */
  models: { code: string; label: string }[];
}

interface Row {
  ref: RefItem;
  /** 배정 모델들 — 베이스에 사람이 2~3명이면 그만큼 넣는다 (왼쪽부터 순서대로 배치됨) */
  codes: string[];
  status: 'ready' | 'running' | 'done' | 'fail';
  resultUrl?: string;
  error?: string;
  /** 👍 선정 — 다시 뽑기에서 이 후보는 유지된다 */
  locked?: boolean;
}

const WON_MIN = 230, WON_MAX = 314; // 나노바나나 실측 단가 범위

export default function SnsAutomation({ pool, models }: Props) {
  const [n, setN] = useState(5);
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState('');
  /** 후보 소스 — 인스타 + 촬영 합산이 기본 (둘 다 켬) */
  const [srcOn, setSrcOn] = useState<{ instagram: boolean; shoot: boolean }>({ instagram: true, shoot: true });
  /** 확정(👍)·완료된 컷의 URL — 이후 랜덤 뽑기에서 영구 제외 (같은 컷이 또 나오지 않게) */
  const [usedUrls, setUsedUrls] = useState<Set<string>>(new Set());

  const activePool = useMemo(
    () => pool.filter((r) => srcOn[r.cat]),
    [pool, srcOn],
  );

  const randRef = (exclude: Set<string>) => {
    if (!activePool.length) return null;
    for (let i = 0; i < 80; i++) {
      const r = activePool[Math.floor(Math.random() * activePool.length)];
      if (!exclude.has(r.url)) return r;
    }
    return activePool[Math.floor(Math.random() * activePool.length)];
  };
  const randModel = () => models[Math.floor(Math.random() * models.length)].code;
  /** 서로 다른 모델 k명 추첨 — 0이면 모델 미사용(원본 그대로 채택) */
  const randModels = (k: number) => {
    if (k <= 0) return [];
    const shuffled = [...models].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(3, k)).map((m) => m.code);
  };

  /**
   * 뽑기 — 👍 선정한 후보와 이미 완성된 컷은 자리에 남고,
   * 나머지만 새로 추첨해 n 장을 채운다. ("좋은 건 남기고 나머지 다시")
   */
  function draw() {
    if (!activePool.length) return;
    setRows((cur) => {
      const keep = cur.filter((r) => r.locked || r.status === 'done').slice(0, Math.max(1, Math.min(10, n)));
      // 이번 판에 남는 컷 + 지금까지 확정·완료된 컷은 전부 제외하고 추첨
      const used = new Set([...usedUrls, ...keep.map((r) => r.ref.url)]);
      const out = [...keep];
      while (out.length < Math.max(1, Math.min(10, n))) {
        const ref = randRef(used);
        if (!ref) break;
        used.add(ref.url);
        out.push({ ref, codes: [randModel()], status: 'ready' });
      }
      return out;
    });
    setNote('');
  }

  function toggleLock(i: number) {
    setRows((cur) => {
      const row = cur[i];
      if (row) {
        // 👍 확정한 컷은 이후 랜덤 후보에서 빠진다 (해제하면 다시 풀로 돌아감)
        setUsedUrls((prev) => {
          const next = new Set(prev);
          if (row.locked) next.delete(row.ref.url); else next.add(row.ref.url);
          return next;
        });
      }
      return cur.map((r, j) => (j === i ? { ...r, locked: !r.locked } : r));
    });
  }
  function swapRef(i: number) {
    setRows((cur) => {
      const used = new Set([...usedUrls, ...cur.map((r) => r.ref.url)]);
      const ref = randRef(used);
      if (!ref) return cur;
      return cur.map((r, j) => (j === i ? { ...r, ref, status: 'ready', resultUrl: undefined, error: undefined, locked: false } : r));
    });
  }
  function swapModel(i: number) {
    setRows((cur) => cur.map((r, j) => (j === i ? { ...r, codes: randModels(r.codes.length), status: 'ready', resultUrl: undefined } : r)));
  }
  /** 카드의 인원 수 변경 — 그 수만큼 서로 다른 모델을 다시 추첨한다 */
  function setCount(i: number, k: number) {
    setRows((cur) => cur.map((r, j) => (j === i ? { ...r, codes: randModels(k), status: (r.status === 'done' ? 'done' : 'ready') as Row['status'], resultUrl: r.status === 'done' ? r.resultUrl : undefined } : r)));
  }
  function removeRow(i: number) {
    setRows((cur) => {
      const row = cur[i];
      // 완료 전의 👍 컷을 제외하면 풀로 되돌린다 (완료된 컷은 계속 제외 유지)
      if (row?.locked && row.status !== 'done') {
        setUsedUrls((prev) => { const next = new Set(prev); next.delete(row.ref.url); return next; });
      }
      return cur.filter((_, j) => j !== i);
    });
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
      // 인원 0 = 모델 미사용 — 생성·과금 없이 원본을 그대로 채택 처리한다
      if (row.codes.length === 0) {
        setRows((cur) => cur.map((r, k) => (k === i ? { ...r, status: 'done', resultUrl: r.ref.url } : r)));
        setUsedUrls((prev) => new Set(prev).add(row.ref.url));
        continue;
      }
      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            engine: 'gemini',
            sizeValue: '1080x1350',            // SNS 4:5
            mode: 'thumbnail',
            samples: 1,
            talents: row.codes.map((code) => ({ code, expression: 'soft_smile' })),
            uploadedRefs: [{ url: row.ref.url, title: row.ref.title || 'SNS 소스', role: 'base' }],
            editTargets: ['person'],
          }),
        });
        const j = await res.json();
        const r0 = j.results?.[0];
        if (j.ok && r0?.ok && r0.url) {
          setRows((cur) => cur.map((r, k) => (k === i ? { ...r, status: 'done', resultUrl: r0.url } : r)));
          setUsedUrls((prev) => new Set(prev).add(row.ref.url)); // 완성된 컷의 원본도 재추첨 제외
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
  // 과금은 모델을 배정한 컷만 — 인원 0(원본 채택)은 무과금
  const paidTodo = rows.filter((r) => r.status !== 'done' && r.codes.length > 0).length;
  const cost = useMemo(() => `약 ₩${(paidTodo * WON_MIN).toLocaleString()}~${(paidTodo * WON_MAX).toLocaleString()}`, [paidTodo]);
  const modelLabel = (code: string) => models.find((m) => m.code === code)?.label ?? code;
  const modelLabels = (codes: string[]) => codes.map(modelLabel).join(" + ");

  return (
    <div>
      {/* 아직 스케줄은 안 건다 — 확정(다음 주) 전까지는 사람이 버튼을 누르는 수동 파일럿 */}
      <div className="px-3 py-2 rounded-[10px] text-[11.5px] leading-relaxed mb-3"
           style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text-dim)' }}>
        인스타+촬영 자산 <b>{pool.length.toLocaleString()}장</b>에서 랜덤 후보를 뽑고, 전속 모델을 랜덤 배정해 SNS(4:5) 컷을 만듭니다.
        마음에 드는 후보는 <b>👍 선정</b>하면 다시 뽑아도 자리에 남고, <b>확정·완료된 컷은 이후 랜덤에서 다시 나오지 않습니다</b>.
        인원은 원본 속 사람 수에 맞춰 주세요 — 지정 인원보다 사람이 많으면 나머지는 지워지고,
        <b> 제품 단독 컷은 인원 0</b>으로 두면 생성 없이(무과금) 원본이 그대로 채택됩니다.
        자동 스케줄은 아직 미적용 — 확정되면 이 실행을 그대로 예약으로 옮깁니다.
      </div>

      <div className="flex items-center gap-2 flex-wrap mb-3">
        <span className="label">후보 소스</span>
        {([['instagram', '인스타그램'], ['shoot', '촬영']] as const).map(([k, label]) => {
          const cnt = pool.filter((r) => r.cat === k).length;
          return (
            <button key={k} className="chip"
                    onClick={() => setSrcOn((s) => ({ ...s, [k]: !s[k] }))}
                    style={srcOn[k] ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
              {label} ({cnt.toLocaleString()})
            </button>
          );
        })}
        <span className="mx-1" style={{ color: 'var(--line-strong)' }}>|</span>
        <span className="label">오늘 만들 장수</span>
        <input type="number" min={1} max={10} value={n}
               onChange={(e) => setN(Number(e.target.value) || 5)}
               className="w-[64px] px-2 py-1 text-[13px] rounded-[8px]"
               style={{ background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text)' }} />
        <button className="btn" onClick={draw} disabled={running || !activePool.length}
                title="👍 선정한 후보와 완성된 컷은 남고, 나머지만 새로 추첨합니다.">
          🎲 뽑기 (선정·완료 유지, 나머지 교체)
        </button>
        {rows.length > 0 && (
          <button className="btn btn-primary" onClick={runAll} disabled={running || !todo}
                  title="나노바나나로 순차 생성합니다. 완료된 컷은 갤러리에 자동 등록됩니다.">
            {running ? `생성 중… (${doneCount}/${rows.length})`
              : !todo ? '전부 완료됨'
              : paidTodo ? `▶ ${todo}장 실행 — 생성 ${paidTodo}장 (${cost})${todo - paidTodo ? ` + 원본채택 ${todo - paidTodo}장` : ''}`
              : `▶ 원본 채택 ${todo}장 처리 (무과금)`}
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
                     style={{
                       borderColor: r.status === 'done' ? 'var(--ok)' : r.status === 'fail' ? 'var(--danger)' : r.locked ? 'var(--accent)' : 'var(--line)',
                       borderWidth: r.locked ? 2 : 1,
                     }} />
                <span className="absolute top-1 left-1 text-[9px] px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(0,0,0,.62)', color: r.locked ? '#ffd34d' : '#fff' }}>
                  {r.status === 'done' ? (r.codes.length === 0 ? '✓ 원본 채택' : '✓ 완료') : r.status === 'running' ? '생성 중…' : r.status === 'fail' ? '실패' : r.locked ? '👍 선정' : '후보'}
                </span>
                <span className="absolute top-1 right-1 text-[8.5px] px-1 py-0.5 rounded"
                      style={{ background: 'rgba(0,0,0,.55)', color: '#9fd1ff' }}>
                  {r.ref.cat === 'shoot' ? '촬영' : '인스타'}
                </span>
                <span className="absolute bottom-1 left-1 text-[9.5px] px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(0,0,0,.62)', color: r.codes.length ? '#ffd34d' : '#b9c3cf' }}>
                  {r.codes.length ? modelLabels(r.codes) : '모델 없음 · 원본 그대로'}
                </span>
              </div>
              <div className="text-[10px] truncate mt-1" style={{ color: 'var(--text-mute)' }}>{r.ref.title || '(제목 없음)'}</div>
              {r.error && <div className="text-[9.5px] mt-0.5" style={{ color: 'var(--danger)' }}>{r.error}</div>}
              {/* 인원 — 베이스 사진 속 사람 수에 맞춘다 (1명만 보내면 나머지 사람은 지워짐, 0=원본 그대로) */}
              <div className="flex gap-1 mt-1 items-center">
                <span className="text-[9px]" style={{ color: 'var(--text-mute)' }}>인원</span>
                {[0, 1, 2, 3].map((k) => (
                  <button key={k} className="chip px-1.5 py-0"
                          title={k === 0 ? '모델 미사용 — 생성·과금 없이 원본을 그대로 채택합니다 (제품 단독 컷용)' : `모델 ${k}명 배정 (서로 다른 모델 랜덤)`}
                          disabled={running}
                          onClick={() => setCount(i, k)}
                          style={r.codes.length === k ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                    {k}
                  </button>
                ))}
              </div>
              <div className="flex gap-1 mt-1">
                <button className="chip flex-1 justify-center"
                        title={r.locked ? '선정 해제' : '👍 선정 — 다시 뽑기에서 이 후보는 유지됩니다'}
                        disabled={running} onClick={() => toggleLock(i)}
                        style={r.locked ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                  👍
                </button>
                <button className="chip flex-1 justify-center" title="다른 컷으로 교체" disabled={running || r.locked} onClick={() => swapRef(i)}>🔄</button>
                <button className="chip flex-1 justify-center" title="모델 재추첨" disabled={running} onClick={() => swapModel(i)}>🎲</button>
                <button className="chip" title="후보에서 제외" disabled={running} onClick={() => removeRow(i)}>✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
