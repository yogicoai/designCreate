import { MongoClient } from 'mongodb';

/**
 * 이미지 생성(용도와 규격) 프리셋을 배너 채널에 맞춰 정리한다.
 *
 * 사용자 요청: 자사몰 웹/모바일 · 스마트스토어 웹/모바일 · SNS · 직접입력.
 *
 * 원칙 — 생성 프리셋의 비율을 배너 스튜디오 규격과 맞춘다. 그래야 생성한
 * 컷을 배너로 넘길 때 크롭이 0 에 가깝다 (인물 잘림이 준다). 다만 픽셀은
 * 모델이 잘 그리는 해상도로 키운다: 배너 모바일은 480×558 이지만 그 크기로
 * 생성하면 너무 작아서, 같은 비율의 큰 해상도로 뽑고 배너에서 줄인다.
 *
 * 슬림 배너(스마트스토어 웹 1920×400=4.8:1)는 모델 최대 광각(21:9=2.33:1)을
 * 넘어 생성이 불가능하다 — 생성은 3:1 정도의 쓸 만한 광각으로 뽑고, 그
 * 400 슬림은 배너 스튜디오에서 잘라내게 한다.
 *
 * '내 규격'(직접 저장분)은 건드리지 않는다.
 * 사용: node --env-file=.env.local scripts/seed-gen-sizes.mjs [--apply]
 */

const APPLY = process.argv.includes('--apply');
const MY_GROUP = '내 규격';
const GEN_ASPECTS = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'];

/** aspect.ts 의 planAspect 와 같은 계산 (스크립트라 인라인) */
function planAspect(w, h) {
  const target = w / h;
  let best = '1:1';
  let bestDiff = Infinity;
  for (const a of GEN_ASPECTS) {
    const [aw, ah] = a.split(':').map(Number);
    const diff = Math.abs(Math.log(aw / ah / target));
    if (diff < bestDiff) { bestDiff = diff; best = a; }
  }
  const [bw, bh] = best.split(':').map(Number);
  const br = bw / bh;
  const retention = target > br ? br / target : target / br;
  return {
    genAspect: best,
    retention: Number(retention.toFixed(3)),
    cropAxis: Math.abs(target - br) < 0.01 ? 'none' : target > br ? 'vertical' : 'horizontal',
  };
}

// value 는 'WxH' — 생성 라우트가 이 문자열에서 픽셀을 읽는다
const DEFS = [
  ['자사몰', 'yb-web',   '🏠 자사몰 웹 메인',     1900, 675, '배너 스튜디오 자사몰 웹(1900×675)과 동일 비율'],
  ['자사몰', 'yb-mo',    '📱 자사몰 모바일 메인',  1080, 1256, '배너 모바일(480×558)과 같은 비율 · 큰 해상도로 생성'],
  ['스마트스토어', 'ss-web', '🛒 스마트스토어 웹 메인', 1920, 640, '슬림 배너(1920×400)는 배너 스튜디오에서 잘라냄'],
  ['스마트스토어', 'ss-mo',  '📱 스마트스토어 모바일 메인', 1080, 864, '배너 모바일(750×600)과 같은 비율'],
  ['SNS', 'sns-sq',   '📷 인스타 정사각',       1080, 1080, ''],
  ['SNS', 'sns-port', '📷 인스타 세로형',       1080, 1350, ''],
  ['SNS', 'sns-story','📱 스토리·릴스',         1080, 1920, ''],
];

const rows = DEFS.map(([group, key, label, w, h, note], i) => {
  const plan = planAspect(w, h);
  return {
    _id: `${w}x${h}`,          // 생성 라우트가 _id 로 규격을 찾는다 — value 와 같아야 한다
    value: `${w}x${h}`,
    label: `${label} (${w}×${h})`,
    group, width: w, height: h,
    variableHeight: false,
    exactRatio: null,
    genAspect: plan.genAspect,
    retention: plan.retention,
    cropAxis: plan.cropAxis,
    order: i + 1,
    active: true,
    seedKey: key,
    note,
  };
});

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const col = client.db(process.env.MONGODB_DB || undefined).collection('size_presets');

const existing = await col.find({}).toArray();
const builtins = existing.filter((d) => d.group !== MY_GROUP);
const mine = existing.filter((d) => d.group === MY_GROUP);

console.log('현재 내장 프리셋:', builtins.length, '· 내 규격(보존):', mine.length);
console.log('\n새 프리셋:');
for (const r of rows) {
  const crop = r.retention < 1 ? ` · ${r.cropAxis === 'vertical' ? '세로' : '가로'} ${Math.round((1 - r.retention) * 100)}% 크롭` : '';
  console.log(`  ${r.group.padEnd(8)} ${r.label}  → 생성 ${r.genAspect}${crop}`);
}

if (!APPLY) { console.log('\ndry-run — 반영하려면 --apply'); await client.close(); process.exit(0); }

await col.deleteMany({ group: { $ne: MY_GROUP } });
await col.insertMany(rows);
console.log('\n반영 완료 — 내장', rows.length, '건, 내 규격', mine.length, '건 유지');
await client.close();
