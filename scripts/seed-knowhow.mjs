/**
 * 노하우 반영 시드 — 전수조사 비평(2026-08-31)에서 실측된 오류를 고친다.
 *
 * ① expressions 6·7·8 패널이 실제 시트와 달랐다.
 *    시드는 models/page.js 의 소개 문구(화남·집중·쑥스러움)를 믿었지만, 실제로 컷을 뽑아낸
 *    빌더 3개(gen_prompts.mjs 등)는 전부 "6 frown, 7 serious, 8 side-glance smile" 로 박고 있다.
 *    시트 이미지에 없는 패널을 선택지로 주면 얼굴이 흔들린다.
 *    '곁눈질미소' 별칭도 패널 3(bright)이 아니라 패널 8(side-glance)이 정본.
 *
 * ② talents.identityEn 이 "시트 감사에서 오류로 판명난 서술"의 요약본이었다.
 *    2026-08-23 시트 감사 워크플로(모델별 독립 판독+검증 8에이전트)가 확정한 정본으로 교체:
 *      여성A: 근흑색 턱선 보브 · 센터파트 · 앞머리 없음 (이전 '앞머리 있음' 서술이 오류)
 *      여성B: 라이트~미디엄 웜브라운 · 앞머리 없음 · 귀 아래부터 소프트 웨이브 · 옅은 주근깨
 *             (auburn/reddish 강조가 진저 곱슬 사고의 원인 — 혼동색 네거티브 필수)
 *      여성D: 제트블랙 스트레이트 · 얇은 시스루뱅 (이전 '두꺼운 풀뱅' 서술이 오류) · 모노리드
 *      남성A: 다크브라운 미디엄 웨이브 · 센터파트 커튼 스타일 (이전 '이마에서 넘긴 짧은 머리' 오류)
 *
 * ③ Etc 컷 spec 에 축적된 범용 규칙을 house_rules 로 승격.
 *    머리:몸 비율(성인 1:7.5 · 아동B 1:6.5 · 아동A 1:6), 의상 레퍼 얼굴 크롭 필수 등.
 *
 * ④ 라인은 맞는데 썸네일 컬러 슬롯이 없어 병합에서 탈락한 9개 컬러를 products 에 추가.
 *    (서포트 올리브그린 · 드롭 네이비블루 · 팟 아쿠아/올리브 · 피라미드 로즈핑크 ·
 *     슬림 아보카도그린 · 미디 스톤 · 미니 라이트그레이) — 360뷰가 있는데 버려지고 있었다.
 *
 * 사용: node scripts/seed-knowhow.mjs
 */
import fs from 'node:fs';
import { MongoClient } from 'mongodb';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8')
    .split('\n').filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const LEGACY_PRODUCTS = JSON.parse(fs.readFileSync('data/legacy-products.json', 'utf8'));

// ── ① 표정 패널 정본 (빌더 3개 공통 범례) ──────────────────────────
const EXPRESSIONS = [
  { id: 'neutral', kr: '무표정', en: 'neutral, no expression' },
  { id: 'soft_smile', kr: '옅은 미소', en: 'a soft, subtle smile' },
  { id: 'bright_smile', kr: '밝은 미소', en: 'a bright, open smile' },
  { id: 'surprised', kr: '놀람', en: 'a surprised expression' },
  { id: 'sad', kr: '슬픔', en: 'a sad expression' },
  { id: 'frown', kr: '찡그림', en: 'a slight frown' },
  { id: 'serious', kr: '진지함', en: 'a calm, serious expression' },
  { id: 'side_glance', kr: '곁눈질 미소', en: 'a smile with a sideways glance' },
];
const EXPR_ALIAS = {
  미소: 'soft_smile', 은은한미소: 'soft_smile', 밝은미소: 'bright_smile',
  따뜻한미소: 'soft_smile', 자연스러운미소: 'soft_smile',
  곁눈질미소: 'side_glance', // 패널 8이 정본 (bright 로 보내던 이전 별칭이 오류)
};

// ── ② 시트 감사 정본 아이덴티티 (혼동색 네거티브 포함) ─────────────
const TALENT_AUDIT = {
  W_A: {
    identityEn:
      'a European woman in her mid twenties, oval face with soft defined features, dark brown eyes, fair skin with a natural no-makeup look, ' +
      'very dark brown / near-black chin-to-jaw-length textured bob with a centre parting and NO bangs/fringe, slightly tousled ends, calm minimal presence ' +
      '(hair is near-black — not light brown, not blonde, not long)',
  },
  W_B: {
    identityEn:
      'a European woman in her early twenties, soft oval face, light-to-medium warm brown hair falling below the shoulders in soft loose waves ' +
      'starting below the ears, centre parting, NO bangs/fringe, light freckles across the nose and cheeks, fresh natural presence ' +
      '(hair colour is light chestnut brown — NOT auburn, NOT red, NOT ginger, NOT blonde, NOT dark brown; waves are soft and loose — NOT tight curls)',
  },
  W_C: {
    identityEn:
      'a European woman in her mid-to-late twenties, slim oval face, blonde layered lob with curtain bangs, cool and minimal presence, natural skin texture',
  },
  W_D: {
    identityEn:
      'an East Asian woman in her early-to-mid twenties, slim oval face with monolid eyes, jet-black long straight hair with a centre parting and ' +
      'THIN see-through bangs (not a thick full fringe), cool editorial presence ' +
      '(hair is jet black and pin-straight — not brown, not wavy)',
  },
  M_A: {
    identityEn:
      'a European man in his late twenties to early thirties, clean-cut, dark brown medium-length wavy hair styled as a centre-parted curtain style, ' +
      'relaxed and approachable, natural skin texture (hair is a loose curtain style — NOT a short swept-back cut)',
  },
  K_A: {
    identityEn:
      'a European girl aged 6 to 7, light-brown hair in two braided pigtails with a centre parting and small hair clips, round cheeks, ' +
      'bright and cheerful, natural skin (a young child — head proportionally larger than an adult)',
  },
  K_B: {
    identityEn:
      'a European girl aged 10 to 12, long reddish-brown straight hair with a centre parting, light freckles, warm gentle presence ' +
      '(a pre-teen — clearly a child, not a small adult)',
  },
};

// ── ③ Etc 노하우 → 하우스룰 승격 ──────────────────────────────────
const NEW_RULES = [
  {
    _id: 'rule_11',
    order: 10,
    kr: '★ 머리:몸 비율 수치락 — 성인 1:7.5 · 아동B 1:6.5 · 아동A 1:6. 아동은 축소 성인이 아니라 머리가 상대적으로 크다.',
    en: 'Head-to-body ratio must be realistic: adults about 1:7.5, a pre-teen about 1:6.5, a young child about 1:6 — children are not scaled-down adults; their heads are proportionally larger.',
    critical: true,
    appliesTo: 'image',
    conditional: null,
    enabled: true,
  },
  {
    _id: 'rule_12',
    order: 11,
    kr: '★ 의상 컨셉 레퍼는 반드시 얼굴을 잘라낸 크롭으로 투입 — 레퍼 속 모델 얼굴/머리카락이 결과에 섞여 들어온 사고 다수 (남성A 앳된 얼굴화, 여성A 롱헤어화).',
    en: 'When attaching an outfit concept reference, crop the face and hair out first — garment only.',
    critical: true,
    appliesTo: 'operator',
    conditional: null,
    enabled: true,
  },
  {
    _id: 'rule_13',
    order: 12,
    kr: '"원본대로" 같은 추상 지시 대신 수치 지시 — 쿠션 배치·크기·위치는 칸/percent 로 명시해야 유지된다 (RULE ZERO 세트락).',
    en: 'Replace abstract instructions with numeric ones — positions, sizes and arrangements hold only when stated as counts, grid cells or percentages.',
    critical: false,
    appliesTo: 'operator',
    conditional: null,
    enabled: true,
  },
];

// ── ④ 병합 탈락 컬러 슬롯 9건 ─────────────────────────────────────
// key 는 기존 슬롯 관행(소문자 붙여쓰기)에 맞춘다.
const MISSING_SLOTS = [
  { line: 'Support', name: '올리브그린', key: 'olive' },
  { line: 'Drop', name: '네이비블루', key: 'navy' },
  { line: 'Pod', name: '아쿠아블루', key: 'aqua' },
  { line: 'Pod', name: '올리브그린', key: 'olive' },
  { line: 'Pyramid', name: '로즈핑크', key: 'rosepink' },
  { line: 'Slim', name: '아보카도그린', key: 'avocadogreen' },
  { line: 'Midi', name: '스톤', key: 'stone' },
  { line: 'Mini', name: '라이트그레이', key: 'lightgrey' },
];
const LINE_KR = { Support: '서포트', Drop: '드롭', Pod: '팟', Pyramid: '피라미드', Slim: '슬림', Midi: '미디', Mini: '미니' };
const COLOR_EN = {
  올리브그린: 'olive green', 네이비블루: 'navy blue', 아쿠아블루: 'aqua blue',
  로즈핑크: 'rose pink', 아보카도그린: 'avocado green', 스톤: 'stone grey', 라이트그레이: 'light grey',
};

const client = new MongoClient(env.MONGODB_URI, { maxPoolSize: 5 });
await client.connect();
const db = client.db(env.MONGODB_DB || 'imgcreate');

// ① expressions 교체
await db.collection('expressions').deleteMany({});
await db.collection('expressions').insertMany(
  EXPRESSIONS.map((e, i) => ({ _id: e.id, ...e, order: i, active: true })),
);
await db.collection('settings').replaceOne(
  { _id: 'expression_alias' },
  { _id: 'expression_alias', map: EXPR_ALIAS },
  { upsert: true },
);
console.log(`✅ expressions 정본 교체 (6=찡그림 7=진지함 8=곁눈질미소) + 별칭 곁눈질미소→side_glance`);

// ② talents 시트 감사 정본
for (const [code, patch] of Object.entries(TALENT_AUDIT)) {
  await db.collection('talents').updateOne({ _id: code }, { $set: { ...patch, identitySource: 'sheet-audit-2026-08-23' } });
}
console.log(`✅ talents 아이덴티티 ${Object.keys(TALENT_AUDIT).length}명 — 시트 감사 정본 + 혼동색 네거티브`);

// ③ 하우스룰 추가
await db.collection('house_rules').bulkWrite(
  NEW_RULES.map((r) => ({ replaceOne: { filter: { _id: r._id }, replacement: r, upsert: true } })),
);
console.log(`✅ house_rules +${NEW_RULES.length} (머리:몸 비율 · 의상레퍼 얼굴크롭 · 수치지시)`);

// ④ 병합 탈락 컬러 슬롯 추가
const legacyIdx = new Map();
for (const p of LEGACY_PRODUCTS) {
  const name = (p.name || '').trim();
  for (const [line, kr] of Object.entries(LINE_KR)) {
    if (!name.startsWith(kr)) continue;
    const c = (p.colors || [])[0] || {};
    const colorName = (c.color || name.slice(kr.length)).trim().replace(/^[_\s]+/, '');
    legacyIdx.set(`${line}|${colorName}`, c);
    break;
  }
}
let added = 0;
for (const slot of MISSING_SLOTS) {
  const lc = legacyIdx.get(`${slot.line}|${slot.name}`);
  if (!lc) { console.log(`  ⚠️ legacy 미발견: ${slot.line} ${slot.name}`); continue; }
  const doc = await db.collection('products').findOne({ _id: slot.line });
  if (!doc) continue;
  if (doc.colors.some((c) => c.key === slot.key || c.name === slot.name)) continue; // 이미 있음
  const color = {
    key: slot.key,
    name: slot.name,
    nameEn: COLOR_EN[slot.name] || '',
    hex: lc.hex || '',
    isRep: false,
    ...(lc.elementId ? { elementId: lc.elementId } : {}),
    ...(lc.sprite360 ? { sprite360: lc.sprite360 } : {}),
    ...(lc.views && Object.keys(lc.views).length ? { views: lc.views } : {}),
  };
  await db.collection('products').updateOne({ _id: slot.line }, { $push: { colors: color } });
  added++;
}
console.log(`✅ products 컬러 슬롯 +${added} (360뷰 보유분 복원)`);

const total = (await db.collection('products').find({}).toArray()).reduce((n, p) => n + p.colors.length, 0);
console.log(`   현재 총 컬러 슬롯: ${total}`);

await client.close();
console.log('\n노하우 반영 완료.');
