/**
 * eventTemp 의 사이즈 프리셋 / 변형 옵션 / 원본 보존 강도를 imgCreate 로 이관한다.
 *
 * 출처: eventTemp/src/data/campaign-templates.ts → data/legacy-eventtemp.json
 * 사용: node scripts/seed-presets.mjs [--dry]
 */
import fs from 'node:fs';
import { MongoClient } from 'mongodb';

const DRY = process.argv.includes('--dry');
const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8')
    .split('\n').filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const E = JSON.parse(fs.readFileSync('data/legacy-eventtemp.json', 'utf8'));

/** 'w:h' 를 기약분수로 — 나노바나나는 픽셀이 아니라 비율만 받는다 */
function ratioOf(w, h) {
  if (!w || !h) return null;
  const g = (a, b) => (b ? g(b, a % b) : a);
  const d = g(w, h);
  return `${w / d}:${h / d}`;
}

/**
 * 나노바나나가 실제로 받는 비율 프리셋.
 * 목표 픽셀이 이 중 어디에도 정확히 안 맞으면 가장 가까운 비율로 생성한 뒤 크롭한다.
 * (eventTemp/generated-image-prompt.ts 의 planAspect 와 같은 사고)
 */
const GEN_ASPECTS = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'];

function planAspect(w, h) {
  if (!w || !h) return { aspect: '1:1', retention: 1, cropAxis: 'none' };
  const target = w / h;
  let best = '1:1', bestDiff = Infinity;
  for (const a of GEN_ASPECTS) {
    const [aw, ah] = a.split(':').map(Number);
    // 비율은 곱셈 스케일 — 로그 거리로 비교해야 넓은 후보가 부당하게 멀어 보이지 않는다
    const diff = Math.abs(Math.log(aw / ah / target));
    if (diff < bestDiff) { bestDiff = diff; best = a; }
  }
  const [bw, bh] = best.split(':').map(Number);
  const br = bw / bh;
  const retention = target > br ? br / target : target / br;
  const cropAxis = Math.abs(target - br) < 0.01 ? 'none' : target > br ? 'vertical' : 'horizontal';
  return { aspect: best, retention: Number(retention.toFixed(3)), cropAxis };
}

// ── 1) size_presets ────────────────────────────────────────────────
// eventTemp 11종 + youtube 썸네일 규격(자사몰 상품 리스트/상세)을 합친다.
const EXTRA = [
  { value: '1000x1000', label: '🛍️ 자사몰 상품 썸네일 (1000×1000, 1:1)', group: '자사몰', width: 1000, height: 1000, referenceCategory: 'thumbnail', designCodeKey: 'thumbnail-square' },
  { value: '1080x1920', label: '📱 인스타 스토리 · 릴스 (1080×1920)', group: 'SNS', width: 1080, height: 1920, referenceCategory: 'sns-story', designCodeKey: 'sns-story' },
  { value: '1200x1500', label: '🖼️ 자사몰 상세 상단 (1200×1500, 4:5)', group: '자사몰', width: 1200, height: 1500, referenceCategory: 'thumbnail', designCodeKey: 'thumbnail-square' },
];

const sizePresets = [...E.ASPECT_RATIOS, ...EXTRA].map((a, i) => {
  const plan = planAspect(a.width, a.height);
  const design = E.DESIGN_CODES?.[a.designCodeKey];
  return {
    _id: a.value,
    value: a.value,
    label: a.label,
    group: a.group,
    width: a.width,
    height: a.height,
    /** 높이 0 = 세로 가변(이벤트 페이지/상세) — 생성은 대표 비율로 하고 이어붙인다 */
    variableHeight: !a.height,
    exactRatio: ratioOf(a.width, a.height),
    /** 나노바나나에 실제로 넘길 비율 + 크롭 계획 */
    genAspect: plan.aspect,
    retention: plan.retention,
    cropAxis: plan.cropAxis,
    referenceCategory: a.referenceCategory || null,
    designCodeKey: a.designCodeKey || null,
    designNote: typeof design === 'string' ? design : design?.description || design?.note || '',
    order: i,
    active: true,
  };
});

// ── 2) variation_options — 결과 다양화 축 ──────────────────────────
const VARIATION_GROUPS = [
  ['camera', '카메라 앵글', E.CAMERA_ANGLES],
  ['pose', '모델 포즈', E.MODEL_POSES],
  ['people', '인물 구성', E.PEOPLE_COMPOSITION],
  ['lighting', '조명 · 시간대', E.LIGHTING_TIME],
  ['scene', '사용 시나리오', E.USAGE_SCENES],
];
const variationOptions = [];
for (const [axis, axisLabel, list] of VARIATION_GROUPS) {
  (list || []).forEach((o, i) => {
    variationOptions.push({
      _id: `${axis}:${o.value ?? o.id}`,
      axis,
      axisLabel,
      value: o.value ?? o.id,
      label: o.label ?? o.name ?? '',
      /** 프롬프트에 그대로 들어가는 영문 힌트 */
      hint: o.aiHint ?? o.hint ?? o.en ?? o.sceneEn ?? '',
      order: i,
      active: true,
    });
  });
}

// ── 3) preservation_modes — 업로드한 레퍼런스를 얼마나 살릴지 ──────
const preservationModes = (E.PRESERVATION_MODES || []).map((m, i) => ({
  _id: m.value ?? m.id,
  value: m.value ?? m.id,
  label: m.label,
  desc: m.description ?? m.desc ?? '',
  /** 프롬프트에 삽입되는 영문 지시문 */
  instruction: m.instruction ?? '',
  order: i,
  active: true,
}));

const SETS = [
  ['size_presets', sizePresets],
  ['variation_options', variationOptions],
  ['preservation_modes', preservationModes],
];

console.log('── 프리셋 이관 ──');
for (const [n, d] of SETS) console.log(`  ${n.padEnd(20)} ${String(d.length).padStart(3)}건`);

console.log('\n── 사이즈 프리셋 → 생성 비율 매핑 ──');
for (const g of [...new Set(sizePresets.map((s) => s.group))]) {
  console.log(`  ■ ${g}`);
  for (const s of sizePresets.filter((x) => x.group === g)) {
    const loss = s.retention < 1 ? ` · 크롭 ${Math.round((1 - s.retention) * 100)}%(${s.cropAxis})` : '';
    console.log(`     ${String(s.value).padEnd(11)} ${String(s.exactRatio ?? '가변').padEnd(9)} → 생성 ${s.genAspect}${loss}`);
  }
}

const axes = [...new Set(variationOptions.map((v) => v.axis))];
console.log(`\n── 변형 축 ${axes.length}종 ──`);
for (const a of axes) {
  const list = variationOptions.filter((v) => v.axis === a);
  console.log(`  ${a.padEnd(9)} ${list.length}개: ${list.map((v) => v.label).join(' · ')}`);
}

if (DRY) { console.log('\n(--dry: DB 미기록)'); process.exit(0); }

const client = new MongoClient(env.MONGODB_URI, { maxPoolSize: 5 });
await client.connect();
const db = client.db(env.MONGODB_DB || 'imgcreate');
for (const [name, docs] of SETS) {
  if (!docs.length) continue;
  await db.collection(name).bulkWrite(
    docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
  );
  console.log(`  ✅ ${name} ${docs.length}건`);
}
await db.collection('size_presets').createIndex({ group: 1, order: 1 });
await db.collection('variation_options').createIndex({ axis: 1, order: 1 });
await client.close();
console.log('\n프리셋 이관 완료.');
