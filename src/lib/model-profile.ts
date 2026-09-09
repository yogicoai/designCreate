/**
 * 전속 모델 프로필 — 나이대·키·체형을 골라 받고, 프롬프트에 들어갈 문장을 조립한다.
 *
 * 왜 자유 입력이 아닌가:
 *  - 체중은 사람마다 기준이 달라 숫자로 받으면 오히려 결과가 흔들린다. 그래서 체형은 고른다.
 *  - 이 값들은 프롬프트의 SCALE 문장으로 그대로 들어가 제품 대비 인물 크기를 정한다.
 *    손으로 적으면 "Max 170 기준" 같은 기준선을 빼먹기 쉬워서, 그 비교는 앱이 붙인다.
 */

/** 제품 크기 기준선 — Max 는 길이 170cm 라 사람 키와 바로 견줄 수 있다 */
export const MAX_LENGTH_CM = 170;

export const AGE_BANDS = [
  { v: 'kid-young', kr: '유아 (4~7세)', en: 'a young child around 4-7 years old' },
  { v: 'kid', kr: '초등 저학년 (8~10세)', en: 'a child around 8-10 years old' },
  { v: 'tween', kr: '초등 고학년~중학생 (11~14세)', en: 'a pre-teen around 11-14 years old' },
  { v: 'teen', kr: '10대 후반', en: 'in their late teens' },
  { v: '20e', kr: '20대 초반', en: 'in their early 20s' },
  { v: '20l', kr: '20대 후반', en: 'in their late 20s' },
  { v: '30e', kr: '30대 초반', en: 'in their early 30s' },
  { v: '30l', kr: '30대 후반', en: 'in their late 30s' },
  { v: '40', kr: '40대', en: 'in their 40s' },
  { v: '50', kr: '50대 이상', en: 'in their 50s or older' },
] as const;

export const BODY_TYPES = [
  { v: 'lean', kr: '마른', en: 'lean, slight frame' },
  { v: 'slim', kr: '슬림', en: 'slim build' },
  { v: 'normal', kr: '보통', en: 'average build' },
  { v: 'athletic', kr: '탄탄한', en: 'toned athletic build' },
  { v: 'curvy', kr: '통통한', en: 'fuller, softly rounded build' },
] as const;

export type AgeBand = (typeof AGE_BANDS)[number]['v'];
export type BodyType = (typeof BODY_TYPES)[number]['v'];

export interface ModelProfile {
  age: string;
  heightCm: number;
  bodyType: string;
}

const ageOf = (v: string) => AGE_BANDS.find((a) => a.v === v);
const bodyOf = (v: string) => BODY_TYPES.find((b) => b.v === v);

/** 아동인가 — 아동은 Max 와의 키 비교가 의미 없으므로 '아동 비례' 로 적는다 */
function isChild(age: string) {
  return age === 'kid-young' || age === 'kid' || age === 'tween';
}

/**
 * 고른 값들로 화면용 한글 문장과 프롬프트용 영문 문장을 만든다.
 * 영문 쪽은 그대로 생성 프롬프트에 들어가므로, Max 170 대비 크기 비교까지 붙인다.
 */
export function composeSize(p: ModelProfile): { size: string; sizeEn: string } {
  const a = ageOf(p.age);
  const b = bodyOf(p.bodyType);
  const h = Math.round(Number(p.heightCm) || 0);

  const krParts = [a?.kr, h ? `키 ${h}cm` : '', b?.kr].filter(Boolean);
  const enParts = [a?.en, h ? `${h}cm tall` : '', b?.en].filter(Boolean);

  if (h && !isChild(p.age)) {
    const d = h - MAX_LENGTH_CM;
    // 5cm 안쪽 차이는 "비슷" 으로 — 굳이 크다/작다를 강조하면 엔진이 과하게 반응한다
    const kr = Math.abs(d) <= 5 ? `Max 170 과 비슷한 키` : d > 0 ? `Max 170 기준 살짝 크게` : `Max 170 기준 살짝 작게`;
    const en = Math.abs(d) <= 5
      ? `about the same length as the 170cm Max`
      : d > 0
        ? `taller than the 170cm Max`
        : `shorter than the 170cm Max`;
    krParts.push(`(${kr})`);
    enParts.push(`— ${en}`);
  } else if (h && isChild(p.age)) {
    krParts.push('(아동 비례)');
    enParts.push('— child proportions');
  }

  return { size: krParts.join(' · '), sizeEn: enParts.join(', ').replace(', —', ' —') };
}

/** 저장된 한글 문장에서 되읽기 — 예전에 손으로 적어둔 값도 화면에 채워지도록 */
export function parseSize(size: string, fallbackAge = '20e'): ModelProfile {
  const h = Number(/([0-9]{2,3})\s*cm/.exec(size ?? '')?.[1] ?? 0);
  const age = AGE_BANDS.find((a) => (size ?? '').includes(a.kr))?.v
    ?? (/아동|유아/.test(size ?? '') ? 'kid' : fallbackAge);
  const bodyType = BODY_TYPES.find((b) => (size ?? '').includes(b.kr))?.v
    ?? (/슬림/.test(size ?? '') ? 'slim' : 'normal');
  return { age, heightCm: h || 170, bodyType };
}
