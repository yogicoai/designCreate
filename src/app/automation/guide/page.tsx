import Link from 'next/link';
import PageHeader from '@/components/PageHeader';

export const dynamic = 'force-dynamic';

/**
 * SNS 자동화 사용 설명서.
 *
 * MD·마케터가 혼자 보고 따라 할 수 있어야 한다 — 내가 옆에 없어도 돌아가야 하는 화면이라
 * "무엇을 준비하고, 무엇을 누르고, 무엇을 확인하는지"까지 적는다.
 */

const STEPS = [
  {
    n: 1,
    title: '레퍼런스를 폴더에 넣는다',
    who: '관리자',
    body: (
      <>
        SNS 자동화가 쓸 <b>예제 사진</b>을{' '}
        <Link href="/references" className="underline" style={{ color: 'var(--accent)' }}>자산관리 &gt; 레퍼런스</Link>
        에 올리고 분류를 <b>인스타그램</b> 또는 <b>촬영</b>으로 지정합니다.
        이 두 분류에 있는 사진만 자동화 후보가 됩니다.
        <div className="mt-1.5" style={{ color: 'var(--text-mute)' }}>
          촬영(실제 촬영본) 쪽이 결과가 더 좋습니다 — 실제 사람이 앉아 눌린 형태가 그대로 살아 있어서입니다.
        </div>
      </>
    ),
  },
  {
    n: 2,
    title: '오늘 만들 장수를 정하고 뽑는다',
    who: '누구나',
    body: (
      <>
        <b>오늘 만들 장수</b>(기본 5장)를 정하고 <b>🎲 뽑기</b>를 누르면, 폴더에서 그 수만큼
        사진이 <b>랜덤</b>으로 뽑히고 각 사진에 <b>전속 모델이 자동 배정</b>됩니다.
        <div className="mt-1.5" style={{ color: 'var(--text-mute)' }}>
          한 번 쓴 사진은 다시 나오지 않습니다 — 확정·완료된 컷은 이후 추첨에서 영구 제외됩니다.
        </div>
      </>
    ),
  },
  {
    n: 3,
    title: '카드마다 검수한다',
    who: '누구나',
    body: (
      <>
        생성 전에 카드를 하나씩 봅니다. 마음에 들면 <b>👍</b>, 사진이 별로면 <b>🔄</b>,
        모델만 바꾸고 싶으면 <b>🎲</b> 입니다.
        <div className="mt-1.5">
          <b>인원</b>은 <b>원본 사진 속 사람 수에 맞춰</b> 주세요. 지정 인원이 더 적으면 나머지 사람은 지워지고,
          더 많으면 없던 사람이 새로 그려집니다.
        </div>
      </>
    ),
  },
  {
    n: 4,
    title: '실행하고 갤러리에서 확인한다',
    who: '누구나',
    body: (
      <>
        <b>▶ 실행</b>을 누르면 카드 순서대로 생성됩니다. 완성된 컷은{' '}
        <Link href="/automation/gallery" className="underline" style={{ color: 'var(--accent)' }}>자동화 생성이미지</Link>
        에 자동 등록됩니다 — 일반 생성이미지 갤러리와 섞이지 않게 따로 관리됩니다.
      </>
    ),
  },
];

const MODES = [
  {
    tag: '인물컷',
    engine: '제미나이 (나노바나나)',
    color: 'var(--accent)',
    what: '원본 사진 속 사람을 우리 전속 모델로 바꿉니다.',
    how: '인원을 1~3 으로 두면 됩니다 (기본값).',
    why: '얼굴 아이덴티티가 걸린 작업이라 얼굴 유지력이 검증된 제미나이로 갑니다. 서버가 해상도를 자동으로 올려 얼굴 픽셀을 지킵니다.',
  },
  {
    tag: '제품컷',
    engine: 'GPT',
    color: 'var(--info)',
    what: '인물 없이, 그 사진의 공간·조명만 빌려 우리 빈백을 얹습니다.',
    how: '카드의 📦 제품 버튼을 누르면 제품과 컬러가 랜덤으로 정해집니다. 다시 누르면 제품만 다시 뽑습니다.',
    why: '배경 합성이 자연스러운 쪽이 GPT 입니다. 다만 제품 형태를 바꿔 놓는 일이 있어 결과의 제품 모양을 반드시 확인해야 합니다.',
  },
  {
    tag: '원본 채택',
    engine: '생성 없음',
    color: 'var(--text-mute)',
    what: '원본 사진을 그대로 씁니다.',
    how: '인원을 0 으로 둡니다.',
    why: '이미 완성도 높은 컷은 손대지 않는 게 낫습니다. 생성이 돌지 않아 비용도 들지 않습니다.',
  },
];

const RULES = [
  ['같은 사진이 두 번 나오지 않습니다', '👍 선정했거나 완성된 컷의 원본은 이후 추첨 후보에서 영구히 빠집니다. 매일 돌려도 겹치지 않습니다.'],
  ['아동 모델은 랜덤에 안 섞입니다', '아동 모델이 아무 SNS 컷에나 무작위로 들어가면 안 되므로, 랜덤 배정은 성인만 합니다. 필요하면 카드에서 직접 고를 수 있습니다 (👶 표시).'],
  ['한 컷에 모델은 최대 3명입니다', '그보다 많아지면 얼굴이 뭉개집니다.'],
  ['규격은 1080×1350 (4:5)', '인스타그램 피드에서 가장 크게 보이는 세로 비율로 고정돼 있습니다.'],
  ['생성 결과는 따로 관리됩니다', '자동화로 만든 컷에는 표식이 붙어 자동화 생성이미지 쪽으로만 쌓입니다.'],
];

export default function AutomationGuidePage() {
  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1100px]">
      <PageHeader
        title="SNS 자동화 설명서"
        desc="레퍼런스 폴더에 사진을 넣어두면, 그중 랜덤으로 뽑아 우리 모델·제품과 합성해 인스타그램용 컷을 만듭니다."
      />

      {/* 한 줄 흐름 — 말보다 그림으로 */}
      <div className="card p-4 mb-5" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-dim)' }}>
        <div className="text-[12.5px] font-bold mb-2.5">전체 흐름</div>
        <div className="flex items-center gap-2 flex-wrap text-[12px]">
          {['레퍼런스 폴더에 사진 추가', '랜덤 5장 뽑기', '모델·제품 배정', '검수', '생성', '자동화 갤러리'].map((s, i, a) => (
            <span key={s} className="flex items-center gap-2">
              <span className="px-2.5 py-1 rounded-lg font-semibold"
                    style={{ background: 'var(--surface)', border: '1px solid var(--line-strong)' }}>{s}</span>
              {i < a.length - 1 && <span style={{ color: 'var(--accent)' }}>→</span>}
            </span>
          ))}
        </div>
      </div>

      {/* 단계 */}
      <h2 className="h-section mb-3">따라 하기</h2>
      <div className="flex flex-col gap-2.5 mb-6">
        {STEPS.map((s) => (
          <div key={s.n} className="card p-3.5 flex gap-3">
            <div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-extrabold"
                 style={{ background: 'var(--accent)', color: '#fff' }}>{s.n}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <div className="text-[13px] font-bold">{s.title}</div>
                <span className="chip" style={{ color: 'var(--text-mute)' }}>{s.who}</span>
              </div>
              <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{s.body}</div>
            </div>
          </div>
        ))}
      </div>

      {/* 세 가지 방식 */}
      <h2 className="h-section mb-1">컷을 만드는 세 가지 방식</h2>
      <p className="text-[12px] mb-3" style={{ color: 'var(--text-dim)' }}>
        같은 인스타그램 감성을 유지하면서, 인물을 넣을지 제품만 놓을지 카드마다 고를 수 있습니다.
      </p>
      <div className="grid gap-3 mb-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        {MODES.map((m) => (
          <div key={m.tag} className="card p-3.5">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[12.5px] font-extrabold px-2 py-0.5 rounded-lg"
                    style={{ background: m.color, color: '#fff' }}>{m.tag}</span>
              <span className="chip" style={{ color: 'var(--text-mute)' }}>{m.engine}</span>
            </div>
            <div className="text-[12px] leading-relaxed mb-2">{m.what}</div>
            <div className="text-[11.5px] leading-relaxed mb-1.5" style={{ color: 'var(--accent)' }}>
              어떻게 — {m.how}
            </div>
            <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
              왜 — {m.why}
            </div>
          </div>
        ))}
      </div>

      {/* 규칙 */}
      <h2 className="h-section mb-3">알아둘 규칙</h2>
      <div className="card mb-6">
        {RULES.map(([t, d], i) => (
          <div key={t} className="p-3.5" style={{ borderTop: i ? '1px solid var(--line)' : undefined }}>
            <div className="text-[12.5px] font-bold mb-0.5">{t}</div>
            <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{d}</div>
          </div>
        ))}
      </div>

      {/* 지금 상태 */}
      <div className="card p-4" style={{ borderColor: 'var(--warn)' }}>
        <div className="text-[12.5px] font-bold mb-1" style={{ color: 'var(--warn)' }}>
          지금은 사람이 버튼을 누르는 방식입니다
        </div>
        <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          매일 자동으로 도는 예약(스케줄)은 아직 걸지 않았습니다. 지금은 담당자가 화면에서
          뽑기 → 검수 → 실행을 누르는 <b>수동 파일럿</b>입니다.
          운영 방식이 확정되면 이 실행을 그대로 예약으로 옮기면 됩니다 — 화면과 규칙은 바뀌지 않습니다.
        </div>
        <div className="mt-3">
          <Link href="/automation/sns" className="btn btn-primary">SNS 이미지 생성 열기 →</Link>
        </div>
      </div>
    </div>
  );
}
