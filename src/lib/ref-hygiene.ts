/**
 * 참조 위생 — 올린 사진이 고른 쓰임(역할)에 맞는지 (점검 2026-10-02 6번).
 *
 * 왜 필요한가: "눌린 실사는 형태 참조 금지", "참조 속 방이 배경으로 따라온다", "포즈 소스의 빈백이 통째로 옮겨진다",
 * "배경에 스튜디오 장비·인스타 테두리·벽 글자" — 전부 실측에서 나온 규칙인데 사람 머리와 코드 주석에만 있었다.
 * 태그는 자동으로 지우면서 이건 아무도 안 봤다. 사진을 한 번 읽어 두고(ref-read.ts), 역할이 정해지면 여기서 대조한다.
 *
 * 이 파일은 브라우저에서도 쓴다(생성 화면) — 서버 전용 코드를 넣지 않는다.
 */

/** 사진을 한 번 읽은 결과 — 역할과 무관한 "무엇이 찍혀 있나" */
export interface RefRead {
  /** 보이는 사람 수 */
  people: number;
  /** 사람이 빈백에 앉거나 눕거나 기대어 있다 */
  onProduct: boolean;
  /** 보이는 빈백 수 */
  beanbags: number;
  /** 빈백이 눌리거나 꺼져 있다 (사람·물건 무게로 쉬는 모양이 아니다) */
  pressed: boolean;
  /** room = 실제 방·실내 / plain = 단색·스튜디오 배경 / outdoor = 야외 */
  setting: 'room' | 'plain' | 'outdoor';
  /** 촬영 장비(조명 스탠드·소프트박스·삼각대·배경지 롤)가 보인다 */
  gear: boolean;
  /** 깨끗한 한 장의 사진이 아니다 — 캡처 화면·앱 UI·테두리·콜라주 */
  frame: boolean;
  /** 읽히는 글자가 있다 — 벽 장식 글자·간판·포스터·워터마크·자막 */
  text: boolean;
  /** 긴 변 픽셀 */
  longSide: number;
  /** 본 것을 한 줄로 */
  note: string;
}

/** 앱의 업로드 역할 3종 + 대화에서 쓰는 형태·포즈 참조 */
export type HygieneRole = 'style' | 'base' | 'background' | 'shape' | 'pose';

export interface RefWarning {
  /** warn = 결과가 망가지는 일이 실측된 것 / info = 알고 쓰면 되는 것 */
  level: 'warn' | 'info';
  text: string;
}

/** 역할에 안 맞는 점 — 없으면 빈 배열 */
export function refWarnings(role: HygieneRole, r: RefRead | null | undefined): RefWarning[] {
  if (!r) return [];
  const out: RefWarning[] = [];
  const warn = (text: string) => out.push({ level: 'warn', text });
  const info = (text: string) => out.push({ level: 'info', text });

  if (role === 'background') {
    if (r.people > 0) warn(`배경 사진에 사람이 ${r.people}명 있습니다 — 결과에 그대로 남거나 우리 모델과 겹칠 수 있어요. 사람 없는 사진이 안전합니다.`);
    if (r.beanbags > 0) warn('배경에 이미 빈백이 있습니다 — 그 빈백이 남아 제품이 둘이 되거나, 우리 제품이 그 모양을 따라갑니다.');
    if (r.gear) warn('촬영 장비(조명 스탠드 등)가 보입니다 — 결과에도 그려질 수 있어요.');
    if (r.frame) warn('캡처 화면·테두리·콜라주입니다 — 테두리째 배경으로 들어갑니다. 사진 부분만 잘라 올려 주세요.');
    if (r.text) warn('글자(벽 장식·간판·워터마크)가 보입니다 — 결과에서 깨진 글자로 남기 쉬워요.');
    if (r.setting === 'plain') info('방이 아니라 단색 배경입니다 — 「배경으로 사용」 으로 얻을 공간이 거의 없어요.');
  }

  if (role === 'style') {
    const carried = [r.people > 0 ? '사람' : '', r.beanbags > 0 ? '빈백' : ''].filter(Boolean).join('·');
    if (carried) info(`분위기만 참고하지만 사진 속 ${carried}의 모양·포즈가 섞여 들어오는 일이 있습니다. 결과에 따라오면 ${carried} 없는 사진으로 바꿔 보세요.`);
    if (r.frame) warn('캡처 화면·테두리·콜라주입니다 — 테두리나 화면 요소가 분위기로 읽힐 수 있어요. 사진 부분만 잘라 올려 주세요.');
    if (r.text) info('글자가 보입니다 — 결과에 글자 비슷한 무늬가 생길 수 있어요.');
  }

  if (role === 'base') {
    if (r.frame) warn('캡처 화면·테두리가 있습니다 — 편집 결과에도 그대로 남습니다. 사진 부분만 잘라 올려 주세요.');
    if (r.longSide > 0 && r.longSide < 1000) warn(`원본이 ${r.longSide}px 로 작습니다 — 편집 결과도 흐려집니다. 더 큰 원본이 있으면 그걸 쓰세요.`);
    if (r.gear) info('촬영 장비가 보입니다 — 지우려면 방향 지시에 적어 주세요.');
  }

  // 아래 둘은 앱 업로드에는 없는 역할 — 대화에서 힉스필드로 뽑을 때 scripts/check-ref.mjs 가 쓴다
  if (role === 'shape') {
    if (r.onProduct || r.pressed) warn('눌린 빈백입니다 — 눌린 모양이 그대로 옮겨집니다. 사람 없이 놓인 제품 사진을 쓰세요.');
    else if (r.people > 0) warn('사람이 함께 찍혀 있습니다 — 사람이 결과에 따라옵니다. 제품만 있는 사진을 쓰세요.');
    if (r.setting !== 'plain') warn('방이 보입니다 — 참조 속 방이 배경으로 따라옵니다. 단색 배경 사진이 안전합니다.');
    if (r.beanbags > 1) info(`빈백이 ${r.beanbags}개입니다 — 어느 것이 기준인지 프롬프트에 적어야 합니다.`);
    if (r.beanbags === 0) warn('빈백이 보이지 않습니다 — 형태 참조로 쓸 수 없어요.');
  }

  if (role === 'pose') {
    if (r.people === 0) warn('사람이 보이지 않습니다 — 포즈 참조로 쓸 수 없어요.');
    if (r.beanbags > 0) info('포즈 사진 속 빈백이 통째로 옮겨질 수 있습니다 — 우리 제품과 다른 모양이면 프롬프트에 "자세만 가져온다" 를 적으세요.');
    if (r.setting === 'room') info('방이 보입니다 — 배경까지 따라올 수 있어요.');
  }

  return out;
}
