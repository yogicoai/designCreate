import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import Zoomable from '@/components/Zoomable';
import { getCuts, getProducts, getTalents } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const TALENT_LABEL: Record<string, string> = {
  W_A: '여성A', W_B: '여성B', W_C: '여성C', W_D: '여성D',
  M_A: '남성A', K_A: '아동A', K_B: '아동B',
};

/** 'YYYY-MM-DD' + 요일 */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const w = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  return `${iso.slice(0, 10)} (${w})`;
}

export default async function CutsPage({ searchParams }: PageProps<'/cuts'>) {
  const sp = await searchParams;
  const pick = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]) as string | undefined;
  const line = pick('line');
  const colorKey = pick('color');
  const talentCode = pick('talent');
  const source = pick('source') as 'legacy' | 'imgcreate' | undefined;

  const [cuts, products, talents] = await Promise.all([
    getCuts({ line, colorKey, talentCode, source, limit: 600 }),
    getProducts(),
    getTalents(),
  ]);

  /*
   * 생성일자별로 묶는다 — 게시판의 축은 날짜다.
   * 단 이관(legacy) 컷의 createdAt 은 "시드를 돌린 날"이라 실제 작업일이 아니다.
   * 날짜 그룹에 섞으면 이관일에 151컷을 만든 것처럼 보이므로 별도 섹션으로 뺀다.
   */
  const LEGACY_KEY = '__legacy__';
  const byDay = new Map<string, typeof cuts>();
  for (const c of cuts) {
    const day = c.source === 'legacy' ? LEGACY_KEY : String(c.createdAt).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(c);
  }
  // 생성분 날짜는 최신순, 이관 섹션은 맨 뒤
  const days = [...byDay.keys()].filter((d) => d !== LEGACY_KEY).sort().reverse();
  if (byDay.has(LEGACY_KEY)) days.push(LEGACY_KEY);

  const generated = cuts.filter((c) => c.source === 'imgcreate').length;
  const activeFilter = line || colorKey || talentCode || source;

  const chip = (label: string, href: string, on: boolean) => (
    <Link key={href + label} href={href} className="chip"
          style={on ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
      {label}
    </Link>
  );

  const qs = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const merged = { line, color: colorKey, talent: talentCode, source, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `/cuts?${s}` : '/cuts';
  };

  return (
    <div className="p-7 max-w-[1180px]">
      <PageHeader
        title="컷 갤러리"
        desc={`총 ${cuts.length}컷 · 이 앱이 생성한 컷 ${generated}건. 생성일자별로 정리됩니다.`}
        right={<Link href="/create" className="btn btn-primary">＋ 새로 생성</Link>}
      />

      {/* 필터 */}
      <div className="card p-3.5 mb-5 flex flex-col gap-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="label w-[42px]">출처</span>
          {chip('전체', qs({ source: undefined }), !source)}
          {chip('이 앱 생성', qs({ source: 'imgcreate' }), source === 'imgcreate')}
          {chip('기존 이관', qs({ source: 'legacy' }), source === 'legacy')}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="label w-[42px]">제품</span>
          {chip('전체', qs({ line: undefined, color: undefined }), !line)}
          {products.map((p) => chip(p.line, qs({ line: p.line, color: undefined }), line === p.line))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="label w-[42px]">모델</span>
          {chip('전체', qs({ talent: undefined }), !talentCode)}
          {talents.map((t) => chip(TALENT_LABEL[t.code] ?? t.code, qs({ talent: t.code }), talentCode === t.code))}
        </div>
        {activeFilter && (
          <div><Link href="/cuts" className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>필터 초기화 ✕</Link></div>
        )}
      </div>

      {cuts.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>조건에 맞는 컷이 없습니다.</p>
        </div>
      )}

      {days.map((day) => {
        const list = byDay.get(day)!;
        const isLegacy = day === LEGACY_KEY;
        return (
          <section key={day} className="mb-7">
            <div className="flex items-baseline gap-2.5 mb-3">
              <h2 className="h-section">{isLegacy ? '기존 이관 컷' : dayLabel(day)}</h2>
              <span className="text-[12px]" style={{ color: 'var(--text-mute)' }}>{list.length}컷</span>
              {isLegacy
                ? <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>youtube 프로젝트에서 가져온 기존 작업분</span>
                : <span className="chip" style={{ color: 'var(--accent)' }}>생성</span>}
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2.5">
              {list.map((c) => (
                <div key={c.id}>
                  <Zoomable
                    src={c.url}
                    alt={c.spec}
                    caption={`${c.line} · ${c.colorName}\n${c.spec}`}
                    className="w-full aspect-square object-cover rounded-lg border"
                    style={{ borderColor: c.source === 'imgcreate' ? 'var(--accent-dim)' : 'var(--line)', background: 'var(--surface-2)' }}
                  />
                  <div className="mt-1.5 text-[10.5px] leading-tight truncate" style={{ color: 'var(--text-dim)' }}>
                    {c.line} · {c.colorName}
                  </div>
                  <div className="text-[9.5px] flex gap-1.5 flex-wrap" style={{ color: 'var(--text-mute)' }}>
                    {(c.recipe?.talentCodes ?? []).map((t) => <span key={t}>{TALENT_LABEL[t] ?? t}</span>)}
                    {c.recipe?.pose && <span>{c.recipe.pose}</span>}
                    {typeof c.deltaE === 'number' && (
                      <span style={{ color: c.deltaE < 5 ? 'var(--ok)' : c.deltaE < 15 ? 'var(--warn)' : 'var(--danger)' }}>
                        ΔE{c.deltaE}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
