import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import { getProducts, getCuts } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function ProductsPage() {
  const [products, cuts] = await Promise.all([getProducts(), getCuts({ limit: 2000 })]);

  // 컬러 슬롯별 보유 컷 수 — "어느 색이 비었나"가 이 화면의 핵심 정보다
  const cutCount = new Map<string, number>();
  for (const c of cuts) {
    const k = `${c.line}|${c.colorKey}`;
    cutCount.set(k, (cutCount.get(k) ?? 0) + 1);
  }

  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1600px]">
      <PageHeader
        title="제품 · 컬러"
        desc="제품 라인별 기하 서술·실측 치수·컬러 슬롯. 프롬프트의 4종 세트(기하·치수·네거티브·스케일 앵커)가 여기서 조립됩니다."
      />

      <div className="flex flex-col gap-4">
        {products.map((p) => {
          const covered = p.colors.filter((c) => cutCount.get(`${p.line}|${c.key}`)).length;
          return (
            <section key={p.id} className="card p-5">
              {/* 헤더 */}
              <div className="flex items-start justify-between gap-4 flex-wrap mb-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="text-[17px]">{p.emoji}</span>
                    <h2 className="text-[16px] font-bold">{p.line}</h2>
                    {p.sameShapeAs && (
                      <span className="chip">{p.sameShapeAs} 동일 형태</span>
                    )}
                    {!p.geometry.verified && (
                      <span className="chip" style={{ color: 'var(--warn)', borderColor: 'var(--warn)' }}>
                        기하 미검증
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] mt-1.5" style={{ color: 'var(--text-dim)' }}>{p.spec}</p>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[12px] font-semibold tabular-nums">
                    <span style={{ color: covered === p.colors.length ? 'var(--ok)' : 'var(--accent)' }}>{covered}</span>
                    <span style={{ color: 'var(--text-mute)' }}> / {p.colors.length} 컬러</span>
                  </div>
                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-mute)' }}>{p.sizeText}</div>
                </div>
              </div>

              {/* 기하 서술 — 프롬프트에 그대로 들어가는 값 */}
              <div className="grid sm:grid-cols-3 gap-2.5 mb-4">
                {([
                  ['SHAPE (기하 서술)', p.geometry.shape],
                  ['NEGATIVE (금지)', p.geometry.negative],
                  ['USE (사용 자세)', p.geometry.modes],
                ] as const).map(([label, val]) => (
                  <div key={label} className="rounded-lg p-2.5" style={{ background: 'var(--surface-2)' }}>
                    <div className="label mb-1">{label}</div>
                    <div className="text-[11.5px] leading-relaxed font-mono" style={{ color: 'var(--text-dim)' }}>{val}</div>
                  </div>
                ))}
              </div>
              {p.scalePrompt && (
                <div className="rounded-lg p-2.5 mb-4" style={{ background: 'var(--surface-2)' }}>
                  <div className="label mb-1">SCALE ANCHOR (인체 대비 — 모델은 cm 를 못 읽는다)</div>
                  <div className="text-[11.5px] leading-relaxed font-mono" style={{ color: 'var(--text-dim)' }}>{p.scalePrompt}</div>
                </div>
              )}

              {/* 컬러 슬롯 */}
              <div className="label mb-2">컬러 슬롯</div>
              <div className="flex flex-wrap gap-2">
                {p.colors.map((c) => {
                  const n = cutCount.get(`${p.line}|${c.key}`) ?? 0;
                  return (
                    <Link
                      key={c.key}
                      href={`/cuts?line=${p.line}&color=${c.key}`}
                      className="flex items-center gap-2 pl-1.5 pr-2.5 py-1.5 rounded-lg border transition-colors"
                      style={{
                        borderColor: n ? 'var(--line-strong)' : 'var(--line)',
                        background: n ? 'var(--surface-2)' : 'transparent',
                        opacity: n ? 1 : 0.55,
                      }}
                    >
                      <span
                        className="w-6 h-6 rounded-md shrink-0 border"
                        style={{ background: c.hex || '#000', borderColor: 'rgba(255,255,255,.14)' }}
                        title={c.hex}
                      />
                      <span className="text-[11.5px] leading-tight">
                        <span className="font-semibold block">{c.name}</span>
                        <span className="tabular-nums" style={{ color: n ? 'var(--accent)' : 'var(--text-mute)' }}>
                          {n ? `${n}컷` : '미제작'}
                        </span>
                      </span>
                      {c.elementId && <span className="text-[9px]" style={{ color: 'var(--info)' }} title="Higgsfield Element 토큰 보유">EL</span>}
                      {c.views && <span className="text-[9px]" style={{ color: 'var(--text-mute)' }} title="360 단일각도 뷰 보유">360</span>}
                    </Link>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
