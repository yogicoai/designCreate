import Link from 'next/link';
import DashboardCut from '@/components/DashboardCut';
import { getOverview, getCuts } from '@/lib/queries';

export const dynamic = 'force-dynamic';

function Stat({ value, label, sub, accent }: { value: number | string; label: string; sub?: string; accent?: boolean }) {
  return (
    <div className="card p-4">
      <div className="text-[26px] font-extrabold leading-none" style={{ color: accent ? 'var(--accent)' : 'var(--text)' }}>
        {value}
      </div>
      <div className="text-[12.5px] mt-1.5 font-semibold" style={{ color: 'var(--text-dim)' }}>{label}</div>
      {sub && <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-mute)' }}>{sub}</div>}
    </div>
  );
}

export default async function DashboardPage() {
  const o = await getOverview();
  // 최근 컷은 이 앱이 실제로 생성한 것만 — 이관된 legacy 컷은 갤러리에서 본다
  const recent = await getCuts({ source: 'imgcreate', limit: 12 });
  const coverage = o.counts.colorSlots ? Math.round((o.counts.coveredSlots / o.counts.colorSlots) * 100) : 0;

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <header className="mb-6">
        <h1 className="text-[22px] font-extrabold tracking-tight">대시보드</h1>
        <p className="text-[13px] mt-1" style={{ color: 'var(--text-dim)' }}>
          전속 모델과 제품 레퍼런스를 조합해 자사몰 이미지를 생성합니다.
        </p>
      </header>

      {/* 자산 현황 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Stat value={o.counts.cuts} label="보유 컷" sub={`이 앱 생성 ${o.counts.generated}컷`} accent />
        <Stat value={`${coverage}%`} label="컬러 슬롯 커버리지" sub={`${o.counts.coveredSlots} / ${o.counts.colorSlots} 슬롯`} />
        <Stat value={o.counts.poses} label="실사 포즈 레퍼" sub={`제품 ${o.counts.lines}라인`} />
        <Stat value={o.counts.talents} label="전속 모델" sub="아이덴티티 시트 4종" />
      </div>

      {/* 시작하기 */}
      <div className="card p-5 mb-6 flex items-center justify-between gap-4 flex-wrap"
           style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-dim)' }}>
        <div>
          <div className="text-[14.5px] font-bold">모델을 고르고 방향만 적으면 생성됩니다</div>
          <div className="text-[12px] mt-1" style={{ color: 'var(--text-dim)' }}>
            승인된 컷을 베이스로 컬러·모델·배경만 바꾸는 방식이 가장 정확합니다.
          </div>
        </div>
        <Link href="/create" className="btn btn-primary">이미지 생성 →</Link>
      </div>

      <div>
        {/* 최근 컷 */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="h-section">최근 생성 컷</h2>
            <Link href="/cuts?source=imgcreate" className="text-[12px]" style={{ color: 'var(--text-mute)' }}>전체 보기 →</Link>
          </div>
          {recent.length === 0 ? (
            <div className="card p-8 text-center">
              <p className="text-[13px] mb-3" style={{ color: 'var(--text-dim)' }}>
                아직 이 앱으로 생성한 컷이 없습니다.
              </p>
              <Link href="/create" className="btn btn-primary">첫 이미지 생성하기 →</Link>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 2xl:grid-cols-6 gap-2.5">
              {recent.map((c) => {
                const label = c.line ? `${c.line} · ${c.colorName}` : (c.title || c.spec || '생성 컷');
                const meta = [
                  String(c.createdAt).slice(0, 10),
                  c.width && c.height ? `${c.width}×${c.height}` : '',
                  typeof c.deltaE === 'number' ? `ΔE ${c.deltaE}` : '',
                  c.aiModel ?? '',
                ].filter(Boolean).join(' · ');
                return (
                  <DashboardCut
                    key={c.id}
                    id={c.id}
                    url={c.url}
                    label={label}
                    sub={[String(c.createdAt).slice(0, 10), typeof c.deltaE === 'number' ? `ΔE ${c.deltaE}` : '']
                      .filter(Boolean)
                      .join(' · ')}
                    caption={[c.title && c.title !== label ? `${label} — ${c.title}` : label, meta]
                      .filter(Boolean)
                      .join('\n')}
                    source={c.source}
                    refs={(c.inputImages ?? []).map((r) => ({
                      kind: r.kind, title: r.title ?? '', url: r.url ?? '', swatchHex: r.swatchHex,
                    }))}
                  />
                );
              })}
            </div>
          )}
        </section>


      </div>
    </div>
  );
}
