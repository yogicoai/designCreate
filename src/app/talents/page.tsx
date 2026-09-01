import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import Zoomable from '@/components/Zoomable';
import { getTalents, getCuts, getExpressions } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * 아이덴티티 락 시트 3종.
 * ④ 제품 착석 연출 시트는 쓰지 않는다 — 착석 연출은 포즈 레퍼런스(실사)가 담당하고,
 * 모델 시트는 얼굴·표정·체형 락만 맡는다.
 */
const SHEETS = [
  { key: 'face' as const, label: '① 페이스 턴어라운드', layout: '5패널', goal: '얼굴 정체성·각도 고정' },
  { key: 'expr' as const, label: '② 페이셜 익스프레션', layout: '2×4 · 8컷', goal: '표정만 변경, 얼굴 고정 — 아래 표정 조각의 원본' },
  { key: 'body' as const, label: '③ 바디 턴어라운드', layout: '5패널', goal: '체형·비율 고정' },
];

export default async function TalentsPage() {
  const [talents, cuts, expressions] = await Promise.all([getTalents(), getCuts({ limit: 2000 }), getExpressions()]);

  const cutCount = new Map<string, number>();
  for (const c of cuts) for (const t of c.recipe?.talentCodes ?? []) cutCount.set(t, (cutCount.get(t) ?? 0) + 1);

  const byCat = new Map<string, typeof talents>();
  for (const t of talents) {
    if (!byCat.has(t.category)) byCat.set(t.category, []);
    byCat.get(t.category)!.push(t);
  }
  const EMOJI: Record<string, string> = { 여성: '👩', 남성: '👨', 아동: '🧒' };

  return (
    <div className="p-7 max-w-[1180px]">
      <PageHeader
        title="전속 모델"
        desc="포즈·의상·공간이 바뀌어도 동일 인물로 인식되는 얼굴 아이덴티티 고정 모델. 실존인물 복제가 아니라 레퍼런스의 인상만 참고합니다."
      />

      <div className="card p-4 mb-5" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-dim)' }}>
        <div className="text-[12.5px] font-bold mb-1">★ 얼굴 드리프트 방지 규칙</div>
        <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          생성할 때 <b>대표컷(아이덴티티 정본) + 요청한 표정 조각 한 장</b>이 참조로 들어갑니다.
          8칸 시트 통째로 넣거나 무표정 턴어라운드만 넣고 &ldquo;smile&rdquo; 이라고 쓰면 얼굴이 흔들립니다.
        </div>
      </div>

      {[...byCat.entries()].map(([cat, list]) => (
        <section key={cat} className="mb-7">
          <h2 className="h-section mb-3">
            {EMOJI[cat] ?? ''} {cat} <span className="text-[12px] font-normal" style={{ color: 'var(--text-mute)' }}>{list.length}명</span>
          </h2>

          <div className="flex flex-col gap-3">
            {list.map((t) => {
              const n = cutCount.get(t.code) ?? 0;
              const sheetCount = SHEETS.filter((s) => t.sheets?.[s.key]).length;
              return (
                <div key={t.id} className="card p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap mb-2.5">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span
                        className="text-[12.5px] font-extrabold px-2.5 py-0.5 rounded-lg"
                        style={{ background: 'var(--accent)', color: '#fff' }}
                      >
                        {cat} {t.slot}
                      </span>
                      <span className="text-[12.5px]" style={{ color: 'var(--text-dim)' }}>{t.name}</span>
                      <span className="chip" style={{ color: 'var(--info)' }}>{t.size}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="chip" style={{ color: sheetCount === SHEETS.length ? 'var(--ok)' : 'var(--warn)' }}>
                        시트 {sheetCount}/{SHEETS.length}
                      </span>
                      <Link href={`/cuts?talent=${t.code}`} className="chip" style={{ color: 'var(--accent)' }}>
                        {n}컷 →
                      </Link>
                    </div>
                  </div>

                  <p className="text-[11.5px] leading-relaxed mb-3" style={{ color: 'var(--text-dim)' }}>
                    {t.thumbDesc || t.identity}
                  </p>

                  <div className="flex gap-2.5 flex-wrap items-start">
                    {t.rep && (
                      <div className="text-center">
                        <Zoomable
                          src={t.rep}
                          alt={`${t.code} 대표컷`}
                          caption={`${cat} ${t.slot} · 대표 컷`}
                          className="w-[104px] rounded-lg border object-cover"
                          style={{ aspectRatio: '3/4', borderColor: 'var(--line-strong)' }}
                        />
                        <div className="text-[10px] mt-1" style={{ color: 'var(--text-mute)' }}>대표 컷</div>
                      </div>
                    )}
                    {SHEETS.map((s) => {
                      const url = t.sheets?.[s.key];
                      return (
                        <div key={s.key} className="text-center">
                          {url ? (
                            <Zoomable
                              src={url}
                              alt={s.label}
                              caption={`${cat} ${t.slot} · ${s.label} (${s.layout}) — ${s.goal}`}
                              className="w-[138px] rounded-lg border object-cover"
                              style={{ aspectRatio: '16/9', borderColor: 'var(--accent-dim)' }}
                            />
                          ) : (
                            <div
                              className="w-[138px] rounded-lg border border-dashed flex items-center justify-center text-[10px] px-2 text-center"
                              style={{ aspectRatio: '16/9', borderColor: 'var(--line-strong)', color: 'var(--text-mute)' }}
                            >
                              {s.label.replace(/^[①②③④]\s/, '')}
                            </div>
                          )}
                          <div className="text-[10px] mt-1" style={{ color: s.key === 'expr' ? 'var(--accent)' : 'var(--text-mute)' }}>
                            {s.label.slice(0, 2)}{s.key === 'expr' ? ' ★' : ''}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {t.expressionCrops && Object.keys(t.expressionCrops).length > 0 && (
                    <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--line)' }}>
                      <div className="label mb-2">
                        표정 조각 — 생성 때는 시트 대신 요청한 표정 한 장만 들어갑니다
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {expressions.map((ex) => {
                          const url = t.expressionCrops?.[ex.id];
                          if (!url) return null;
                          return (
                            <div key={ex.id} className="text-center">
                              <Zoomable
                                src={url}
                                alt={ex.kr}
                                caption={`${cat} ${t.slot} · ${ex.kr} — ${ex.en}`}
                                className="w-[96px] rounded-lg border object-cover"
                                style={{ aspectRatio: '9/10', borderColor: 'var(--line-strong)', background: 'var(--surface-2)' }}
                              />
                              <div className="text-[9.5px] mt-1" style={{ color: 'var(--text-mute)' }}>{ex.kr}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {t.outfits.length > 0 && (
                    <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--line)' }}>
                      <div className="label mb-2">의상 컨셉 — 다른 모델 의상을 쓰면 안 됩니다</div>
                      <div className="flex flex-wrap gap-2.5">
                        {t.outfits.map((o) => (
                          <div key={o.code} className="text-center">
                            <Zoomable
                              src={o.imageUrl}
                              alt={o.desc}
                              caption={`${cat} ${t.slot} · ${o.code} — ${o.desc}`}
                              className="w-[92px] rounded-lg border object-cover"
                              style={{ aspectRatio: '3/4', borderColor: 'var(--line-strong)', background: 'var(--surface-2)' }}
                            />
                            <div className="text-[9.5px] mt-1 font-mono" style={{ color: 'var(--accent)' }}>{o.code}</div>
                            <div className="text-[9.5px] w-[92px] leading-tight" style={{ color: 'var(--text-mute)' }}>{o.desc}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
