/**
 * 컷 분할 스토리 시트 — 영상 제작 요청서의 뼈대.
 *
 * 앱은 "무엇을 찍을지"까지만 정한다. 실제 렌더는 오너가 힉스필드에서 돌리고
 * 결과 영상을 다시 등록한다 (이미지 대기열과 같은 흐름 — 앱 키에는 크레딧이 없다).
 *
 * 각 컷은 사람이 읽는 시트(장면·카메라)와 그대로 힉스필드에 넣을 수 있는
 * 영어 프롬프트를 함께 갖는다. 시트를 고치면 프롬프트도 같이 고쳐진다.
 */

export type VideoPurpose = 'product' | 'review' | 'event';

export interface Shot {
  no: number;
  seconds: number;
  /** 장면 — 한글로 무엇을 보여줄지. 이 글이 그대로 스틸 생성 지시가 된다. */
  scene: string;
  /** 카메라 움직임 */
  camera: string;
  /** 이 컷에서 일어나는 동작 — 시작에서 끝으로 무엇이 바뀌는가. 끝 프레임 생성 지시가 된다. */
  action?: string;
  /** 나레이션·대사 — 영상 생성에는 넣지 않는다(엔진이 한국어 대사를 못 만든다). 편집용 지시. */
  narration?: string;
  /** 효과음 — 마찬가지로 편집용 */
  sfx?: string;
  /** 시작 프레임 (START FRAME) */
  image?: string;
  imageTitle?: string;
  /** 끝 프레임 (END FRAME) — 시작에서 파생해 만든다. 두 장 사이를 엔진이 채운다. */
  endImage?: string;
  endImageTitle?: string;
  /**
   * 이 컷의 완성 영상.
   * 제작은 대화(힉스필드 MCP)에서 돌고, 완성된 클립 주소를 여기 달아 콘티에 붙인다 —
   * 그래야 "어느 컷이 나왔고 어느 컷이 남았는지"가 콘티 위에서 바로 보인다.
   * cafe24 는 .mp4 를 막으므로 .jpg 로 위장 저장되고 재생은 /api/video 프록시가 맡는다.
   */
  clip?: string;
  clipNote?: string;
  /**
   * 앞 컷의 스틸을 배경 레퍼런스로 물려서 만든다.
   * 켜면 방·조명·컬러 그레이드가 이어져 컷 사이 톤이 흔들리지 않는다
   * (컷을 따로 뽑아 톤 보정으로 메우던 일을 없애는 게 목적).
   */
  chain?: boolean;
}

export interface StoryboardInput {
  purpose: VideoPurpose;
  /** 총 길이(초) — 컷 길이의 합이 여기 맞춰진다 */
  total: number;
  productLabel: string;   // 예: "Max 네이비블루"
  modelLabel: string;     // 예: "여성B" / '' 이면 인물 없음
}

export const PURPOSES: { value: VideoPurpose; label: string; desc: string }[] = [
  { value: 'product', label: '제품 소개', desc: '형태·크기·색을 보여주고 앉는 순간으로 마무리' },
  { value: 'review', label: '사용 후기', desc: '일상 장면 속에서 편안함을 보여주는 연출' },
  { value: 'event', label: '이벤트·프로모션', desc: '분위기를 빠르게 훑고 혜택 문구로 마무리' },
];

export const CAMERA_MOVES = [
  '고정 (움직임 없음)',
  '천천히 들어가기 (푸시 인)',
  '천천히 물러나기 (풀 백)',
  '왼쪽에서 오른쪽으로 (팬)',
  '아래에서 위로 (틸트 업)',
  '제품 주위를 도는 궤도 (오빗)',
  '손에 든 듯 가볍게 흔들림',
];

/** 카메라 한글 → 힉스필드에 넣을 영어 */
const CAMERA_EN: Record<string, string> = {
  '고정 (움직임 없음)': 'locked-off static shot, no camera movement',
  '천천히 들어가기 (푸시 인)': 'slow push-in toward the subject',
  '천천히 물러나기 (풀 백)': 'slow pull-back revealing the room',
  '왼쪽에서 오른쪽으로 (팬)': 'smooth pan from left to right',
  '아래에서 위로 (틸트 업)': 'gentle tilt up from the floor to the subject',
  '제품 주위를 도는 궤도 (오빗)': 'slow orbit around the product',
  '손에 든 듯 가볍게 흔들림': 'subtle handheld motion, natural micro-shake',
};

/** 용도별 컷 뼈대 — 사람이 고쳐 쓰는 출발점 */
export function draftShots(i: StoryboardInput): Shot[] {
  const who = i.modelLabel || '인물 없이';
  const p = i.productLabel || '제품';
  const per = (n: number) => Math.max(2, Math.round((i.total / n) * 10) / 10);

  if (i.purpose === 'review') {
    const s = per(3);
    return [
      { no: 1, seconds: s, scene: `${who}가 방으로 들어와 ${p} 쪽으로 걸어온다`, camera: '손에 든 듯 가볍게 흔들림' },
      { no: 2, seconds: s, scene: `${p}에 앉으며 몸이 폭 잠기는 순간 — 표정이 편안해진다`, camera: '천천히 들어가기 (푸시 인)' },
      { no: 3, seconds: s, scene: `${who}가 책을 보거나 쉬는 일상 장면, 방 전체가 함께 보인다`, camera: '천천히 물러나기 (풀 백)' },
    ];
  }
  if (i.purpose === 'event') {
    const s = per(3);
    return [
      { no: 1, seconds: s, scene: `${p}가 놓인 공간을 빠르게 훑는다`, camera: '왼쪽에서 오른쪽으로 (팬)' },
      { no: 2, seconds: s, scene: `${who} 사람이 앉아 쉬는 모습 (인물 없으면 제품 클로즈업)`, camera: '천천히 들어가기 (푸시 인)' },
      { no: 3, seconds: s, scene: '제품 전체가 보이는 마무리 컷 — 문구가 놓일 여백을 남긴다', camera: '고정 (움직임 없음)' },
    ];
  }
  const s = per(4);
  return [
    { no: 1, seconds: s, scene: `${p}만 놓인 방 전경 — 크기와 형태가 한눈에 보인다`, camera: '천천히 들어가기 (푸시 인)' },
    { no: 2, seconds: s, scene: `${p}의 원단·재봉선이 보이는 가까운 컷`, camera: '제품 주위를 도는 궤도 (오빗)' },
    { no: 3, seconds: s, scene: `${who}가 앉으며 몸이 잠기는 순간`, camera: '고정 (움직임 없음)' },
    { no: 4, seconds: s, scene: '편안하게 기댄 상태로 마무리, 공간이 함께 보인다', camera: '천천히 물러나기 (풀 백)' },
  ];
}

/** 컷의 시작 시각 — 앞 컷들의 길이를 더해서 구한다 */
export function timeLabel(shots: Shot[], i: number): string {
  const mmss = (sec: number) => {
    const t = Math.max(0, Math.round(sec));
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  const from = shots.slice(0, i).reduce((a, x) => a + (Number(x.seconds) || 0), 0);
  return `${mmss(from)}-${mmss(from + (Number(shots[i]?.seconds) || 0))}`;
}

/**
 * 끝 프레임을 만들 때의 지시.
 *
 * 시작 프레임을 base 레퍼런스로 넣고 부르면 프롬프트 작성기가
 * "베이스를 그대로 재현하고 아래 지정한 것만 바꿔라"로 조립한다. 그래서 여기엔
 * '무엇이 바뀌는가'만 적는다 — 인물·방·옷·앵글은 건드리지 말라고 못박는다.
 */
export function endDirection(s: Shot): string {
  return [
    `같은 인물, 같은 공간, 같은 옷, 같은 카메라 각도 그대로입니다. 몇 초 뒤의 순간만 담습니다.`,
    `바뀌는 것: ${s.action?.trim() || s.scene}`,
    '얼굴·머리·의상·가구 배치·조명은 시작 프레임과 완전히 같아야 합니다. 동작과 시선만 달라집니다.',
    '화면에 글자·자막·로고 오버레이는 넣지 마세요.',
  ].join('\n');
}

/**
 * 컷 하나의 스틸을 만들 때 /api/generate 에 넘길 한글 연출 지시.
 *
 * 제품·모델은 payload 의 line/colorKey/talents 로 따로 들어가므로 여기 다시 쓰지 않는다.
 * (프롬프트 작성기가 제품 형태·컬러·얼굴 락을 알아서 붙인다.)
 */
export function sceneDirection(s: Shot, aspect: string): string {
  const cam = CAMERA_EN[s.camera] ?? s.camera;
  return [
    s.scene,
    `이 장면은 ${aspect} 영상의 시작 프레임입니다 — 곧이어 "${cam}" 카메라 움직임이 이어집니다.`,
    '그 움직임이 들어갈 여백을 남기고, 실제 공간 사진처럼 자연스럽게 담아주세요.',
    '화면에 글자·자막·로고 오버레이는 넣지 마세요.',
  ].join('\n');
}

/**
 * 컷 하나를 힉스필드용 영어 프롬프트로.
 * 첫 프레임 이미지가 있으므로 "이 사진에서 시작해 이렇게 움직인다"로 쓴다.
 */
export function shotPrompt(s: Shot, i: StoryboardInput, aspect: string): string {
  const cam = CAMERA_EN[s.camera] ?? s.camera;
  return [
    s.endImage
      // 두 장을 주면 엔진은 그 사이만 채운다 — 말로 설명하는 것보다 훨씬 정확하다
      ? `Animate from the supplied START frame to the supplied END frame as one continuous ${s.seconds}s ${aspect} shot. Interpolate the motion naturally between them; do not invent action beyond what the two frames imply.`
      : `Start from the supplied still and animate it as a ${s.seconds}s ${aspect} product video shot.`,
    `SCENE: ${s.scene}`,
    s.action?.trim() ? `ACTION: ${s.action.trim()}` : '',
    `CAMERA: ${cam}.`,
    i.productLabel ? `PRODUCT: Yogibo ${i.productLabel} — keep its exact shape, colour and proportions; it must not deform, wobble unnaturally or change colour.` : '',
    i.modelLabel ? `PERSON: keep the same person throughout — same face, hair and outfit as the still; natural, unexaggerated movement.` : 'No people appear in this shot.',
    'Keep the room, lighting and colour grade of the still. Photorealistic, calm commercial pacing.',
    'NO TEXT of any kind burned into the frames — captions are added later in editing.',
  ].filter(Boolean).join('\n');
}
