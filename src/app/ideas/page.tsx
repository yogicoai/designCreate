import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import raw from './data.json';

export const dynamic = 'force-dynamic';

/**
 * 아이디어 · 레퍼런스 — 숏츠 기획안과 시안 이미지, 월 3,000 크레딧 운영 방향.
 *
 * 2026-10-29 사용자: "하단에 아이디어 등 레퍼런스라고 해서 하나 제일 하단에 생성 · 우리 회사 자체가 기획자가 없으니
 * 요기보 데이터와 최신 트렌드를 접목해서 아이디어 기획 → 힉스필드로 이미지 → 검토 후 영상 제작 · 한 달에 힉스필드
 * 3천 크레딧 안에서 영상을 찍어 낸다 · 기획을 너한테 맡길게".
 *
 * 내용은 data.json 에 있다 — 매 주기(22일 갱신) 기획안을 바꾸고, 시안 이미지는 오픈호스팅(web/design/ideas/)에 올려
 * ideas[].images 에 주소를 넣는다. 숫자는 실측(힉스필드 거래 내역·생성 직전 조회값)만 쓰고 추정은 「예상」으로 적는다.
 */

interface Img { url: string; caption: string }
interface Idea {
  /** no = 우선순위 (1 이 먼저 만들 안) · why = 그 순위의 이유 · deadline = 공개 시기가 정해진 안만 */
  id: string; no: number; title: string; tag: string; status: string; why: string; deadline?: string; logline: string; hook: string;
  beats: string[]; trend: string; assets: string; length: string; estCredits: number; risk: string; images: Img[];
  /** 제품 형태가 틀어질 위험 — 팟·드롭은 낮고 길쭉한 맥스는 높다 (1차 시안 확인 2026-10-29) */
  shapeRisk: 'low' | 'mid' | 'high'; shapeNote: string;
}
interface Data {
  updatedAt: string; cycle: string; motto: string; pilotNote: string;
  process: { t: string; who: string; d: string }[];
  budget: {
    monthly: number; renew: string;
    unitCosts: { what: string; credits: number }[];
    perShort: { what: string; credits: number; note: string }[];
    plan: { what: string; credits: number; note: string }[];
    shared: { since: string; asOf: string; start: number; balance: number; ours: number; note: string };
  };
  trends: { title: string; point: string; use: string; source: { label: string; url: string } }[];
  ideas: Idea[];
  priorityCriteria: string[];
  rules: string[];
  decisions: { q: string; d: string }[];
}

const data = raw as unknown as Data;

const num = (v: number) => v.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
/** 2026-10-29 → 10/29 */
const md = (s: string) => (s.length >= 10 ? `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}` : s);

const Sub = ({ children }: { children: React.ReactNode }) => <h3 className="label mb-2">{children}</h3>;

const RISK = {
  low: { label: '낮음', color: 'var(--ok)' },
  mid: { label: '중간', color: 'var(--warn)' },
  high: { label: '높음', color: 'var(--danger)' },
} as const;

function IdeaCard({ x }: { x: Idea }) {
  return (
    <article id={x.id} className="card p-4 scroll-mt-16 flex flex-col gap-3">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[11px] font-bold" style={{ color: 'var(--accent)' }}>우선순위 {x.no} · {x.tag}</div>
          <h3 className="text-[16px] font-extrabold tracking-tight mt-0.5" style={{ textWrap: 'balance' }}>{x.title}</h3>
        </div>
        <span className="chip shrink-0"
              style={x.images.length > 0 ? { color: 'var(--warn)', borderColor: 'var(--warn)' } : { color: 'var(--text-mute)' }}>{x.status}</span>
      </header>

      <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
        <span className="label mr-1.5">이 순위인 이유</span>{x.why}
        {x.deadline && <div className="mt-1 font-bold" style={{ color: 'var(--warn)' }}>공개 시기 · {x.deadline}</div>}
      </div>

      {x.images.length > 0 ? (
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(x.images.length, 3)}, minmax(0, 1fr))` }}>
          {x.images.map((im) => (
            <figure key={im.url} className="min-w-0">
              <a href={im.url} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={im.url} alt={im.caption} loading="lazy" className="w-full rounded-md"
                     style={{ aspectRatio: '9 / 16', objectFit: 'cover', background: 'var(--surface-2)' }} />
              </a>
              <figcaption className="text-[11px] mt-1 leading-snug" style={{ color: 'var(--text-mute)' }}>{im.caption}</figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <div className="rounded-md text-[12px] p-6 text-center" style={{ background: 'var(--surface-2)', color: 'var(--text-mute)' }}>
          시안 이미지 준비 중
        </div>
      )}

      <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{x.logline}</p>

      <div className="text-[12px]">
        <span className="label mr-1.5">훅</span>
        <span style={{ color: 'var(--text)' }}>{x.hook}</span>
      </div>

      <div>
        <Sub>장면 구성</Sub>
        <ol className="flex flex-col gap-1">
          {x.beats.map((b) => (
            <li key={b} className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{b}</li>
          ))}
        </ol>
      </div>

      <dl className="grid gap-x-3 gap-y-1.5 text-[12px]" style={{ gridTemplateColumns: 'auto minmax(0, 1fr)' }}>
        <dt className="label">트렌드</dt><dd style={{ color: 'var(--text-dim)' }}>{x.trend}</dd>
        <dt className="label">쓰는 자산</dt><dd style={{ color: 'var(--text-dim)' }}>{x.assets}</dd>
        <dt className="label">제품 형태 위험</dt>
        <dd><b style={{ color: RISK[x.shapeRisk].color }}>{RISK[x.shapeRisk].label}</b> <span style={{ color: 'var(--text-dim)' }}>— {x.shapeNote.replace(/^\S+ · /, '')}</span></dd>
        <dt className="label">길이</dt><dd style={{ color: 'var(--text-dim)' }}>{x.length} · 세로 9:16</dd>
        <dt className="label">예상 크레딧</dt>
        <dd><b className="font-mono">{num(x.estCredits)}</b> <span style={{ color: 'var(--text-mute)' }}>(다시 뽑기 여유 포함 예상치)</span></dd>
      </dl>

      <div className="text-[11.5px] leading-relaxed rounded-md p-2.5" style={{ background: 'var(--surface-2)', color: 'var(--text-dim)' }}>
        <b style={{ color: 'var(--text)' }}>제작 메모</b> — {x.risk}
      </div>
    </article>
  );
}

export default function IdeasPage() {
  const b = data.budget;
  const planSum = b.plan.reduce((s, p) => s + p.credits, 0);
  const spent = b.shared.start - b.shared.balance;
  const others = spent - b.shared.ours;
  const ranked = [...data.ideas].sort((a, b) => a.no - b.no);

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1200px]">
      <PageHeader
        title="아이디어 · 레퍼런스"
        desc={`숏츠 기획안과 시안 이미지, 그리고 힉스필드 월 ${num(b.monthly)} 크레딧 안에서 영상을 만드는 운영 방향입니다. (${md(data.updatedAt)} 기준 · ${data.cycle})`}
      />

      <div className="card p-4 mb-5" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-dim)' }}>
        <div className="text-[12px] font-bold mb-1" style={{ color: 'var(--accent)' }}>바뀐 작업 방식</div>
        <div className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{data.motto}</div>
      </div>

      <nav aria-label="바로가기" className="flex flex-wrap gap-1.5 mb-7">
        <a href="#ideas" className="chip">이번 달 기획안</a>
        <a href="#budget" className="chip">월 3,000 운영 계획</a>
        <a href="#trends" className="chip">트렌드 근거</a>
        <a href="#rules" className="chip">제작 원칙</a>
        <a href="#decide" className="chip">결정할 것</a>
      </nav>

      <h2 className="h-section mb-3">작업 순서</h2>
      <div className="grid gap-2 mb-8" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        {data.process.map((s, i) => (
          <div key={s.t} className="card p-3.5 flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-extrabold"
                    style={{ background: 'var(--accent)', color: '#fff' }}>{i + 1}</span>
              <span className="text-[13px] font-bold">{s.t}</span>
            </div>
            <div className="text-[11px] font-bold" style={{ color: 'var(--text-mute)' }}>{s.who}</div>
            <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{s.d}</div>
          </div>
        ))}
      </div>

      <section id="ideas" className="mb-10 scroll-mt-16">
        <h2 className="h-section mb-2">이번 달 기획안 {data.ideas.length}개</h2>
        <div className="text-[12px] leading-relaxed mb-3" style={{ color: 'var(--text-dim)' }}>
          시안 이미지는 분위기와 구도를 보기 위한 그림입니다. 영상으로 만들 때는 얼굴과 제품 형태를 다시 맞춥니다.
          진행할 안을 골라 주시면 그 안부터 장면 그림 → 초안 → 본편 순서로 만듭니다.
        </div>
        <div className="card p-3.5 mb-4" style={{ borderColor: 'var(--warn)' }}>
          <div className="text-[12px] font-bold mb-1" style={{ color: 'var(--warn)' }}>1차 시안에서 확인한 것</div>
          <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{data.pilotNote}</div>
        </div>
        <h3 className="text-[13.5px] font-bold mb-1.5">우선순위</h3>
        <ul className="flex flex-col gap-0.5 mb-2.5">
          {data.priorityCriteria.map((c, i) => (
            <li key={c} className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{i + 1}. {c}</li>
          ))}
        </ul>
        <div className="card overflow-x-auto mb-5">
          <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse', minWidth: 680 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)' }}>
                <th className="label text-right px-3 py-2">순위</th>
                <th className="label text-left px-3 py-2">기획안</th>
                <th className="label text-left px-3 py-2">제품 형태 위험</th>
                <th className="label text-left px-3 py-2">공개 시기</th>
                <th className="label text-right px-3 py-2">예상 크레딧</th>
                <th className="label text-left px-3 py-2">이유</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((x) => (
                <tr key={x.id} style={{ borderTop: '1px solid var(--line)' }}>
                  <td className="px-3 py-2.5 text-right font-mono font-bold">{x.no}</td>
                  <td className="px-3 py-2.5 font-bold whitespace-nowrap">
                    <a href={`#${x.id}`} className="underline" style={{ color: 'var(--text)' }}>{x.title}</a>
                  </td>
                  <td className="px-3 py-2.5 font-bold whitespace-nowrap" style={{ color: RISK[x.shapeRisk].color }}>{RISK[x.shapeRisk].label}</td>
                  <td className="px-3 py-2.5" style={{ color: x.deadline ? 'var(--warn)' : 'var(--text-mute)' }}>{x.deadline?.split(' → ')[0] ?? '언제든'}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{num(x.estCredits)}</td>
                  <td className="px-3 py-2.5 leading-relaxed" style={{ color: 'var(--text-dim)' }}>{x.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
          {ranked.map((x) => <IdeaCard key={x.id} x={x} />)}
        </div>
      </section>

      <section id="budget" className="mb-10 scroll-mt-16">
        <h2 className="h-section mb-2">월 {num(b.monthly)} 크레딧 운영 계획</h2>
        <div className="text-[12px] leading-relaxed mb-3" style={{ color: 'var(--text-dim)' }}>{b.renew}</div>

        <div className="grid gap-3 mb-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
          <div className="card p-3.5">
            <Sub>단가 (생성 직전 조회값)</Sub>
            {b.unitCosts.map((u, i) => (
              <div key={u.what} className="py-1.5 flex justify-between gap-3 text-[12px]" style={{ borderTop: i ? '1px solid var(--line)' : undefined }}>
                <span style={{ color: 'var(--text-dim)' }}>{u.what}</span>
                <span className="shrink-0 font-mono font-bold">{num(u.credits)}</span>
              </div>
            ))}
          </div>
          <div className="card p-3.5">
            <Sub>숏츠 한 편 예상</Sub>
            {b.perShort.map((p, i) => (
              <div key={p.what} className="py-1.5 text-[12px]" style={{ borderTop: i ? '1px solid var(--line)' : undefined }}>
                <div className="flex justify-between gap-3">
                  <span style={{ color: 'var(--text)' }}>{p.what}</span>
                  <span className="shrink-0 font-mono font-bold">약 {num(p.credits)}</span>
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-mute)' }}>{p.note}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="card overflow-x-auto mb-3">
          <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse', minWidth: 520 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)' }}>
                <th className="label text-left px-3 py-2">한 달 배분 (제안)</th>
                <th className="label text-right px-3 py-2">크레딧</th>
                <th className="label text-left px-3 py-2">비율</th>
                <th className="label text-left px-3 py-2">내용</th>
              </tr>
            </thead>
            <tbody>
              {b.plan.map((p) => (
                <tr key={p.what} style={{ borderTop: '1px solid var(--line)' }}>
                  <td className="px-3 py-2.5 font-bold">{p.what}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{num(p.credits)}</td>
                  <td className="px-3 py-2.5" style={{ minWidth: 120 }}>
                    <div className="h-2.5 overflow-hidden" style={{ background: 'var(--surface-3)', borderRadius: 5 }}
                         role="img" aria-label={`${Math.round((p.credits / b.monthly) * 100)}%`}>
                      <i className="block h-full" style={{ width: `${(p.credits / b.monthly) * 100}%`, background: 'var(--accent)' }} />
                    </div>
                  </td>
                  <td className="px-3 py-2.5 leading-relaxed" style={{ color: 'var(--text-dim)' }}>{p.note}</td>
                </tr>
              ))}
              <tr style={{ borderTop: '1px solid var(--line)', background: 'var(--surface-2)' }}>
                <td className="px-3 py-2.5 font-bold">합계</td>
                <td className="px-3 py-2.5 text-right font-mono font-bold">{num(planSum)}</td>
                <td colSpan={2} className="px-3 py-2.5" style={{ color: 'var(--text-mute)' }}>월 {num(b.monthly)} 중</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="card p-4" style={{ borderColor: 'var(--warn)' }}>
          <div className="text-[12.5px] font-bold mb-1" style={{ color: 'var(--warn)' }}>
            공용 계정 사용량 ({md(b.shared.since)} ~ {md(b.shared.asOf)})
          </div>
          <div className="text-[12px] leading-relaxed mb-2" style={{ color: 'var(--text-dim)' }}>{b.shared.note}</div>
          <div className="flex gap-4 flex-wrap text-[12px]">
            <span>갱신 <b className="font-mono">{num(b.shared.start)}</b></span>
            <span>잔액 <b className="font-mono">{num(b.shared.balance)}</b></span>
            <span>사용 <b className="font-mono">{num(Math.round(spent))}</b></span>
            <span>그중 영상·기획 <b className="font-mono">{num(b.shared.ours)}</b></span>
            <span style={{ color: 'var(--warn)' }}>다른 사용처 <b className="font-mono">{num(Math.round(others))}</b></span>
          </div>
        </div>
      </section>

      <section id="trends" className="mb-10 scroll-mt-16">
        <h2 className="h-section mb-2">트렌드 근거</h2>
        <div className="text-[12px] leading-relaxed mb-3" style={{ color: 'var(--text-dim)' }}>
          2026년 숏폼 관련 자료에서 뽑았습니다. 대부분 마케팅 업체 분석이라 숫자보다 방향으로 봐 주세요.
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
          {data.trends.map((t) => (
            <div key={t.title} className="card p-3.5 flex flex-col gap-1.5">
              <div className="text-[13px] font-bold">{t.title}</div>
              <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{t.point}</div>
              <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text)' }}>
                <span className="label mr-1">기획에 쓴 곳</span>{t.use}
              </div>
              <a href={t.source.url} target="_blank" rel="noreferrer" className="text-[11px] underline mt-auto" style={{ color: 'var(--accent)' }}>
                출처 · {t.source.label}
              </a>
            </div>
          ))}
        </div>
      </section>

      <section id="rules" className="mb-10 scroll-mt-16">
        <h2 className="h-section mb-2">제작 원칙</h2>
        <div className="text-[12px] leading-relaxed mb-3" style={{ color: 'var(--text-dim)' }}>
          지금까지 영상 10편을 만들며 확인한 것들입니다. 자세한 과정은{' '}
          <Link href="/video/process" className="underline" style={{ color: 'var(--accent)' }}>영상 제작 과정</Link>에 있습니다.
        </div>
        <div className="card p-4 flex flex-col gap-1.5">
          {data.rules.map((r) => (
            <div key={r} className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>· {r}</div>
          ))}
        </div>
      </section>

      <section id="decide" className="scroll-mt-16">
        <h2 className="h-section mb-3">결정할 것</h2>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          {data.decisions.map((d, i) => (
            <div key={d.q} className="card p-3.5">
              <div className="text-[13px] font-bold mb-1">{i + 1}. {d.q}</div>
              <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{d.d}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
