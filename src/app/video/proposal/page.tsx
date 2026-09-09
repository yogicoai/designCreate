import Link from 'next/link';
import PageHeader from '@/components/PageHeader';

export const dynamic = 'force-dynamic';

/**
 * 영상 스토리보드 제안 — 어떤 방식으로 영상을 만들 것인가.
 *
 * 2026-09-09 에 두 방식을 실제로 돌려보고 정리한 것이다.
 * 시나리오에서 그림을 만들어 영상으로 가는 길과, 이미 검증된 컷에서 출발하는 길을
 * 같은 날 같은 조건으로 비교했고 결과가 갈렸다. 그 근거를 화면에 남겨둔다 —
 * 나중에 "왜 이렇게 하기로 했더라" 를 다시 논쟁하지 않기 위해서.
 */

const RULES_DO = [
  ['컷당 3~5초', '5초를 넘기면 얼굴이 흔들리기 시작합니다'],
  ['호흡 · 눈 감기 · 시선 · 고개 각도', 'AI가 가장 잘 하는 동작입니다'],
  ['어깨가 툭 내려앉는 이완', '"쉰다" 를 읽히게 하는 가장 확실한 신호'],
  ['카메라 고정 + 아주 느린 푸시 인', '움직임은 편집이 만듭니다'],
  ['웜 뉴트럴 배경 + 채도 있는 제품 하나', '제품만 색이 살아 있게'],
  ['시선은 카메라 밖', '정면 응시는 광고 티가 납니다'],
];

const RULES_DONT = [
  ['손가락 동작', '책 넘기기, 물건 집기, 지퍼 — AI 최대 약점'],
  ['몸을 던져 파묻히는 순간', '빈백 형태가 크게 변하는 구간은 무너집니다'],
  ['팬 · 오빗', '각도가 바뀔 때마다 제품이 다른 물건이 됩니다'],
  ['5초 초과 한 컷', '길게 갈수록 인물이 다른 사람이 됩니다'],
  ['쿨 그레이 톤', '2018년 티가 납니다'],
];

const FLOW = [
  { n: 1, t: '컷 고르기', d: '갤러리에서 시작 프레임이 될 컷을 고릅니다. 제품 형태가 맞고, 얼굴이 전속 모델이고, 제품만 색이 살아 있는 컷.' },
  { n: 2, t: '컷 나누기 — 한 컷 5초', d: '10초면 2컷, 15초면 3컷. 같은 원본을 와이드·미디엄·클로즈업으로 잘라 쓰면 새로 만들지 않고도 컷이 나뉘고, 톤과 인물이 100% 같아집니다.' },
  { n: 3, t: '컷마다 동작 하나만', d: '"빈백은 고정, 사람만 미세하게" 안에서. 동작이 둘이면 5초에 급해 보입니다.' },
  { n: 4, t: '클립 생성', d: '컷당 약 8.75 크레딧. 5초를 넘기지 않습니다.' },
  { n: 5, t: '러프컷으로 붙이기', d: '앞 컷이 끝난 자세에서 다음 컷이 시작되면 하나의 흐름으로 읽힙니다.' },
  { n: 6, t: '모자란 컷만 채우기', d: '새 장면이 필요할 때만 생성하거나 실촬영합니다.' },
];

export default function VideoProposalPage() {
  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1000px]">
      <PageHeader
        title="영상 스토리보드 제안"
        desc="어떤 방식으로 영상을 만들 것인가 — 2026.09.09 에 두 방식을 실제로 돌려보고 정리한 것입니다."
      />

      {/* 결론 먼저 */}
      <div className="card p-4 mb-5" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-dim)' }}>
        <div className="text-[13px] font-bold mb-1.5">결론 — 보유한 검증 컷에서 출발합니다</div>
        <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          시나리오를 먼저 쓰고 그림을 만드는 방식은 영상 소재로는 쓰지 않습니다.
          영상 모델은 주어진 그림을 <b>움직이게 할 뿐, 틀린 그림을 고쳐주지 않습니다</b>.
          우리는 제품 형태·얼굴·조명이 이미 맞는 생성컷을 121장 (갤러리 전체 270장) 갖고 있습니다.
        </div>
      </div>

      {/* 근거 */}
      <h2 className="h-section mb-3">왜 그렇게 정했나 — 같은 날 비교</h2>
      <div className="card overflow-x-auto mb-6">
        <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse', minWidth: 520 }}>
          <thead>
            <tr style={{ background: 'var(--surface-2)' }}>
              <th className="label text-left px-3 py-2">방식</th>
              <th className="label text-left px-3 py-2">결과</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderTop: '1px solid var(--line)' }}>
              <td className="px-3 py-2.5">시나리오 → 프레임 자동 생성 → 영상</td>
              <td className="px-3 py-2.5" style={{ color: 'var(--danger)' }}>
                얼굴이 전속 모델이 아니고 제품 형태가 틀림 — <b>다시 뽑아야 함</b>
              </td>
            </tr>
            <tr style={{ borderTop: '1px solid var(--line)' }}>
              <td className="px-3 py-2.5"><b>검증된 컷 → 영상</b></td>
              <td className="px-3 py-2.5" style={{ color: 'var(--ok)' }}>
                <b>바로 쓸 수 있는 클립</b> — 5초 · 8.75 크레딧
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* 흐름 */}
      <h2 className="h-section mb-3">제작 흐름</h2>
      <div className="flex flex-col gap-2 mb-6">
        {FLOW.map((s) => (
          <div key={s.n} className="card p-3.5 flex gap-3">
            <div className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-extrabold"
                 style={{ background: 'var(--accent)', color: '#fff' }}>{s.n}</div>
            <div className="min-w-0">
              <div className="text-[12.5px] font-bold">{s.t}</div>
              <div className="text-[11.5px] mt-0.5 leading-relaxed" style={{ color: 'var(--text-dim)' }}>{s.d}</div>
            </div>
          </div>
        ))}
      </div>

      {/* 실제 사례 */}
      <h2 className="h-section mb-3">실제로 이렇게 나왔습니다</h2>
      <div className="card p-4 mb-6">
        <div className="text-[11.5px] font-mono leading-relaxed mb-2" style={{ color: 'var(--text-dim)' }}>
          소스 &nbsp; Support 네이비 · 여성B 컷 한 장<br />
          &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;↓ 같은 원본에서 9:16 으로 두 번 자름<br />
          컷 A &nbsp; 와이드 — 창밖을 보다 어깨가 내려앉으며 기댄다<br />
          컷 B &nbsp; 타이트 — 눈을 감고 숨을 내쉬며 미소<br />
          &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;↓ 컷당 5초<br />
          결과 &nbsp; 10초 · 17.5 크레딧 · 인물과 톤이 완전히 동일
        </div>
        <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
          같은 원본을 잘라 쓰기 때문에 컷이 바뀌어도 얼굴·조명·제품이 어긋나지 않습니다.
          이게 이 방식의 가장 큰 이점입니다.
        </div>
      </div>

      {/* 규칙 */}
      <h2 className="h-section mb-3">지켜야 할 규칙</h2>
      <div className="grid gap-3 mb-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <div className="card p-3.5">
          <div className="text-[12.5px] font-bold mb-2" style={{ color: 'var(--ok)' }}>이렇게 합니다</div>
          {RULES_DO.map(([t, d], i) => (
            <div key={t} className="py-1.5" style={{ borderTop: i ? '1px solid var(--line)' : undefined }}>
              <div className="text-[12px] font-semibold">{t}</div>
              <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>{d}</div>
            </div>
          ))}
        </div>
        <div className="card p-3.5">
          <div className="text-[12.5px] font-bold mb-2" style={{ color: 'var(--danger)' }}>이건 피합니다</div>
          {RULES_DONT.map(([t, d], i) => (
            <div key={t} className="py-1.5" style={{ borderTop: i ? '1px solid var(--line)' : undefined }}>
              <div className="text-[12px] font-semibold">{t}</div>
              <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>{d}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card p-4 mb-6">
        <div className="text-[12.5px] font-bold mb-1">형태가 변하는 순간은 컷 전환으로 넘깁니다</div>
        <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          서 있다가 앉는 과정을 한 컷에 담지 말고, <b>「서 있다」</b>와 <b>「이미 앉아 있다」</b>를 하드컷으로 잇습니다.
          보는 사람이 그 사이를 알아서 채웁니다. 실사 CF 편집에서 늘 쓰는 방식이고,
          각 컷 안에서 빈백이 변하지 않으니 AI 가 해냅니다.
        </div>
      </div>

      {/* 시나리오 기능의 역할 */}
      <h2 className="h-section mb-3">시나리오 기능은 역할을 바꿉니다</h2>
      <div className="card p-4 mb-6">
        <div className="text-[12px] leading-relaxed mb-2" style={{ color: 'var(--text-dim)' }}>
          <Link href="/video" className="underline" style={{ color: 'var(--accent)' }}>영상 스토리보드</Link>
          의 시나리오 컷 분할은 <b>컷을 나누는 일은 잘 합니다</b> — 15초를 8컷으로 리듬까지 맞춰 나눴습니다.
          다만 그 컷의 <b>그림을 만드는 건</b> 못 합니다. 그래서 이렇게 씁니다:
        </div>
        <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text)' }}>
          · <b>기획·승인용 문서</b> — &ldquo;이런 영상입니다&rdquo; 를 보여주고 컨펌받는 용도<br />
          · <b>컷 설계 도구</b> — 몇 컷을 몇 초씩 어떤 카메라로 갈지 정하고, 그림은 갤러리에서 골라 채웁니다
        </div>
      </div>

      {/* 한 번 해두면 계속 쓰는 것 */}
      <h2 className="h-section mb-3">한 번 해두면 계속 쓰는 일</h2>
      <div className="grid gap-3 mb-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <div className="card p-3.5">
          <div className="text-[12.5px] font-bold mb-1">AI 가 못 하는 컷을 실촬영으로</div>
          <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
            몸이 빠져드는 순간, 원단 클로즈업, 사람 옆 스케일 컷, 로고·택.
            <b> 한 번 찍으면 모든 CF 에서 재사용됩니다.</b> 매번 AI 로 시도해 실패하는 것보다 쌉니다.
          </div>
        </div>
        <div className="card p-3.5">
          <div className="text-[12.5px] font-bold mb-1">좋은 시작 프레임을 쌓기</div>
          <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
            잘 나온 컷이 곧 영상 소재입니다. 이미지를 생성할 때
            <b> &ldquo;영상 시작 프레임으로 쓸 만한가&rdquo;</b> 를 기준에 넣으면 자산이 쌓입니다.
          </div>
        </div>
      </div>

      {/* 앱에 필요한 것 */}
      <h2 className="h-section mb-3">앱에 필요한 것 (우선순위 순)</h2>
      <div className="card mb-6">
        {[
          ['갤러리에서 컷을 골라 영상 요청으로 넘기기', '지금은 스토리보드를 새로 짜야만 합니다'],
          ['한 컷에서 와이드·미디엄·클로즈업 잘라내기', '지금은 수동으로 자르고 있습니다'],
          ['컷 전환 확인', '앞 컷의 끝과 다음 컷의 시작을 나란히 보기'],
          ['AI 실패 위험 경고', '형태 변형·손동작이 들어간 컷에 표시'],
        ].map(([t, d], i) => (
          <div key={t} className="p-3.5 flex gap-3" style={{ borderTop: i ? '1px solid var(--line)' : undefined }}>
            <span className="shrink-0 text-[12px] font-extrabold" style={{ color: 'var(--accent)' }}>{i + 1}</span>
            <div>
              <div className="text-[12.5px] font-bold">{t}</div>
              <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--text-mute)' }}>{d}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="text-[11.5px] mb-6" style={{ color: 'var(--text-mute)' }}>
        1·2 번만 있어도 지금 손으로 하는 작업을 화면에서 그대로 할 수 있습니다.
      </div>

      <div className="card p-4" style={{ borderColor: 'var(--warn)' }}>
        <div className="text-[12.5px] font-bold mb-1" style={{ color: 'var(--warn)' }}>아직 답이 없는 것</div>
        <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          · 컷 전환을 도구에서 어떻게 다룰지 — 지금은 컷을 따로 만들고 사이를 보지 않습니다<br />
          · 실촬영을 언제 한 번 잡을지<br />
          · 한국 시장 데이터가 없습니다. 위 기준은 미국·글로벌 플랫폼 자료라, 국내에서 어떻게 작동하는지는 자사 A/B 로만 알 수 있습니다
        </div>
      </div>
    </div>
  );
}
