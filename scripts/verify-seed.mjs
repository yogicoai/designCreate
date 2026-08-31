// 이관 결과 점검 — 건수 + 대표 문서 샘플.
import fs from 'node:fs';
import { MongoClient } from 'mongodb';
const env = Object.fromEntries(
  fs.readFileSync('.env.local','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l))
    .map(l=>[l.slice(0,l.indexOf('=')), l.slice(l.indexOf('=')+1).trim()]));
const c = new MongoClient(env.MONGODB_URI); await c.connect();
const db = c.db(env.MONGODB_DB || 'imgcreate');

for (const n of ['products','pose_refs','talents','cuts','house_rules','color_chips'])
  console.log(`  ${n.padEnd(12)} ${String(await db.collection(n).countDocuments()).padStart(4)}건`);

const max = await db.collection('products').findOne({ _id: 'Max' });
console.log(`\n■ products/Max — 컬러 ${max.colors.length}종 · 치수`, max.dims, '· 기하검증', max.geometry.verified);
console.log('  Element 토큰 보유 컬러:', max.colors.filter(x=>x.elementId).map(x=>x.name).join(', ') || '없음');
console.log('  360뷰 보유 컬러:', max.colors.filter(x=>x.views).length, '종');

const t = await db.collection('talents').findOne({ _id: 'W_D' });
console.log(`\n■ talents/W_D — ${t.name}`);
console.log('  아이덴티티:', t.identity.slice(0,60)+'...');
console.log('  키/체형:', t.size, '· 표정시트:', t.exprSheet ? '있음' : '없음');
console.log('  의상:', t.outfits.map(o=>`${o.code}(${o.desc})`).join(' · '));

console.log('\n■ cuts — 레시피 파싱 예시 3건');
for (const cut of await db.collection('cuts').find({ 'recipe.outfit': { $exists: true } }).limit(3).toArray())
  console.log(`  [${cut.line}/${cut.colorKey}] ${JSON.stringify(cut.recipe)}\n     원문: ${cut.spec.slice(0,70)}`);

console.log('\n■ 모델별 보유 컷 수');
for (const r of await db.collection('cuts').aggregate([
  { $unwind: '$recipe.talentCodes' },
  { $group: { _id: '$recipe.talentCodes', n: { $sum: 1 } } }, { $sort: { n: -1 } },
]).toArray()) console.log(`  ${r._id.padEnd(5)} ${r.n}컷`);

await c.close();
