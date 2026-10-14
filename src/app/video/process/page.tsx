import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import raw from './data.json';

export const dynamic = 'force-dynamic';

/**
 * 영상 제작 과정 — 최종본 폴더의 영상을 어떻게 만들었고 힉스필드 크레딧을 얼마나 썼는지.
 *
 * 2026-10-14 사용자 요청: "각각 힉스필드 크레딧 사용 관련해서 적어주고 진행 과정 정리 ·
 * 이후 작업은 이걸 기반으로 영상 작업을 진행하려고". 다음 영상의 계획·견적을 잡을 때 기준으로 쓰고,
 * 제작 방식을 다른 사람에게 설명할 때 보여 주는 기록이다.
 *
 * 내용은 data.json 에 있다 — 작품이 하나 끝나면 works 에 같은 모양으로 한 항목을 더하고,
 * 장면 그림은 public/video-process/ 에 넣는다. 숫자는 작업 기록과 영상 제작물 카드에 남은 값만 쓰고,
 * 기록이 없으면 null(화면에는 「확인 못 함」)로 둔다 — 추정으로 메우지 않는다.
 */

type Kept = boolean | 'partial' | null;
interface Frame { file: string; caption: string; width: number; height: number }
interface CreditItem {
  what: string; count: number | null; creditsEach: number | null; credits: number | null; kept: Kept; note: string | null;
}
interface Work {
  slug: string; short: string; title: string; kind: string;
  aspect: string; seconds: number; resolution: string; finalDate: string;
  frames: Frame[];
  reference: { name: string; what: string };
  productRefs: { what: string; how: string }[];
  numbers: { label: string; value: number | string; unit: string | null }[];
  steps: { date: string; what: string; why: string }[];
  versions: { name: string; date: string; change: string }[];
  credits: {
    total: number | null; basis: string; items: CreditItem[];
    wastedTotal: number | null; wastedReasons: { credits: number | null; reason: string }[]; budgetNote: string;
  };
  otherCosts: { what: string; amount: number | null; unit: string | null; detail: string | null }[];
  lessons: string[];
}
interface ProcessData {
  generatedAt: string;
  summary: { slug: string; anchor: string; name: string; total: number | null; wasted: number | null; knownSubtotal: number | null }[];
  unitCosts: { note: string; items: { what: string; credits: number }[] };
  maxGroup: { knownSubtotal: number; basis: string };
  works: Work[];
  usage: { days: { date: string; works: string[]; responses: number; usd: number }[]; notes: string[] };
  limits: string[];
}

const data = raw as unknown as ProcessData;

/** 모든 작품이 같은 순서로 갔다 — 사람이 레퍼런스와 방향을 정하고 단계마다 확인한 뒤 다음으로 */
const FLOW = [
  { t: '레퍼런스 영상을 정한다', d: '컷 수, 장면이 바뀌는 시각, 소리 구성을 재서 뼈대로 삼습니다.' },
  { t: '우리 제품 레퍼런스를 모은다', d: '실촬영 사진, 스튜디오 누끼 원본, 전속 모델 시트를 장면별로 고릅니다.' },
  { t: '레퍼런스에 맞춰 구도와 제품을 배치한다', d: '제품이 나오는 장면은 실촬영 사진을 바탕으로 쓰고 사람만 바꾸는 방식이 제품 형태를 가장 잘 지켰습니다.' },
  { t: '생성한다', d: '첫 화면 그림을 먼저 뽑아 확인하고, 그다음 영상으로 넘어갑니다. 글자·로고·카드 화면은 AI 가 아니라 코드로 그립니다.' },
  { t: '고치고 확정한다', d: '지적받은 장면만 다시 만들어 버전을 올리고, 확정되면 최종본 폴더에 넣습니다.' },
];

const KEPT: Record<string, { label: string; color: string }> = {
  true: { label: '쓰임', color: 'var(--ok)' },
  false: { label: '안 쓰임', color: 'var(--danger)' },
  partial: { label: '일부', color: 'var(--warn)' },
};

/** 2026-10-01 → 10/1 */
const md = (s: string) => (s.length >= 10 ? `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}` : s);
const num = (v: number) => v.toLocaleString('ko-KR', { maximumFractionDigits: 2 });

const Unknown = ({ children = '확인 못 함' }: { children?: React.ReactNode }) => (
  <span style={{ color: 'var(--warn)' }}>{children}</span>
);

const Sub = ({ children }: { children: React.ReactNode }) => (
  <h3 className="label mb-2">{children}</h3>
);

function WorkSection({ w }: { w: Work }) {
  const c = w.credits;
  const isMax = w.slug === 'max1' || w.slug === 'max2';
  const vertical = w.frames.length > 0 && w.frames[0].height > w.frames[0].width;

  return (
    <section id={w.slug} className="mb-10 scroll-mt-16">
      <div className="flex items-baseline gap-2 flex-wrap mb-1">
        <h2 className="h-section">{w.title}</h2>
        <span className="chip">{w.kind}</span>
      </div>
      <div className="text-[11.5px] font-mono mb-3" style={{ color: 'var(--text-mute)' }}>
        {w.aspect} · {num(w.seconds)}초 · {w.resolution} · 확정 {md(w.finalDate)}
      </div>

      {/* 최종본의 장면 여섯 — 넓은 화면에서 가로 영상은 3칸 두 줄, 세로 영상은 6칸 한 줄로 떨어지게 */}
      <div className="grid gap-2.5 mb-4"
           style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${vertical ? 140 : 280}px, 1fr))` }}>
        {w.frames.map((f) => (
          <figure key={f.file} className="min-w-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/video-process/${f.file}`} width={f.width} height={f.height} loading="lazy" alt={f.caption}
                 className="block w-full h-auto" style={{ borderRadius: 6, border: '1px solid var(--line)' }} />
            <figcaption className="text-[11px] leading-snug mt-1.5" style={{ color: 'var(--text-mute)' }}>{f.caption}</figcaption>
          </figure>
        ))}
      </div>

      <div className="grid gap-3 mb-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <div className="card p-3.5">
          <Sub>기준으로 삼은 것</Sub>
          <div className="text-[12.5px] font-bold mb-1">{w.reference.name}</div>
          <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{w.reference.what}</div>
        </div>
        <div className="card p-3.5">
          <Sub>모은 제품 레퍼런스</Sub>
          {w.productRefs.map((p, i) => (
            <div key={p.what} className="py-1.5" style={{ borderTop: i ? '1px solid var(--line)' : undefined }}>
              <div className="text-[12px] font-semibold">{p.what}</div>
              <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>{p.how}</div>
            </div>
          ))}
        </div>
      </div>

      {w.numbers.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {w.numbers.map((n) => (
            <span key={n.label} className="chip">
              {n.label} <b style={{ color: 'var(--text)' }}>{typeof n.value === 'number' ? num(n.value) : n.value}</b>{n.unit ?? ''}
            </span>
          ))}
        </div>
      )}

      <div className="card p-3.5 mb-3">
        <Sub>진행 과정</Sub>
        {w.steps.map((s, i) => (
          <div key={i} className="py-2 flex gap-3" style={{ borderTop: i ? '1px solid var(--line)' : undefined }}>
            <span className="shrink-0 w-9 text-[11.5px] font-mono pt-px" style={{ color: 'var(--accent)' }}>{md(s.date)}</span>
            <div className="min-w-0">
              <div className="text-[12.5px] leading-relaxed">{s.what}</div>
              {s.why && <div className="text-[11.5px] leading-relaxed mt-0.5" style={{ color: 'var(--text-mute)' }}>{s.why}</div>}
            </div>
          </div>
        ))}
      </div>

      <div className="card overflow-x-auto mb-3">
        <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse', minWidth: 420 }}>
          <thead>
            <tr style={{ background: 'var(--surface-2)' }}>
              <th className="label text-left px-3 py-2">버전</th>
              <th className="label text-left px-3 py-2">날짜</th>
              <th className="label text-left px-3 py-2">바뀐 것</th>
            </tr>
          </thead>
          <tbody>
            {w.versions.map((v) => (
              <tr key={v.name} style={{ borderTop: '1px solid var(--line)' }}>
                <td className="px-3 py-2 font-bold whitespace-nowrap align-top">{v.name}</td>
                <td className="px-3 py-2 font-mono whitespace-nowrap align-top" style={{ color: 'var(--text-mute)' }}>{md(v.date)}</td>
                <td className="px-3 py-2 leading-relaxed" style={{ color: 'var(--text-dim)' }}>{v.change}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card p-3.5 mb-3">
        <Sub>힉스필드 크레딧</Sub>
        {c.total !== null ? (
          <div className="text-[13px] mb-1">
            합계 <b>{num(c.total)}</b>
            {c.total > 0 && <> · 그중 최종본에 안 쓰인 것 <b style={{ color: 'var(--danger)' }}>{num(c.wastedTotal ?? 0)}</b></>}
          </div>
        ) : (
          <div className="text-[13px] mb-1">
            <Unknown>합계 확인 못 함</Unknown>
            {isMax && <> — 맥스 ①·②를 합쳐 기록으로 확인된 부분은 <b>{num(data.maxGroup.knownSubtotal)}</b></>}
          </div>
        )}
        {isMax && c.total === null && (
          <div className="text-[11.5px] leading-relaxed mb-1" style={{ color: 'var(--text-mute)' }}>{data.maxGroup.basis}</div>
        )}
        <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>{c.basis}</div>

        {c.items.length > 0 && (
          <details className="mt-2.5">
            <summary className="text-[12px] font-semibold" style={{ color: 'var(--accent)' }}>내역 {c.items.length}건 보기</summary>
            <div className="overflow-x-auto mt-2" style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius)' }}>
              <table className="w-full text-[11.5px]" style={{ borderCollapse: 'collapse', minWidth: 560 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2)' }}>
                    <th className="label text-left px-3 py-2">내역</th>
                    <th className="label text-right px-3 py-2">수량</th>
                    <th className="label text-right px-3 py-2">단가</th>
                    <th className="label text-right px-3 py-2">크레딧</th>
                    <th className="label text-left px-3 py-2">최종본</th>
                  </tr>
                </thead>
                <tbody>
                  {c.items.map((it, i) => {
                    const k = KEPT[String(it.kept)];
                    return (
                      <tr key={i} style={{ borderTop: '1px solid var(--line)' }}>
                        <td className="px-3 py-2 leading-relaxed">
                          {it.what}
                          {it.note && <div style={{ color: 'var(--text-mute)' }}>{it.note}</div>}
                        </td>
                        <td className="px-3 py-2 text-right font-mono align-top">{it.count !== null ? num(it.count) : '—'}</td>
                        <td className="px-3 py-2 text-right font-mono align-top">{it.creditsEach !== null ? num(it.creditsEach) : '—'}</td>
                        <td className="px-3 py-2 text-right font-mono align-top">{it.credits !== null ? num(it.credits) : <Unknown>?</Unknown>}</td>
                        <td className="px-3 py-2 whitespace-nowrap align-top" style={{ color: k?.color ?? 'var(--text-mute)' }}>{k?.label ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        )}

        {c.wastedReasons.length > 0 && (
          <div className="mt-3">
            <div className="text-[11.5px] font-semibold mb-1" style={{ color: 'var(--text-dim)' }}>안 쓰인 이유</div>
            {c.wastedReasons.map((r, i) => (
              <div key={i} className="text-[11.5px] leading-relaxed flex gap-2" style={{ color: 'var(--text-dim)' }}>
                <span className="shrink-0 w-9 text-right font-mono" style={{ color: 'var(--danger)' }}>{r.credits !== null ? num(r.credits) : '?'}</span>
                <span>{r.reason}</span>
              </div>
            ))}
          </div>
        )}
        {c.budgetNote && (
          <div className="text-[11.5px] leading-relaxed mt-3" style={{ color: 'var(--text-mute)' }}>{c.budgetNote}</div>
        )}
      </div>

      {w.otherCosts.length > 0 && (
        <div className="card p-3.5 mb-3">
          <Sub>그 밖의 비용</Sub>
          {w.otherCosts.map((o, i) => (
            <div key={o.what} className="py-1.5" style={{ borderTop: i ? '1px solid var(--line)' : undefined }}>
              <div className="text-[12px] font-semibold">
                {o.what} — {o.amount !== null ? `${num(o.amount)}${o.unit ?? ''}` : <Unknown>금액 기록 없음</Unknown>}
              </div>
              {o.detail && <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>{o.detail}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="card p-3.5" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-dim)' }}>
        <Sub>이 작품에서 배운 것</Sub>
        {w.lessons.map((l, i) => (
          <div key={i} className="text-[12px] leading-relaxed flex gap-2 py-0.5">
            <span className="shrink-0" style={{ color: 'var(--accent)' }}>·</span>
            <span>{l}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function VideoProcessPage() {
  const known = data.summary.filter((x) => x.total);
  const knownSum = known.reduce((a, x) => a + (x.total ?? 0), 0);
  const maxTotal = Math.max(...data.summary.map((x) => x.total ?? x.knownSubtotal ?? 0));
  // 안 쓰인 크레딧이 컸던 경우 — 작품을 가리지 않고 큰 것부터
  const bigWaste = data.works
    .flatMap((w) => w.credits.wastedReasons.filter((r) => r.credits).map((r) => ({ credits: r.credits as number, work: w.short, reason: r.reason })))
    .sort((a, b) => b.credits - a.credits)
    .slice(0, 6);

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1100px]">
      <PageHeader
        title="영상 제작 과정"
        desc={`최종본 폴더의 영상 ${data.works.length}편을 어떻게 만들었고 힉스필드 크레딧을 얼마나 썼는지 — 다음 영상의 계획과 견적을 잡을 때 기준으로 씁니다.`}
      />

      <div className="card p-4 mb-5" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-dim)' }}>
        <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          숫자는 <b>작업 기록과 영상 제작물 카드에 적혀 있던 값</b>만 썼습니다. 힉스필드 계정을 직접 조회한 값이 아니며,
          기록이 없는 항목은 추정하지 않고 <Unknown>확인 못 함</Unknown>으로 두었습니다. 완성된 영상은{' '}
          <Link href="/video/gallery/final" className="underline" style={{ color: 'var(--accent)' }}>영상 제작물 &gt; 최종본</Link>
          에서 봅니다. ({md(data.generatedAt)} 기준)
        </div>
      </div>

      {/* 작품 바로가기 */}
      <nav aria-label="작품 바로가기" className="flex flex-wrap gap-1.5 mb-7">
        {data.works.map((w) => <a key={w.slug} href={`#${w.slug}`} className="chip">{w.short}</a>)}
        <a href="#usage" className="chip">Claude 사용량</a>
        <a href="#limits" className="chip">자료의 한계</a>
      </nav>

      <h2 className="h-section mb-3">작업 방식</h2>
      <div className="flex flex-col gap-2 mb-7">
        {FLOW.map((s, i) => (
          <div key={s.t} className="card p-3.5 flex gap-3">
            <div className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-extrabold"
                 style={{ background: 'var(--accent)', color: '#fff' }}>{i + 1}</div>
            <div className="min-w-0">
              <div className="text-[12.5px] font-bold">{s.t}</div>
              <div className="text-[11.5px] mt-0.5 leading-relaxed" style={{ color: 'var(--text-dim)' }}>{s.d}</div>
            </div>
          </div>
        ))}
      </div>

      <h2 className="h-section mb-2">힉스필드 크레딧 한눈에 보기</h2>
      <div className="text-[12px] leading-relaxed mb-2" style={{ color: 'var(--text-dim)' }}>
        합계가 확인된 {known.length}편의 크레딧은 모두 <b style={{ color: 'var(--text)' }}>{num(knownSum)}</b>입니다.
        코드로만 만든 영상은 0 이고, 맥스 두 편과 가로 피라미드는 생성 기록이 대부분 남아 있지 않아 합계를 낼 수 없었습니다.
      </div>
      <div className="flex gap-4 flex-wrap text-[11.5px] mb-2" style={{ color: 'var(--text-mute)' }}>
        <span><i className="inline-block w-2.5 h-2.5 mr-1.5 align-baseline" style={{ background: 'var(--ok)', borderRadius: 2 }} />최종본에 쓰인 크레딧</span>
        <span><i className="inline-block w-2.5 h-2.5 mr-1.5 align-baseline" style={{ background: 'var(--danger)', borderRadius: 2 }} />최종본에 안 쓰인 크레딧</span>
      </div>
      <div className="card overflow-x-auto mb-5">
        <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse', minWidth: 560 }}>
          <thead>
            <tr style={{ background: 'var(--surface-2)' }}>
              <th className="label text-left px-3 py-2">작품</th>
              <th className="label text-right px-3 py-2">합계</th>
              <th className="label text-right px-3 py-2">안 쓰인 것</th>
              <th className="label text-left px-3 py-2">비율 (가장 큰 작품 기준)</th>
            </tr>
          </thead>
          <tbody>
            {data.summary.map((x) => {
              const wasted = x.wasted ?? 0;
              return (
                <tr key={x.slug} style={{ borderTop: '1px solid var(--line)' }}>
                  <td className="px-3 py-2.5"><a href={`#${x.anchor}`} className="hover:underline">{x.name}</a></td>
                  <td className={`px-3 py-2.5 text-right ${x.total !== null ? 'font-mono' : ''}`}>{x.total !== null ? num(x.total) : <Unknown />}</td>
                  <td className={`px-3 py-2.5 text-right ${x.total !== null ? 'font-mono' : ''}`}>{x.total !== null ? num(wasted) : <Unknown />}</td>
                  <td className="px-3 py-2.5" style={{ minWidth: 160 }}>
                    {x.total !== null ? (
                      <div className="flex h-2.5 overflow-hidden" style={{ background: 'var(--surface-3)', borderRadius: 5 }}
                           role="img" aria-label={`쓰인 것 ${x.total - wasted}, 안 쓰인 것 ${wasted}`}>
                        <i className="block h-full" style={{ width: `${((x.total - wasted) / maxTotal) * 100}%`, background: 'var(--ok)' }} />
                        <i className="block h-full" style={{ width: `${(wasted / maxTotal) * 100}%`, background: 'var(--danger)' }} />
                      </div>
                    ) : (
                      <span className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
                        {x.knownSubtotal ? `기록으로 확인된 부분만 ${num(x.knownSubtotal)}` : '크레딧 기록 없음'}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 mb-10" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <div className="card p-3.5">
          <Sub>안 쓰인 크레딧이 컸던 경우</Sub>
          {bigWaste.map((r, i) => (
            <div key={i} className="py-1.5 flex gap-2.5" style={{ borderTop: i ? '1px solid var(--line)' : undefined }}>
              <span className="shrink-0 w-9 text-right text-[12px] font-mono font-bold" style={{ color: 'var(--danger)' }}>{num(r.credits)}</span>
              <div className="min-w-0 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                <b style={{ color: 'var(--text)' }}>{r.work}</b> — {r.reason}
              </div>
            </div>
          ))}
        </div>
        <div className="card p-3.5">
          <Sub>기록에 남은 단가</Sub>
          <div className="text-[11.5px] leading-relaxed mb-1.5" style={{ color: 'var(--text-mute)' }}>{data.unitCosts.note}</div>
          {data.unitCosts.items.map((it, i) => (
            <div key={it.what} className="py-1.5 flex justify-between gap-3 text-[12px]" style={{ borderTop: i ? '1px solid var(--line)' : undefined }}>
              <span style={{ color: 'var(--text-dim)' }}>{it.what}</span>
              <span className="shrink-0 font-mono font-bold">{num(it.credits)}</span>
            </div>
          ))}
        </div>
      </div>

      {data.works.map((w) => <WorkSection key={w.slug} w={w} />)}

      <section id="usage" className="mb-10 scroll-mt-16">
        <h2 className="h-section mb-2">Claude 사용량</h2>
        <div className="text-[12px] leading-relaxed mb-3" style={{ color: 'var(--text-dim)' }}>
          영상 작업을 한 날의 Claude 사용량을 공개 토큰 단가로 환산한 값입니다. 실제 청구액이 아니고,
          같은 날 한 다른 작업(앱 개발, 이미지 작업)도 섞여 있습니다.
        </div>
        <div className="card overflow-x-auto mb-3">
          <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse', minWidth: 520 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)' }}>
                <th className="label text-left px-3 py-2">날짜</th>
                <th className="label text-left px-3 py-2">그날 한 작품</th>
                <th className="label text-right px-3 py-2">응답 수</th>
                <th className="label text-right px-3 py-2">환산 (USD)</th>
              </tr>
            </thead>
            <tbody>
              {data.usage.days.map((d) => (
                <tr key={d.date} style={{ borderTop: '1px solid var(--line)' }}>
                  <td className="px-3 py-2.5 font-mono whitespace-nowrap align-top">{md(d.date)}</td>
                  <td className="px-3 py-2.5 leading-relaxed" style={{ color: 'var(--text-dim)' }}>{d.works.join(' · ')}</td>
                  <td className="px-3 py-2.5 text-right font-mono align-top">{num(d.responses)}</td>
                  <td className="px-3 py-2.5 text-right font-mono align-top">${d.usd.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.usage.notes.map((n) => (
          <div key={n} className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>· {n}</div>
        ))}
      </section>

      <section id="limits" className="scroll-mt-16">
        <div className="card p-4" style={{ borderColor: 'var(--warn)' }}>
          <div className="text-[12.5px] font-bold mb-1" style={{ color: 'var(--warn)' }}>자료의 한계</div>
          {data.limits.map((l) => (
            <div key={l} className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>· {l}</div>
          ))}
        </div>
      </section>
    </div>
  );
}
