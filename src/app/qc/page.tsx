import SeriesStrips from '@/components/SeriesStrips';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import PageHeader from '@/components/PageHeader';
import { LOCAL_ONLY } from '@/lib/local-only';
import { getQcOverview, type QcBucket, type QcKind } from '@/lib/qc-stats';

export const dynamic = 'force-dynamic';

/**
 * 생성 품질 — 자동 검사 결과를 모아 보는 화면 (점검 2026-10-02 1번).
 *
 * 컷마다 남는 얼굴 대조·제품 일치·크기·조명·말림·태그 검사와 숨김 사유를 주간·제품·모델·엔진별로 센다.
 * "지금 가장 많이 틀리는 것" 이 보여야 프롬프트·참조를 어디부터 고칠지 정할 수 있다 — 감이 아니라 숫자로.
 *
 * 로컬 전용 (사용자 결정 2026-10-02: "사용하는 애들까지 볼 필요는 없다 — 로컬에서 내가 켜면 그때 보인다").
 * 배포(서버)에서는 메뉴에서 빠지고 이 주소도 404 다 — src/lib/local-only.ts.
 */

const KIND_KR: Record<QcKind, string> = {
  face: '얼굴 변형', product: '제품 불일치', scale: '크기 어긋남', light: '합성 티(조명)', colour: '색 계열 벗어남', fold: '윗부분 말림', tag: '태그 뭉개짐', unchecked: '검사 안 됨',
};
const KINDS: QcKind[] = ['face', 'product', 'scale', 'light', 'colour', 'fold', 'tag'];

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '–');
const tone = (ratio: number) => (ratio >= 0.4 ? 'var(--danger)' : ratio >= 0.2 ? 'var(--warn)' : 'var(--ok)');

function Stat({ value, label, sub, color }: { value: string; label: string; sub?: string; color?: string }) {
  return (
    <div className="card p-4">
      <div className="text-[26px] font-extrabold leading-none" style={{ color: color ?? 'var(--text)' }}>{value}</div>
      <div className="text-[12.5px] mt-1.5 font-semibold" style={{ color: 'var(--text-dim)' }}>{label}</div>
      {sub && <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-mute)' }}>{sub}</div>}
    </div>
  );
}

/** 버킷 표 — 주간·제품·모델·엔진이 같은 열을 쓴다 */
function BucketTable({ title, rows, label, hint }: { title: string; rows: QcBucket[]; label: (k: string) => string; hint?: string }) {
  if (!rows.length) return null;
  return (
    <section className="card p-4 min-w-0">
      <div className="flex items-baseline gap-2 mb-2 flex-wrap">
        <h2 className="text-[13.5px] font-bold">{title}</h2>
        {hint && <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>{hint}</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="text-[11.5px] w-full" style={{ borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr style={{ color: 'var(--text-mute)' }}>
              <th className="text-left font-semibold py-1 pr-3">구분</th>
              <th className="text-right font-semibold py-1 px-2">컷</th>
              <th className="text-right font-semibold py-1 px-2" title="경고가 하나라도 있는 컷 / 검사가 돈 컷">경고</th>
              {KINDS.map((k) => <th key={k} className="text-right font-semibold py-1 px-2">{KIND_KR[k]}</th>)}
              <th className="text-right font-semibold py-1 px-2" title="얼굴 판정이 가능했던 컷 중 변형·애매">얼굴 어긋남</th>
              <th className="text-right font-semibold py-1 px-2" title="스튜디오 컷(배경·편집 원본 없음)만 — 씬 컷은 방 조명으로 색이 바뀌는 게 정답이라 뺀다">ΔE 중앙</th>
              <th className="text-right font-semibold py-1 px-2">숨김</th>
              <th className="text-right font-semibold py-1 pl-2">재생성</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.key} style={{ borderTop: '1px solid var(--line)' }}>
                <td className="py-1.5 pr-3 font-semibold whitespace-nowrap">{label(b.key)}</td>
                <td className="text-right py-1.5 px-2">{b.cuts}</td>
                <td className="text-right py-1.5 px-2 font-semibold" style={{ color: b.checked ? tone(b.flagged / b.checked) : 'var(--text-mute)' }}>
                  {b.checked ? `${b.flagged} (${pct(b.flagged, b.checked)})` : '–'}
                </td>
                {KINDS.map((k) => (
                  <td key={k} className="text-right py-1.5 px-2" style={{ color: b.by[k] ? 'var(--text)' : 'var(--text-mute)' }}>{b.by[k] ?? '·'}</td>
                ))}
                <td className="text-right py-1.5 px-2" style={{ color: b.faceJudged ? tone(b.faceOff / b.faceJudged) : 'var(--text-mute)' }}>
                  {b.faceJudged ? `${b.faceOff}/${b.faceJudged}` : '–'}
                </td>
                <td className="text-right py-1.5 px-2" style={{ color: b.deltaE == null ? 'var(--text-mute)' : b.deltaE < 5 ? 'var(--ok)' : b.deltaE < 15 ? 'var(--warn)' : 'var(--danger)' }}>
                  {b.deltaE == null ? '–' : `${b.deltaE} (${b.deltaEN})`}
                </td>
                <td className="text-right py-1.5 px-2" title={Object.entries(b.hideReasons).map(([r, n]) => `${r} ${n}`).join(' · ')}>{b.hidden || '·'}</td>
                <td className="text-right py-1.5 pl-2">{b.retries || '·'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function QcPage() {
  if (!LOCAL_ONLY) notFound();
  const o = await getQcOverview(56);
  const t = o.total;
  const flagRate = t.checked ? t.flagged / t.checked : 0;
  const faceRate = t.faceJudged ? t.faceOff / t.faceJudged : 0;
  // 가장 많은 원인 — 머리말 한 줄
  const top = KINDS.map((k) => ({ k, n: t.by[k] ?? 0 })).sort((a, b) => b.n - a.n)[0];
  const hideTop = Object.entries(t.hideReasons).sort((a, b) => b[1] - a[1]);

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title="생성 품질"
        desc="최근 8주 동안 이 앱이 생성한 컷의 자동 검사 결과와 숨김 사유를 모았습니다. 세는 기준은 갤러리의 경고 칩과 같습니다."
        right={<Link href="/cuts?source=imgcreate" className="chip">생성이미지 갤러리 →</Link>}
      />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <Stat value={String(t.cuts)} label="생성 컷 (8주)" sub={`검사 기록 ${t.checked}컷 · 숨김 ${t.hidden}컷`} />
        <Stat value={pct(t.flagged, t.checked)} label="경고 컷 비율" sub={`${t.flagged} / ${t.checked}컷에 경고 1개 이상`} color={tone(flagRate)} />
        <Stat value={t.faceJudged ? pct(t.faceOff, t.faceJudged) : '–'} label="얼굴 어긋남" sub={`판정된 얼굴 ${t.faceJudged}건 중 ${t.faceOff}건 (인물 단위)`} color={tone(faceRate)} />
        <Stat value={t.deltaE == null ? '–' : String(t.deltaE)} label="스튜디오 컷 ΔE 중앙값" sub={`${t.deltaEN}컷 · 5 미만이면 정확`} color={t.deltaE == null ? undefined : t.deltaE < 5 ? 'var(--ok)' : t.deltaE < 15 ? 'var(--warn)' : 'var(--danger)'} />
        <Stat value={top && top.n ? KIND_KR[top.k] : '없음'} label="가장 많은 원인" sub={top && top.n ? `${top.n}컷` : '경고 없음'} />
      </div>

      {hideTop.length > 0 && (
        <div className="card p-3 mb-4 text-[12px] flex gap-3 flex-wrap items-center">
          <span className="font-semibold">숨김 사유</span>
          {hideTop.map(([r, n]) => <span key={r} className="chip">{r} <b>{n}</b></span>)}
          <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>갤러리에서 숨길 때 고른 사유 — 「사유 없음」이 많으면 지표가 안 쌓입니다.</span>
        </div>
      )}

      <div className="grid gap-4 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(520px, 1fr))' }}>
        <BucketTable title="주간 추이" rows={o.weeks} label={(k) => k} hint="ISO 주 — 프롬프트를 고친 주에 수치가 움직이는지 본다" />
        <BucketTable title="엔진별" rows={o.byEngine} label={(k) => ({ gemini: '제미나이', higgs: '힉스필드', gpt: 'GPT' }[k] ?? k)} />
        <BucketTable
          title="프롬프트 경로별"
          rows={o.byPath}
          label={(k) => ({ app: '앱 템플릿', opus: 'Opus', 'talk-template': '대화 · 앱 템플릿 위에', 'talk-free': '대화 · 처음부터' }[k] ?? k)}
          hint="대화에서 처음부터 쓴 컷은 검사를 안 탄다 — 숨김 비율로만 비교된다. 넘기기 기록으로 등록하면 「앱 템플릿 위에」 로 잡히고 검사도 탄다"
        />
        <BucketTable title="제품별" rows={o.byLine} label={(k) => k} hint="어느 제품이 형태·크기에서 자주 틀리는지" />
        <BucketTable title="전속 모델별" rows={o.byTalent} label={(k) => k} hint="얼굴 어긋남이 특정 모델에 몰리면 그 시트를 먼저 본다" />
      </div>

      <section className="card p-4 mb-4">
        <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-[13.5px] font-bold">시리즈 일관성 <span className="font-normal" style={{ color: 'var(--text-mute)' }}>같은 모델의 최근 컷 얼굴</span></h2>
          <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>상품 페이지에 나란히 걸렸을 때 한 사람으로 보이는지 — 숨긴 컷 제외, 모델당 최근 8컷</span>
        </div>
        <SeriesStrips rows={o.series} />
      </section>

      <section className="card p-4">
        <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-[13.5px] font-bold">최근 경고 컷 <span className="font-normal" style={{ color: 'var(--text-mute)' }}>{o.recentFlagged.length}</span></h2>
          <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>숨기지 않은 것만 · 누르면 원본</span>
        </div>
        {o.recentFlagged.length === 0 ? (
          <div className="text-[12px]" style={{ color: 'var(--text-mute)' }}>최근 8주 동안 경고가 붙은 컷이 없습니다.</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8 gap-2.5">
            {o.recentFlagged.map((c) => (
              <div key={c.id} className="min-w-0">
                <a href={c.url} target="_blank" rel="noreferrer noopener">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={c.url} alt={c.line} loading="lazy" className="w-full aspect-square object-cover rounded-lg border" style={{ borderColor: 'var(--line)' }} />
                </a>
                <div className="mt-1 text-[10.5px] truncate" style={{ color: 'var(--text-dim)' }}>
                  {c.line} · {c.colorName}{c.talents.length ? ` · ${c.talents.join(' ')}` : ''}
                  {c.retryOf && <span className="ml-1" style={{ color: 'var(--info)' }}>⟳ 재생성</span>}
                </div>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {c.flags.slice(0, 3).map((f, i) => (
                    <span key={i} title={f.note} className="text-[9.5px] px-1 rounded" style={{ color: 'var(--danger)', background: 'var(--surface-2)' }}>⚠ {f.label}</span>
                  ))}
                </div>
                <div className="text-[9.5px] mt-0.5" style={{ color: 'var(--text-mute)' }}>{c.createdAt.slice(0, 10)}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
