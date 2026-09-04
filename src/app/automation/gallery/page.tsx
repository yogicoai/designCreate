import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import Zoomable from '@/components/Zoomable';
import CutActions from '@/components/CutActions';
import { getCuts } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const TALENT_LABEL: Record<string, string> = {
  W_A: '여성A', W_B: '여성B', W_C: '여성C', W_D: '여성D',
  M_A: '남성A', K_A: '아동A', K_B: '아동B',
};

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const w = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  return `${iso.slice(0, 10)} (${w})`;
}

/**
 * 자동화 > 자동화 생성이미지.
 *
 * SNS 자동화가 만든 컷만 모아 따로 관리한다 (origin='sns-auto').
 * 일반 생성 갤러리에는 섞이지 않는다 — 매일 5장씩 쌓이면 수백 장이 되어
 * 수작업 컷을 밀어내기 때문에 처음부터 게시판을 나눴다.
 */
export default async function AutomationGalleryPage() {
  const cuts = await getCuts({ origin: 'sns-auto', limit: 600 });

  const byDay = new Map<string, typeof cuts>();
  for (const c of cuts) {
    const day = String(c.createdAt).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(c);
  }
  const days = [...byDay.keys()].sort().reverse();

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title="자동화 생성이미지"
        desc={`SNS 자동화가 만든 컷 ${cuts.length}장 — 일반 생성 갤러리와 분리해 관리합니다.`}
        right={<Link href="/automation/sns" className="btn btn-primary">⚡ SNS 이미지 생성으로</Link>}
      />

      {cuts.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
            아직 자동화로 생성된 컷이 없습니다 — 자동화 &gt; SNS 이미지 생성에서 실행하면 여기 쌓입니다.
          </p>
        </div>
      )}

      {days.map((day) => {
        const list = byDay.get(day)!;
        return (
          <section key={day} className="mb-7">
            <div className="flex items-baseline gap-2.5 mb-3">
              <h2 className="h-section">{dayLabel(day)}</h2>
              <span className="text-[12px]" style={{ color: 'var(--text-mute)' }}>{list.length}장</span>
              <span className="chip" style={{ color: 'var(--accent)' }}>SNS 자동화</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-6 gap-2.5">
              {list.map((c) => (
                <div key={c.id}>
                  <Zoomable
                    src={c.url}
                    alt={c.spec}
                    caption={c.spec}
                    className="w-full aspect-[4/5] object-cover rounded-lg border"
                    style={{ borderColor: 'var(--accent-dim)', background: 'var(--surface-2)' }}
                  />
                  <div className="text-[9.5px] mt-1 flex gap-1.5 flex-wrap" style={{ color: 'var(--text-mute)' }}>
                    {(c.recipe?.talentCodes ?? []).map((t) => <span key={t}>{TALENT_LABEL[t] ?? t}</span>)}
                    {/* 소스(베이스) 원본 — 어떤 자산에서 만들어졌는지 바로 확인 */}
                    {(c.inputImages ?? []).filter((r) => r.kind === 'base' && r.url).slice(0, 1).map((r) => (
                      <a key={r.url} href={r.url} target="_blank" rel="noreferrer noopener"
                         style={{ color: 'var(--text-mute)', textDecoration: 'underline' }}>원본</a>
                    ))}
                  </div>
                  <CutActions id={c.id} source={c.source} />
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
