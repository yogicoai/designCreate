/**
 * 프롬프트 품질 보정 시드.
 *
 * 첫 dryRun 에서 드러난 세 가지 문제를 고친다:
 *
 *  ① house_rules 에 "작업자 절차"가 섞여 있다.
 *     "생성 전 크레딧 비용을 고지하라", "2048 무손실로 업로드하라" 는 사람이 지킬 일이지
 *     이미지 모델에 줄 지시가 아니다. 프롬프트에 넣으면 순수 노이즈다.
 *     → appliesTo: 'image' | 'operator' 로 가른다. 프롬프트에는 image 만 들어간다.
 *
 *  ② 영문 프롬프트에 한글이 섞인다 (COLOUR: 체리레드 / 키 173cm / "밝은미소" panel).
 *     → 컬러·모델 아이덴티티·체형·표정의 영문 표기를 채운다.
 *
 *  ③ 배경 규칙과 MD 의 장면 지시가 충돌한다 (#f2f2f4 스튜디오 vs "아늑한 거실").
 *     → 스튜디오 배경 규칙에 conditional: 'no-scene' 을 달아, 장면 지시가 있으면 빠지게 한다.
 *
 * 사용: node scripts/seed-english.mjs [--dry]
 */
import fs from 'node:fs';
import { MongoClient } from 'mongodb';

const DRY = process.argv.includes('--dry');
const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8')
    .split('\n').filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);

// ── ① 하우스룰 분류 ────────────────────────────────────────────────
// order 는 seed.mjs 의 CAUTIONS 순서와 같다.
const RULE_CLASS = {
  0: { appliesTo: 'image', requires: 'talent' },   // 자연스러운 미소 — 인물이 있을 때만
  1: { appliesTo: 'operator' },                    // expr 시트를 함께 투입하라 — 작업 절차
  2: { appliesTo: 'operator' },                    // 등받이 top 을 말로 묘사하지 마라 — 프롬프트 작성 지침
  3: { appliesTo: 'operator' },                    // 각도 중요하면 원본 포즈 프레임을 베이스로 — 작업 절차
  4: { appliesTo: 'image', requires: 'product' },  // 지퍼·봉제선 없음 — 제품이 있을 때만
  5: { appliesTo: 'image', requires: 'product' },  // 실제 비례 지킬 것 — 제품이 있을 때만
  6: { appliesTo: 'operator' },                    // 모델별 의상 매핑 — 선택 단계에서 지킬 일
  7: { appliesTo: 'image', conditional: 'no-scene' }, // 배경 #f2f2f4 — 장면 지시가 있으면 빠진다
  8: { appliesTo: 'operator' },                    // 2048 무손실 업로드
  9: { appliesTo: 'operator' },                    // 생성 전 스펙·크레딧 고지
  10: { appliesTo: 'image', requires: 'talent' },  // 두신비율 — 인물이 있을 때만
};

// ── ② 영문 표기 ────────────────────────────────────────────────────
const COLOR_EN = {
  아쿠아블루: 'aqua blue', 네이비블루: 'navy blue', 올리브그린: 'olive green',
  다크그레이: 'dark grey', 라이트그레이: 'light grey', 초코브라운: 'chocolate brown',
  체리레드: 'cherry red', 와인버건디: 'wine burgundy', 리빙코랄: 'living coral',
  스위트오렌지: 'sweet orange', 브라이트옐로우: 'bright yellow', 로즈핑크: 'rose pink',
  블라썸핑크: 'blossom pink', 브라이트퍼플: 'bright purple', 딥퍼플: 'deep purple',
  라벤더퍼플: 'lavender purple', 파스텔블루: 'pastel blue', 프레시민트: 'fresh mint',
  아보카도그린: 'avocado green', 블랙: 'black', 화이트: 'white', 그린: 'green',
  베이지: 'beige', 모카: 'mocha', 차콜: 'charcoal', 레드: 'red', 브라운: 'brown',
};

/** 모델 아이덴티티·체형의 영문 표기. 한글 서술을 그대로 넣으면 프롬프트가 흐려진다. */
const TALENT_EN = {
  W_A: {
    identityEn: 'a European woman in her late twenties, oval face, dark textured brown bob, calm and minimal presence, natural skin texture',
    sizeEn: '168cm, slim build — slightly shorter than the 170cm Max',
  },
  W_B: {
    identityEn: 'a European woman in her early twenties, soft oval face, long chestnut-brown waves, light freckles, fresh and natural presence',
    sizeEn: '172cm, slim long-limbed build — slightly taller than the 170cm Max',
  },
  W_C: {
    identityEn: 'a European woman in her mid-to-late twenties, slim oval face, blonde layered lob with curtain bangs, cool and minimal presence',
    sizeEn: '169cm, slim build — slightly shorter than the 170cm Max',
  },
  W_D: {
    identityEn: 'an East Asian woman in her early-to-mid twenties, slim oval face, long black straight hair with see-through bangs, cool editorial presence',
    sizeEn: '173cm, slim and tall — slightly taller than the 170cm Max',
  },
  M_A: {
    identityEn: 'a European man in his late twenties to early thirties, clean-cut, medium tousled dark brown waves, relaxed and approachable',
    sizeEn: '180cm, slim athletic build — clearly taller than the 170cm Max',
  },
  K_A: {
    identityEn: 'a European girl aged 6 to 7, light-brown hair in two braided pigtails with hair clips, round cheeks, bright and cheerful, natural skin',
    sizeEn: 'about 120cm — child proportions',
  },
  K_B: {
    identityEn: 'a European girl aged 10 to 12, long auburn straight hair with a centre part, light freckles, warm and gentle',
    sizeEn: 'about 150cm — pre-teen proportions',
  },
};

/** 의상 컨셉 영문 표기 — 한글 의상명이 프롬프트에 그대로 들어가면 옷이 엉뚱하게 나온다 */
const OUTFIT_EN = {
  A_W_C_01: 'a brown tee with grey sweatpants',
  B_W_C_01: 'a grey tee with denim shorts',
  B_W_C_02: 'a cream oversized shirt with wide-leg trousers',
  C_W_C_01: 'a white tee with navy slacks',
  D_W_C_01: 'a grey tee with light-wash baggy jeans',
  D_W_C_02: 'a navy striped knit top',
  A_M_C_01: 'a grey tee with sweatpants',
  A_M_C_02: 'a white tee with black slacks',
  A_M_C_03: 'an olive hoodie with charcoal joggers',
  KID_A_01: 'a grey printed tee with cream shorts',
  KID_B_01: 'an ivory ringer tee with grey shorts',
};

/** 표정 시트 8패널 — models/page.js 의 SHEETS[expr].panels */
const EXPRESSIONS = [
  { id: 'neutral', kr: '무표정', en: 'neutral, no expression' },
  { id: 'soft_smile', kr: '옅은 미소', en: 'a soft, subtle smile' },
  { id: 'bright_smile', kr: '밝은 미소', en: 'a bright, open smile' },
  { id: 'surprised', kr: '놀람', en: 'a surprised expression' },
  { id: 'sad', kr: '슬픔', en: 'a sad expression' },
  { id: 'angry', kr: '화남', en: 'an angry expression' },
  { id: 'focused', kr: '집중', en: 'a focused, concentrating expression' },
  { id: 'shy', kr: '쑥스러움', en: 'a shy, bashful expression' },
];

/** 기존 컷 spec 에 실제로 등장하는 표기까지 흡수 (곁눈질미소 등) */
const EXPR_ALIAS = {
  미소: 'soft_smile', 은은한미소: 'soft_smile', 밝은미소: 'bright_smile',
  따뜻한미소: 'soft_smile', 자연스러운미소: 'soft_smile',
  곁눈질미소: 'bright_smile', // 시선만 옆으로 — 표정 자체는 밝은 미소
};

const client = new MongoClient(env.MONGODB_URI, { maxPoolSize: 5 });
await client.connect();
const db = client.db(env.MONGODB_DB || 'imgcreate');

// ── 리포트 ──
const rules = await db.collection('house_rules').find({}).sort({ order: 1 }).toArray();
console.log('── 하우스룰 분류 ──');
for (const r of rules) {
  const c = RULE_CLASS[r.order] || { appliesTo: 'image' };
  const tag = c.appliesTo === 'image' ? '🖼  이미지' : '👤 작업자';
  console.log(`  ${tag}${c.conditional ? ` (${c.conditional})` : '      '}  ${r.kr.slice(0, 58)}`);
}
const imageRules = rules.filter((r) => (RULE_CLASS[r.order] || {}).appliesTo === 'image');
console.log(`  → 프롬프트에 들어가는 규칙 ${imageRules.length}개 / 전체 ${rules.length}개`);

const products = await db.collection('products').find({}).toArray();
const allColors = products.flatMap((p) => p.colors.map((c) => c.name));
const missing = [...new Set(allColors)].filter((n) => !COLOR_EN[n]);
console.log(`\n── 컬러 영문 표기 ──`);
console.log(`  매핑됨 ${[...new Set(allColors)].length - missing.length}/${[...new Set(allColors)].length}`);
if (missing.length) console.log(`  ⚠️ 미매핑: ${missing.join(' · ')}`);

if (DRY) { console.log('\n(--dry: DB 미기록)'); await client.close(); process.exit(0); }

// ── 적용 ──
for (const r of rules) {
  const c = RULE_CLASS[r.order] || { appliesTo: 'image' };
  await db.collection('house_rules').updateOne(
    { _id: r._id },
    { $set: { appliesTo: c.appliesTo, conditional: c.conditional ?? null, requires: c.requires ?? null } },
  );
}
console.log('\n  ✅ house_rules 분류');

for (const p of products) {
  const colors = p.colors.map((c) => ({ ...c, nameEn: COLOR_EN[c.name] || '' }));
  await db.collection('products').updateOne({ _id: p._id }, { $set: { colors } });
}
console.log('  ✅ products 컬러 영문 표기');

for (const [code, en] of Object.entries(TALENT_EN)) {
  await db.collection('talents').updateOne({ _id: code }, { $set: en });
}
console.log('  ✅ talents 영문 아이덴티티');

let outfitN = 0;
for (const t of await db.collection('talents').find({}).toArray()) {
  const outfits = (t.outfits || []).map((o) => {
    if (OUTFIT_EN[o.code]) outfitN++;
    return { ...o, descEn: OUTFIT_EN[o.code] || '' };
  });
  await db.collection('talents').updateOne({ _id: t._id }, { $set: { outfits } });
}
const allOutfits = (await db.collection('talents').find({}).toArray()).flatMap((t) => t.outfits || []);
const missOutfit = allOutfits.filter((o) => !o.descEn).map((o) => o.code);
console.log(`  ✅ 의상 영문 표기 ${outfitN}/${allOutfits.length}${missOutfit.length ? ` (미매핑: ${missOutfit.join(', ')})` : ''}`);

await db.collection('expressions').bulkWrite(
  EXPRESSIONS.map((e, i) => ({
    replaceOne: { filter: { _id: e.id }, replacement: { _id: e.id, ...e, order: i, active: true }, upsert: true },
  })),
);
await db.collection('settings').replaceOne(
  { _id: 'expression_alias' },
  { _id: 'expression_alias', map: EXPR_ALIAS },
  { upsert: true },
);
console.log(`  ✅ expressions ${EXPRESSIONS.length}건 + 별칭 ${Object.keys(EXPR_ALIAS).length}건`);

await client.close();
console.log('\n보정 완료.');
