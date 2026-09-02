import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';

/**
 * youtube 프로젝트의 제품 데이터를 이쪽 products 컬렉션으로 끌어온다.
 *
 * 왜: 연출에 필요한 자료가 youtube 쪽에만 있었다 —
 *   - 기존 라인의 추가 컬러 (맥스 체리레드·블라썸핑크 … 각자 8각도 뷰까지 보유)
 *   - 메이트 인형·롤메이트·필로우·악세서리 제품군 (함께 놓을 제품 소재)
 *   - usage 연출 사진 · notes 사용법 서술 · 라인급 scalePrompt
 *
 * 규칙: 비파괴. 이미 있는 값은 절대 덮지 않고 빈 곳만 채운다.
 *       기본은 계획만 보여주는 dry-run — 실제 반영은 --apply.
 *
 * 사용: node --env-file=.env.local scripts/sync-youtube-products.mjs [--apply]
 */

const YT_PATH = 'C:/Users/Yogibo Design/Desktop/youtube/data/products.json';
const APPLY = process.argv.includes('--apply');

/** youtube 이름의 한글 라인 접두 → 이쪽 line 키 */
const LINE_BY_KR = {
  '맥스': 'Max', '슬림': 'Slim', '미디': 'Midi', '미니': 'Mini',
  '드롭': 'Drop', '라운저': 'Lounger', '피라미드': 'Pyramid',
  '포드': 'Pod', '팟': 'Pod', '더블': 'Double', '서포트': 'Support',
};

/** 함께 놓는 소품으로 분류할 카테고리 — 메인 제품 선택지에는 안 띄운다 */
const ACCESSORY_CATS = new Set(['메이트(인형)', '바디필로우/스툴', '바디필로우', '필로우', '악세서리', '리빙']);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
const asciiKey = (s) => {
  const k = String(s || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return k || 'c' + Math.random().toString(36).slice(2, 8);
};

const yt = JSON.parse(readFileSync(YT_PATH, 'utf8'));
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.MONGODB_DB || undefined);
const col = db.collection('products');
const lines = await col.find({}).toArray();
const byLine = new Map(lines.map((p) => [p.line, p]));

const plan = { colorAdd: [], colorFill: [], lineFill: [], newProduct: [], skip: [] };

/** 이름에서 라인과 색을 가른다: '맥스 체리레드' → { line:'Max', colorKr:'체리레드' } */
function splitName(name) {
  const clean = String(name || '').replace(/_/g, ' ').trim();
  for (const [kr, line] of Object.entries(LINE_BY_KR)) {
    if (clean.startsWith(kr + ' ') || clean.startsWith(kr)) {
      const rest = clean.slice(kr.length).trim();
      if (rest) return { line, colorKr: rest };
    }
  }
  return null;
}

/** 같은 슬롯을 두 항목이 밀어 넣지 않게 — 라인급 항목과 색상별 항목이 겹친다 */
const addedSlots = new Set();

for (const y of yt) {
  const ycolors = Array.isArray(y.colors) ? y.colors : [];
  const split = splitName(y.name);

  // ── 1) 라인급 항목 (id 가 라인 이름 그대로: max, support …) — 라인 문서 보강 ──
  const asLine = lines.find((p) => norm(p.line) === norm(y.id));
  if (asLine) {
    const fill = {};
    if (!asLine.notes && y.notes) fill.notes = y.notes;
    if (!asLine.usageShots && y.usage && Object.keys(y.usage).length) fill.usageShots = y.usage;
    if (!asLine.category && y.category) fill.category = y.category;
    // 라인급 항목의 컬러들도 슬롯 보강 대상
    for (const yc of ycolors) mergeColor(asLine, yc, y);
    if (Object.keys(fill).length) plan.lineFill.push({ line: asLine.line, fields: Object.keys(fill), fill });
    continue;
  }

  // ── 2) '라인 + 색' 항목 — 그 라인의 컬러 슬롯으로 흡수 ──
  if (split && byLine.has(split.line)) {
    const p = byLine.get(split.line);
    for (const yc of ycolors) mergeColor(p, { ...yc, color: yc.color || split.colorKr }, y);
    if (!ycolors.length) plan.skip.push(`${y.name} (색 정보 없음)`);
    continue;
  }

  // ── 3) 이쪽에 없는 제품 — 새 문서로 (메이트·악세서리·럭스 등) ──
  plan.newProduct.push(y);
}

/** 컬러 슬롯 병합 — 없으면 추가, 있으면 빈 필드만 채움 */
function mergeColor(p, yc, y) {
  const name = String(yc.color || '').replace(/_/g, ' ').trim();
  if (!name) return;
  const slot = (p.colors || []).find((c) => norm(c.name) === norm(name));
  if (!slot) {
    const dupKey = p.line + '|' + norm(name);
    if (addedSlots.has(dupKey)) return;
    addedSlots.add(dupKey);
    plan.colorAdd.push({
      line: p.line, name,
      slot: {
        key: asciiKey(yc.elementName || y.id + name), name,
        nameEn: yc.elementName ? yc.elementName.replace(/^yogibo-[a-z]+-/, '') : '',
        hex: yc.hex || '', isRep: false,
        ...(yc.elementId ? { elementId: yc.elementId } : {}),
        ...(yc.sprite360 ? { sprite360: yc.sprite360 } : {}),
        ...(yc.views && Object.keys(yc.views).length ? { views: yc.views } : {}),
      },
    });
    return;
  }
  const fill = {};
  if (!slot.views && yc.views && Object.keys(yc.views).length) fill.views = yc.views;
  if (!slot.sprite360 && yc.sprite360) fill.sprite360 = yc.sprite360;
  if (!slot.elementId && yc.elementId) fill.elementId = yc.elementId;
  if (!slot.hex && yc.hex) fill.hex = yc.hex;
  if (Object.keys(fill).length) plan.colorFill.push({ line: p.line, name, fields: Object.keys(fill), fill });
}

// ── 보고 ──
console.log(`컬러 슬롯 신규: ${plan.colorAdd.length}건`);
for (const c of plan.colorAdd.slice(0, 8)) console.log('  +', c.line, c.name, c.slot.views ? `(뷰 ${Object.keys(c.slot.views).length})` : '(뷰 없음)');
if (plan.colorAdd.length > 8) console.log('  …', plan.colorAdd.length - 8, '건 더');
console.log(`컬러 슬롯 보강: ${plan.colorFill.length}건`);
for (const c of plan.colorFill) console.log('  ·', c.line, c.name, '←', c.fields.join(','));
console.log(`라인 문서 보강: ${plan.lineFill.length}건`);
for (const c of plan.lineFill) console.log('  ·', c.line, '←', c.fields.join(','));
console.log(`신규 제품: ${plan.newProduct.length}건`);
for (const y of plan.newProduct.slice(0, 12)) console.log('  +', y.name, `[${y.category || '분류없음'}]`);
if (plan.newProduct.length > 12) console.log('  …', plan.newProduct.length - 12, '건 더');
if (plan.skip.length) console.log('건너뜀:', plan.skip.join(' / '));

if (!APPLY) {
  console.log('\ndry-run — 반영하려면 --apply');
  await client.close();
  process.exit(0);
}

// ── 반영 ──
let maxOrder = Math.max(0, ...lines.map((p) => p.order || 0));
for (const c of plan.colorAdd) {
  await col.updateOne({ line: c.line }, { $push: { colors: c.slot } });
}
for (const c of plan.colorFill) {
  const p = byLine.get(c.line) ?? lines.find((x) => x.line === c.line);
  const idx = p.colors.findIndex((x) => norm(x.name) === norm(c.name));
  const set = {};
  for (const [k, v] of Object.entries(c.fill)) set[`colors.${idx}.${k}`] = v;
  await col.updateOne({ line: c.line }, { $set: set });
}
for (const c of plan.lineFill) {
  await col.updateOne({ line: c.line }, { $set: c.fill });
}
for (const y of plan.newProduct) {
  maxOrder += 1;
  const spec = y.spec || {};
  const lineName = y.name.replace(/_/g, ' ').trim();
  await col.insertOne({
    _id: lineName,          // 이 컬렉션은 _id 가 라인 이름이다 — generate 가 _id 로 조회한다
    line: lineName,
    emoji: ACCESSORY_CATS.has(y.category) ? '🧸' : '🛋️',
    spec: y.category || '',
    dims: { w: Number(spec.w) || undefined, d: Number(spec.d) || undefined, h: Number(spec.h) || undefined, weight: Number(spec.weight) || undefined },
    sizeText: [spec.h && `h${spec.h}`, spec.w && `w${spec.w}`, spec.d && `d${spec.d}`].filter(Boolean).join(' × '),
    scalePrompt: y.scalePrompt || '',
    geometry: null,
    ratio: '1:1',
    recommendedModels: '',
    colors: (y.colors || []).map((yc) => ({
      key: asciiKey(yc.elementName || y.id + (yc.color || '')),
      name: String(yc.color || y.name).replace(/_/g, ' ').trim(),
      nameEn: yc.elementName || '',
      hex: yc.hex || '',
      isRep: true,
      ...(yc.elementId ? { elementId: yc.elementId } : {}),
      ...(yc.sprite360 ? { sprite360: yc.sprite360 } : {}),
      ...(yc.views && Object.keys(yc.views).length ? { views: yc.views } : {}),
    })),
    order: maxOrder,
    active: true,
    // youtube 에서 온 것 표시 + 소품 분류 — 메인 제품 선택지와 함께 놓을 제품을 가른다
    category: y.category || '',
    accessory: ACCESSORY_CATS.has(y.category),
    ...(y.notes ? { notes: y.notes } : {}),
    ...(y.usage && Object.keys(y.usage).length ? { usageShots: y.usage } : {}),
    importedFrom: 'youtube/products.json',
  });
}
console.log('\n반영 완료');
await client.close();
