'use client';

import { useState } from 'react';
import NewTag from './NewTag';

interface Verdict { code: string; verdict: string; score: number }
export interface FaceFixResult {
  ok: boolean; id?: string; url?: string; error?: string;
  before?: Verdict[];
  qc?: { face?: { verdicts: Verdict[] } };
}

const KR: Record<string, string> = { W: '여성', M: '남성', K: '아동' };
const label = (code: string) => `${KR[code[0]] ?? ''} ${code.slice(2)}`.trim();
const VERDICT_KR: Record<string, string> = { ok: '일치', weak: '애매', drift: '변형', tooSmall: '판정 불가', noFace: '얼굴 안 보임' };

/** 고치기 전 → 후 자동 얼굴 대조 한 줄씩 — 참고용이고, 최종 판단은 눈으로 */
export function faceFixSummary(res: FaceFixResult): string[] {
  const after = res.qc?.face?.verdicts ?? [];
  return (res.before ?? []).map((b) => {
    const a = after.find((x) => x.code === b.code);
    return `${label(b.code)} ${VERDICT_KR[b.verdict] ?? b.verdict} ${b.score} → ${a ? `${VERDICT_KR[a.verdict] ?? a.verdict} ${a.score}` : '?'}`;
  });
}

/**
 * 「얼굴 다시 그리기」 — 전속 모델 얼굴만 등록 얼굴로 다시 그린 새 컷을 만든다 (/api/face-fix, 2026-10-21).
 * 원본은 그대로 남는다. 모델 한 명당 나노바나나 1회가 들어서 누르기 전에 한 번 묻는다(금액은 화면에 안 쓴다 — 장수만).
 *
 * variant='dark' — 대시보드 크게 보기처럼 어두운 팝업 안의 버튼 모양.
 * onDone 을 주면 결과를 부모에게 넘기고(부모가 그림을 바꿔 보여 준다) 여기서는 오류만 그린다.
 */
export default function FaceFixButton({
  cutId, codes, compact = false, variant = 'card', onDone,
}: {
  cutId: string; codes: string[]; compact?: boolean; variant?: 'card' | 'dark'; onDone?: (r: FaceFixResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<FaceFixResult | null>(null);
  const names = [...new Set(codes)].map(label).join('·');
  const dark = variant === 'dark';

  async function run() {
    if (busy || !codes.length) return;
    const ok = window.confirm(
      `얼굴 다시 그리기 — ${names} ${codes.length}명의 얼굴만 등록된 얼굴로 다시 그려 새 컷으로 저장합니다.\n` +
      `원본 컷은 그대로 남습니다. 나노바나나 ${codes.length}회를 씁니다. 진행할까요?`,
    );
    if (!ok) return;
    setBusy(true);
    setRes(null);
    try {
      const r = await fetch('/api/face-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cutId, codes }),
      });
      const json = (await r.json()) as FaceFixResult;
      setRes(json);
      if (json.ok) onDone?.(json);
    } catch (e) {
      setRes({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const title = '다 만든 컷에서 전속 모델 얼굴만 잘라 등록된 얼굴(대표컷·얼굴 각도)로 다시 그린 뒤 제자리에 붙입니다. 표정·머리 크기·머리 모양과 얼굴 밖(옆 사람·제품·배경)은 원본 그대로이고, 결과는 새 컷으로 저장됩니다. 머리색·머리 모양까지 달라진 컷은 다시 생성하세요.';
  const text = busy ? '얼굴 다시 그리는 중… (얼굴당 30초 안팎)' : '얼굴 다시 그리기';
  return (
    <div className={dark ? '' : compact ? 'mt-1' : 'mt-1.5'}>
      {dark ? (
        <button
          type="button" onClick={run} disabled={busy} title={title}
          className="px-3 py-1.5 rounded-lg text-[12px] font-medium inline-flex items-center gap-1.5"
          style={{ background: 'rgba(255,255,255,.12)', color: '#c8ccd4', border: 'none', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1 }}
        >
          {text} <NewTag feature="faceFix" />
        </button>
      ) : (
        <button
          type="button" onClick={run} disabled={busy} title={title}
          className="chip inline-flex items-center gap-1"
          style={{ fontSize: compact ? 10 : 11 }}
        >
          {text} <NewTag feature="faceFix" />
        </button>
      )}
      {res && !res.ok && (
        <div className="text-[10.5px] mt-1" style={{ color: dark ? '#ff8080' : 'var(--danger)' }}>{res.error}</div>
      )}
      {!onDone && res?.ok && res.url && (
        <div className="mt-1.5">
          <a href={res.url} target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={res.url} alt="얼굴 다시 그린 컷" className="w-full rounded-lg border" style={{ borderColor: 'var(--accent-dim)' }} />
          </a>
          <div className="text-[10px] mt-1 flex gap-2 flex-wrap" style={{ color: 'var(--text-mute)' }}>
            <span style={{ color: 'var(--ok)' }}>새 컷으로 저장됨 — 생성이미지 갤러리에도 있습니다</span>
            {faceFixSummary(res).map((s) => (
              <span key={s} title="자동 얼굴 대조 결과 — 참고용이고, 최종 판단은 눈으로">{s}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
