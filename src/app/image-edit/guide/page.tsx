import Link from 'next/link';
import PageHeader from '@/components/PageHeader';

export const dynamic = 'force-dynamic';

/**
 * 포토샵 AI 사용설명서 — 「포토샵」 화면의 AI 기능 여섯 가지를 처음 쓰는 사람도 따라 할 수 있게 글로 적은 것.
 * 사용자 요청 2026-10-14: "포토샵 AI 사용설명서라고 해서 · 포토샵 아래에다가 사용설명서를 넣어주고 · 글로 작성까지만".
 * 기능 이름은 포토샵(Firefly) 한국어판과 같게 맞췄다. 처리 방식은 src/app/api/image-edit/ai/route.ts.
 */

const BASICS = [
  { t: '그림 열기', d: '위쪽 「갤러리에서 불러오기」로 생성이미지 갤러리의 컷을 고르거나, 「내 PC에서 열기」로 PC 의 그림을 엽니다. 포토샵 안의 탭에 새 문서로 열립니다.' },
  { t: '고칠 문서 고르기', d: 'AI 는 지금 보고 있는 탭의 그림에 씁니다. 여러 그림을 열어 두었다면 고칠 탭을 먼저 눌러 두세요.' },
  { t: 'AI 버튼 누르기', d: '위쪽 「AI」 줄에서 기능을 고르면 지금 그림을 가져와 AI 창이 열립니다(포토샵 안의 레이어는 한 장으로 합쳐서 가져옵니다).' },
  { t: '실행하고 고르기', d: '변형을 1~3장 고르고 실행합니다. 30초~2분 뒤 결과가 나오면 마음에 드는 것의 「열기」를 누릅니다. 결과는 새 탭으로 열리고 원래 그림은 그대로 남습니다.' },
  { t: '저장', d: '「저장 · 내보내기」에서 PNG·JPG·PSD 로 내려받거나 「갤러리에 저장」으로 생성이미지 갤러리에 새 컷으로 남깁니다. 자동 저장이 없으니 다른 메뉴로 가기 전에 꼭 저장하세요.' },
];

/* 화면 그림은 public/image-edit-guide/ — 2026-10-14 시험 화면(실행 전 설정 단계, 비용 0). 사용자: "이들은 시각적으로 보여줘야 아 하는 사람들이라" */
/* 예시 그림(ex_*) = 실제 AI 결과 — 여성B 수영장 컷(2026-10-14). 배경 생성·배경 제거는 이 사진에서 수영장까지 남겨 결과가 어색해 넣지 않았다 */
const TOOLS: { name: string; ps: string; img: string; ex?: string; exNote?: string; when: string; how: string[]; tip: string }[] = [
  {
    name: '생성형 채우기', ps: 'Generative Fill', img: 'fill', ex: 'fill', exNote: '왼쪽 위 물 위를 칠하고 「수영장 물 위에 떠 있는 노란 튜브」라고 적었습니다.',
    when: '사진의 한 부분에 물건을 더하거나 다른 것으로 바꿀 때 (예: 빈 탁자 위에 화분, 벽에 액자)',
    how: [
      '「붓」이나 「상자」로 바꿀 곳을 칠합니다. 물건이 들어갈 자리보다 조금 넉넉하게 칠하세요.',
      '「무엇을 그릴까요」에 그릴 것을 적습니다. 예: 「창가에 놓인 몬스테라 화분」.',
      '특정 물건을 그대로 넣고 싶으면 「참조 이미지」에 그 사진을 넣습니다(갤러리 또는 PC).',
      '아무것도 적지 않고 실행하면 칠한 곳을 지웁니다(제거 도구와 같음).',
    ],
    tip: '칠한 곳 밖은 원본 픽셀 그대로 돌아옵니다 — 얼굴·제품이 칠한 곳 밖에 있으면 바뀌지 않습니다.',
  },
  {
    name: '제거 도구', ps: 'Remove Tool', img: 'remove', ex: 'remove', exNote: '오른쪽 위 화분을 칠했습니다 — 화분이 사라지고 뒤의 벽·잔디가 이어졌습니다.',
    when: '사진 속 필요 없는 물건·사람·얼룩을 지울 때',
    how: [
      '지울 것을 붓으로 넉넉하게 덮어 칠합니다(그림자까지 함께 칠하면 더 깨끗합니다).',
      '실행하면 칠한 곳만 뒤 배경(바닥·벽·가구)으로 이어 채웁니다.',
    ],
    tip: '큰 물건은 한 번에, 작은 것 여러 개는 따로따로 지우면 결과가 더 안정적입니다.',
  },
  {
    name: '조화 (합성)', ps: 'Harmonize', img: 'harmonize', ex: 'harmonize', exNote: '왼쪽 데크 위에 요기보 제품 누끼를 얹었습니다 — 데크의 빛과 그림자에 맞춰 자연스럽게 앉혔습니다.',
    when: '누끼 딴 제품이나 사람을 다른 사진에 얹고, 원래 그 자리에서 찍은 것처럼 맞출 때',
    how: [
      '「합성할 이미지」에서 갤러리나 PC 의 그림을 고릅니다. 배경이 투명한 PNG 누끼가 가장 자연스럽습니다.',
      '작업판에서 끌어서 자리를 잡고, 크기 막대(또는 마우스 휠)로 크기를 맞춥니다. 필요하면 「좌우 뒤집기」.',
      '실행하면 조명 방향·색온도·밝기·그림자(바닥에 닿는 그림자 포함)·가장자리를 장면에 맞춥니다.',
    ],
    tip: '제품 모양·색은 바꾸지 말라고 지시합니다. 그래도 결과에서 제품 형태를 꼭 한 번 확인하세요.',
  },
  {
    name: '생성형 확장', ps: 'Generative Expand', img: 'expand', ex: 'expand', exNote: '정사각 사진을 9:16 세로로 늘렸습니다 — 위·아래로 늘어난 부분이 AI 가 새로 그린 곳입니다.',
    when: '가로 사진을 세로(9:16)로, 정사각(1:1)으로 바꾸는 등 캔버스를 넓힐 때',
    how: [
      '「새 비율」을 고르고, 「원본을 둘 자리」(위·가운데·아래 / 왼쪽·오른쪽)를 고릅니다.',
      '바깥에 무엇을 그릴지 적어도 됩니다(비워 두면 장면을 자연스럽게 이어 그립니다).',
    ],
    tip: '원본이 있던 자리는 원본 그대로 되붙입니다 — 늘어난 바깥 부분만 새로 그려집니다.',
  },
  {
    name: '배경 생성', ps: 'Generate Background', img: 'background',
    when: '사람·제품은 그대로 두고 배경만 다른 장소로 바꿀 때',
    how: [
      '남길 피사체(사람·제품)를 붓으로 빠짐없이 칠합니다.',
      '「새 배경」에 장소를 적습니다. 예: 「햇살 드는 밝은 거실, 원목 바닥」.',
      '실행하면 칠한 피사체는 원본 그대로 두고 나머지 배경을 새로 그립니다.',
    ],
    tip: '피사체의 가장자리(머리카락·손끝·제품 모서리)까지 칠해야 테두리가 깔끔합니다.',
  },
  {
    name: '배경 제거', ps: 'Remove Background', img: 'cutout',
    when: '사람·제품만 남기고 배경을 투명하게 만든 PNG 가 필요할 때',
    how: ['버튼을 누르고 실행만 하면 됩니다. 결과는 투명 배경 PNG 로 새 탭에 열립니다.'],
    tip: '시험 기능입니다 — 머리카락 같은 가는 가장자리는 거칠 수 있습니다. 제품 누끼는 드롭박스의 스튜디오 원본이 더 정확합니다.',
  },
];

export default function PhotoshopAiGuidePage() {
  return (
    <div className="p-4 sm:p-6 2xl:p-8 max-w-[1000px]">
      <PageHeader
        title="포토샵 AI 사용설명서"
        desc="「포토샵」 화면의 AI 기능 여섯 가지를 쓰는 법입니다. 기능 이름은 포토샵(Firefly) 한국어판과 같습니다."
        right={<Link href="/image-edit" className="btn btn-primary text-[12px]">포토샵 열기</Link>}
      />

      <div className="card p-4 mb-5" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-dim)' }}>
        <div className="text-[13px] font-bold mb-1.5">먼저 알아 둘 것</div>
        <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          · AI 는 <b>칠하거나 고른 곳만</b> 바꾸고, 나머지는 원본 픽셀을 그대로 되붙입니다 — 얼굴·제품이 선택 밖에 있으면 바뀌지 않습니다.<br />
          · 결과는 항상 <b>새 탭</b>으로 열립니다. 원래 그림은 그대로 남으니 마음에 안 들면 그 탭을 닫으면 됩니다.<br />
          · 자동 저장이 없습니다. 끝나면 「저장 · 내보내기」로 꼭 저장하세요.
        </div>
      </div>

      <h2 className="h-section mb-3">화면 둘러보기</h2>
      <figure className="card p-2 mb-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/image-edit-guide/overview.jpg" alt="포토샵 화면 — 위쪽 도구줄과 그 아래 편집기" className="w-full h-auto rounded-[6px]" loading="lazy" />
        <figcaption className="text-[11.5px] mt-2 px-1 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          맨 위 한 줄이 우리 도구줄입니다 — 왼쪽부터 <b>갤러리에서 불러오기 · 내 PC에서 열기 · 저장 · 내보내기</b>, 그리고 <b>AI</b> 기능 여섯 개.
          그 아래가 포토샵 편집기(레이어·선택·붓·보정)이고, 열린 그림은 편집기 위쪽 탭에 하나씩 쌓입니다.
        </figcaption>
      </figure>
      <figure className="card p-2 mb-7">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/image-edit-guide/picker.jpg" alt="생성이미지 갤러리에서 불러오기 창" className="w-full max-w-[640px] h-auto rounded-[6px] mx-auto block" loading="lazy" />
        <figcaption className="text-[11.5px] mt-2 px-1 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          「갤러리에서 불러오기」를 누르면 생성이미지 갤러리의 최근 컷이 뜹니다. 제목으로 찾고, 누르면 편집기에 새 탭으로 열립니다.
        </figcaption>
      </figure>

      <h2 className="h-section mb-3">기본 순서</h2>
      <div className="flex flex-col gap-2 mb-7">
        {BASICS.map((s, i) => (
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

      <h2 className="h-section mb-3">선택 영역 칠하기 (채우기 · 제거 · 배경 생성)</h2>
      <div className="card p-4 mb-7 text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
        · <b>붓</b>: 끌면서 칠합니다. 붓 크기는 막대로, 또는 키보드 <b>[ ]</b> 로 줄이고 키웁니다(포토샵과 같은 키).<br />
        · <b>상자</b>: 끌어서 네모로 칠합니다. 여러 번 칠하면 더해집니다.<br />
        · <b>선택 지우기</b>: 칠한 것을 모두 지우고 다시 시작합니다.<br />
        · 칠하는 색은 기능마다 다릅니다 — 채우기 파랑, 제거 빨강, 배경 생성(남길 피사체) 초록.
      </div>

      <h2 className="h-section mb-3">기능별 쓰는 법</h2>
      <div className="flex flex-col gap-3 mb-7">
        {TOOLS.map((t) => (
          <div key={t.name} className="card p-4">
            <div className="flex items-baseline gap-2 flex-wrap mb-1">
              <div className="text-[14px] font-bold">{t.name}</div>
              <span className="chip">포토샵: {t.ps}</span>
            </div>
            <div className="text-[12px] mb-2" style={{ color: 'var(--text-mute)' }}>언제 — {t.when}</div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/image-edit-guide/${t.img}.jpg`} alt={`${t.name} 창 — 설정하는 모습`} loading="lazy"
                 className="w-full h-auto rounded-[6px] mb-2.5" style={{ border: '1px solid var(--line)' }} />
            <ol className="text-[12.5px] leading-relaxed list-decimal pl-5 mb-2">
              {t.how.map((h) => <li key={h}>{h}</li>)}
            </ol>
            <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>💡 {t.tip}</div>
            {t.ex && (
              <div className="mt-3">
                <div className="label mb-1.5">실제 예시</div>
                <div className="grid grid-cols-2 gap-2">
                  {(['before', 'after'] as const).map((k) => (
                    <figure key={k} className="min-w-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/image-edit-guide/ex_${t.ex}_${k}.jpg`} alt={`${t.name} ${k === 'before' ? '원본' : '결과'}`} loading="lazy"
                           className="w-full h-auto rounded-[6px]" style={{ border: '1px solid var(--line)', background: 'var(--surface-2)' }} />
                      <figcaption className="text-[11px] mt-1 text-center" style={{ color: 'var(--text-mute)' }}>{k === 'before' ? '원본 (선택한 곳 표시)' : '결과'}</figcaption>
                    </figure>
                  ))}
                </div>
                {t.exNote && <div className="text-[11.5px] mt-1.5" style={{ color: 'var(--text-dim)' }}>{t.exNote}</div>}
              </div>
            )}
          </div>
        ))}
      </div>

      <h2 className="h-section mb-3">결과 고르기 · 저장</h2>
      <div className="card p-4 mb-7 text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
        · 「변형」에서 1~3장을 고를 수 있습니다. 포토샵처럼 여러 장을 받아 그중 하나를 고르는 방식입니다.<br />
        · 결과 아래 「열기」를 누르면 그 장이 새 탭으로 열립니다. 「모두 열기」로 한꺼번에 열어 비교할 수도 있습니다.<br />
        · 위 화면들은 실행 전 설정 단계입니다. 실행하면 창 오른쪽 아래에 결과가 변형 수만큼 나타납니다.<br />
        · 갤러리에서 불러온 그림은 AI 를 거쳐도 원래 컷을 기억합니다 — 「갤러리에 저장」하면 원래 컷의 제품·색·모델 정보를 이어받은 새 컷이 됩니다.
      </div>

      <div className="card p-4" style={{ borderColor: 'var(--warn)' }}>
        <div className="text-[12.5px] font-bold mb-1" style={{ color: 'var(--warn)' }}>알아 둘 한계</div>
        <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          · AI 는 선택 안쪽을 새로 그리므로, 선택 안에 얼굴이 있으면 얼굴이 달라질 수 있습니다 — 얼굴은 선택 밖에 두세요.<br />
          · 제품 모양은 바꾸지 말라고 지시하지만 AI 라 완벽하지 않습니다. 저장 전에 제품 형태를 꼭 확인하세요.<br />
          · 한 번에 2048px 안의 크기로 처리합니다. 그보다 큰 그림은 줄여서 처리됩니다.<br />
          · 포토샵 프로그램(PhotoCraft)은 초기 버전이라 메뉴가 영어이고, 한글 글자는 글꼴을 「Pretendard Variable」로 골라야 보입니다.
        </div>
      </div>
    </div>
  );
}
