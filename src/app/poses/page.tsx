import PageHeader from '@/components/PageHeader';
import Zoomable from '@/components/Zoomable';
import { getPoseRefs, getProducts } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function PosesPage() {
  const [poses, products] = await Promise.all([getPoseRefs(), getProducts()]);

  const order = new Map(products.map((p, i) => [p.line, i]));
  const byLine = new Map<string, typeof poses>();
  for (const p of poses) {
    if (!byLine.has(p.line)) byLine.set(p.line, []);
    byLine.get(p.line)!.push(p);
  }
  const lines = [...byLine.keys()].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));

  return (
    <div className="p-7 max-w-[1180px]">
      <PageHeader
        title="포즈 레퍼런스"
        desc="실제 촬영본에서 뽑은 착석 레퍼런스. 착석 썸네일 품질의 핵심 자산입니다."
      />

      <div className="card p-4 mb-5">
        <div className="text-[12.5px] font-bold mb-1.5">한 포즈에 두 장이 있는 이유</div>
        <div className="grid sm:grid-cols-2 gap-3 text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          <div>
            <b style={{ color: 'var(--accent)' }}>off — 모델 제거본 (형태)</b><br />
            사람을 지운 빈백 단독 눌림. 실제로 앉았을 때의 <b>구김·압축 물리</b>를 그대로 재현합니다.
            인물 오염이 0이라 새 모델을 앉힐 때 씁니다.
          </div>
          <div>
            <b style={{ color: 'var(--info)' }}>on — 모델 포함본 (포즈·각도)</b><br />
            각도·구도·앉는 연출이 중요한 컷은 형태 레퍼가 아니라 <b>원본 포즈 프레임</b>을 베이스로 넣어
            각도를 잠근 뒤 얼굴·의상·색·배경만 교체합니다.
          </div>
        </div>
      </div>

      {lines.map((line) => (
        <section key={line} className="mb-7">
          <h2 className="h-section mb-3">
            {line} <span className="text-[12px] font-normal" style={{ color: 'var(--text-mute)' }}>{byLine.get(line)!.length}포즈</span>
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {byLine.get(line)!.map((p) => (
              <div key={p.id} className="card p-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="text-[12.5px] font-semibold leading-snug">{p.name}</div>
                  <span className="chip shrink-0">{p.tag}</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {([
                    ['off · 형태', p.offUrl, 'var(--accent-dim)'],
                    ['on · 포즈각도', p.onUrl, 'var(--line-strong)'],
                  ] as const).map(([label, url, border]) => (
                    <div key={label}>
                      {url ? (
                        <Zoomable
                          src={url}
                          alt={`${p.name} ${label}`}
                          caption={`${line} · ${p.name} — ${label}\n${p.note}`}
                          className="w-full aspect-square object-cover rounded-md border"
                          style={{ borderColor: border, background: 'var(--surface-2)' }}
                        />
                      ) : (
                        <div className="w-full aspect-square rounded-md border border-dashed" style={{ borderColor: 'var(--line)' }} />
                      )}
                      <div className="text-[9.5px] mt-1 text-center" style={{ color: 'var(--text-mute)' }}>{label}</div>
                    </div>
                  ))}
                </div>
                {p.note && (
                  <p className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-mute)' }}>{p.note}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
