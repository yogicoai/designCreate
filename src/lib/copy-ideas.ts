import 'server-only';

/**
 * 이달의 문구 추천.
 *
 * 두 갈래를 합친다.
 *   ① 시즌 캘린더 — 그 달에 무엇을 파는 달인지 (추석·신학기·가정의달…)
 *   ② 실제 수집   — 네이버 블로그·카페에서 지금 실제로 쓰이는 표현
 *
 * 템플릿만 있으면 뻔한 문구가 나오고, 수집만 하면 정리가 안 된다.
 * 시즌이 뼈대를 잡고, 수집이 지금 시장의 온도를 채운다.
 *
 * 빈백은 '집에서 쉬는 시간'을 파는 제품이라, 모든 문구가 그 축으로 수렴하게 썼다.
 */

export interface Season {
  /** 화면에 보이는 이름 */
  label: string;
  /** 이 시즌을 검색할 때 쓰는 키워드 — 실제 문구 수집에 쓴다 */
  keywords: string[];
  /** 이 시즌의 소구점 — 왜 지금 빈백인가 */
  angle: string;
  /** 바로 쓸 수 있는 문구 씨앗 */
  seeds: string[];
}

/*
 * 월별 시즌.
 * 한국 리테일 캘린더 기준이고, 빈백이 실제로 팔리는 맥락으로 각을 잡았다.
 * 이사·신학기처럼 '공간을 새로 꾸미는 시점'과
 * 명절·연휴처럼 '집에 오래 머무는 시점'이 우리 성수기다.
 */
export const SEASONS: Record<number, Season> = {
  1: {
    label: '새해 · 신년',
    keywords: ['신년 이벤트', '새해 특가'],
    angle: '새해에 방을 새로 꾸미는 수요',
    seeds: ['새해엔 새 자리에서', '올해는 제대로 쉬어보기', '신년 맞이 홈리셋'],
  },
  2: {
    label: '설 연휴 · 새학기 준비',
    keywords: ['설날 이벤트', '새학기 준비'],
    angle: '연휴에 집에 모이는 시간 + 신학기 방 정리',
    seeds: ['온 가족이 둘러앉는 자리', '연휴엔 집이 제일 편하니까', '새학기 전에 방부터'],
  },
  3: {
    label: '신학기 · 봄맞이',
    keywords: ['신학기 이벤트', '봄맞이 인테리어'],
    angle: '자취·기숙사 입주, 방 꾸미기 성수기',
    seeds: ['첫 자취방의 첫 소파', '봄, 방을 바꿀 시간', '좁은 방도 거실처럼'],
  },
  4: {
    label: '봄 인테리어',
    keywords: ['봄 인테리어 이벤트', '홈스타일링'],
    angle: '환기·리프레시, 밝은 컬러 교체 수요',
    seeds: ['창가에 앉는 계절', '봄빛이 드는 자리', '컬러만 바꿔도 새 방'],
  },
  5: {
    label: '가정의 달',
    keywords: ['가정의달 이벤트', '어버이날 선물', '어린이날 선물'],
    angle: '선물 수요 — 부모님·아이 모두에게 맞는 품목',
    seeds: ['부모님께 편한 자리 하나', '아이 방에 안전한 소파', '가족이 다 앉는 크기'],
  },
  6: {
    label: '초여름 · 홈캉스',
    keywords: ['홈캉스 이벤트', '여름 인테리어'],
    angle: '집에서 보내는 여름, 시원한 소재 소구',
    seeds: ['집이 제일 시원한 계절', '에어컨 앞 명당', '홈캉스 준비 끝'],
  },
  7: {
    label: '여름 휴가 · 바캉스',
    keywords: ['여름휴가 이벤트', '바캉스 특가'],
    angle: '휴가철 집콕 + 캠핑·차박 수요',
    seeds: ['멀리 안 가도 되는 휴가', '거실이 곧 리조트', '캠핑장에도 가져가는'],
  },
  8: {
    label: '늦여름 · 방학 마무리',
    keywords: ['여름 마지막 세일', '개학 준비'],
    angle: '시즌오프 특가 + 개학 전 방 정리',
    seeds: ['여름 마지막 특가', '개학 전에 방 정리', '시즌오프 지금이 마지막'],
  },
  9: {
    label: '추석 · 가을 홈퍼니싱',
    keywords: ['추석 이벤트', '추석 선물', '가을 인테리어'],
    angle: '명절에 온 가족이 모이는 거실 + 선물 수요',
    seeds: [
      '온 가족이 둘러앉는 한가위',
      '올 추석, 거실에 자리 하나 더',
      '명절엔 앉을 자리가 넉넉해야',
      '부모님께 드리는 편안한 자리',
      '추석 연휴, 집이 제일 좋다',
    ],
  },
  10: {
    label: '가을 · 홈인테리어',
    keywords: ['가을 인테리어 이벤트', '홈퍼니싱'],
    angle: '실내 활동 증가, 따뜻한 소재로 교체',
    seeds: ['해가 짧아질수록 집이 좋다', '가을엔 포근한 걸로', '독서등 옆 그 자리'],
  },
  11: {
    label: '블랙프라이데이 · 코리아세일페스타',
    keywords: ['블랙프라이데이 이벤트', '코리아세일페스타'],
    angle: '연중 최대 할인 시즌 — 가격 소구가 가장 세게 먹히는 달',
    seeds: ['연중 최대 할인', '1년에 한 번', '지금이 제일 쌉니다'],
  },
  12: {
    label: '연말 · 크리스마스',
    keywords: ['크리스마스 이벤트', '연말 선물'],
    angle: '선물 + 홈파티, 연말 홈캉스',
    seeds: ['연말은 집에서', '선물하기 좋은 크기', '한 해 마무리는 편안하게'],
  },
};

/** 전 시즌 공통으로 자주 쓰이는 소구 축 — 시즌 문구와 조합해 쓴다 */
export const ANGLES = [
  { key: 'price', label: '가격', tails: ['최대 {n}% 할인', '{n}% 특가', '단독 특가', '오늘만 이 가격'] },
  { key: 'urgency', label: '기간', tails: ['{d}일까지', '이번 주만', '수량 한정', '앵콜 마감 임박'] },
  { key: 'gift', label: '혜택', tails: ['커버 증정', '무료배송', '사은품 증정', '리뷰 적립'] },
  { key: 'value', label: '가치', tails: ['하루의 끝을 바꾸는 자리', '앉는 순간 알게 되는', '온 가족이 함께'] },
];

/**
 * 수집한 제목들에서 자주 쓰이는 문구 조각을 뽑는다.
 *
 * 형태소 분석 없이 하는 일이라 완벽하지 않다. 대신 마케팅 문구에서 반복되는
 * 패턴(특가/할인/증정/한정/마감)을 중심으로 잡고, 2회 이상 나온 것만 남긴다.
 * 한 번만 나온 표현은 그 브랜드만의 문구일 뿐 '유행'이 아니다.
 */
export function harvestPhrases(titles: string[]): { phrase: string; count: number }[] {
  const PAT = [
    /[가-힣A-Za-z0-9]{0,6}\s?(?:특가|할인|세일|프로모션|이벤트)/g,
    /(?:최대|단독|한정|선착순|마감|앵콜|리뉴얼|런칭|오픈)\s?[가-힣]{0,6}/g,
    /(?:증정|사은품|무료배송|적립|쿠폰|추가|덤)\s?[가-힣]{0,4}/g,
    /(?:온\s?가족|가족|우리집|집콕|홈캉스|힐링|휴식|편안|포근|아늑)\s?[가-힣]{0,4}/g,
  ];
  const count = new Map<string, number>();
  for (const t of titles) {
    const seen = new Set<string>();
    for (const re of PAT) {
      for (const m of String(t).matchAll(re)) {
        const w = m[0].replace(/\s+/g, ' ').trim();
        // 너무 짧거나 숫자만인 건 문구가 아니다
        if (w.length < 2 || /^\d+$/.test(w)) continue;
        if (seen.has(w)) continue;
        seen.add(w);
        count.set(w, (count.get(w) ?? 0) + 1);
      }
    }
  }
  return [...count.entries()]
    .filter(([, n]) => n >= 2)
    .map(([phrase, n]) => ({ phrase, count: n }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 24);
}

/**
 * 시즌 씨앗 + 소구 축을 조합해 바로 쓸 문구를 만든다.
 * @param discount 경쟁사 실측 할인율의 중앙값 — 없으면 숫자 자리를 비워둔다
 */
export function buildSuggestions(month: number, discount = 0, until = ''): string[] {
  const s = SEASONS[month];
  if (!s) return [];
  const out: string[] = [];
  const n = discount > 0 ? String(discount) : '00';
  const d = until || '연휴 전날';
  for (const seed of s.seeds) {
    out.push(`${seed} · ${discount > 0 ? `최대 ${n}% 할인` : '단독 특가'}`);
    out.push(`${seed}, ${d}까지`);
  }
  out.push(`${s.label} 기념 — 온 가족이 앉는 자리`);
  if (discount > 0) out.push(`${s.label} 단독 ${n}% · 수량 한정`);
  return [...new Set(out)].slice(0, 12);
}
