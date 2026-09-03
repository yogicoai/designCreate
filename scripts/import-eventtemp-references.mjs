/**
 * 디자인 빌더(eventTemp)의 레퍼런스 갤러리(ReferenceImage)를 보관함으로 가져온다.
 *
 * 파일은 같은 cafe24 호스트에 이미 올라가 있으므로 URL + 메타데이터만 복사한다.
 * source: 'eventtemp' 로 표시 — 삭제 시 파일은 건드리지 않는다 (그쪽 자산).
 *
 * 사용: node scripts/import-eventtemp-references.mjs
 */
import fs from 'node:fs';
import { MongoClient } from 'mongodb';

// 구 분류를 새 3종(shoot/banner/sns)으로 정규화 — src/lib/queries.ts 의 normalizeRefCategory 와 동일 규칙
function normalizeCategory(cat) {
  if (!cat) return null;
  if (cat === 'thumbnail' || cat === 'shoot') return 'shoot';
  if (cat === 'web-banner' || cat === 'mobile' || cat === 'banner') return 'banner';
  if (cat === 'sns-story' || cat === 'sns') return 'sns';
  if (cat === 'interior') return 'interior';
  if (cat === 'instagram') return 'instagram';
  return null;
}

function readEnv(path) {
  return Object.fromEntries(
    fs.readFileSync(path, 'utf8')
      .split('\n').filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );
}
const mine = readEnv('.env.local');
const theirs = readEnv('C:/Users/Yogibo Design/Desktop/eventTemp/.env.local');

const src = new MongoClient(theirs.MONGODB_URI, { maxPoolSize: 3 });
await src.connect();
// mongoose 기본 규칙: 모델 'ReferenceImage' → 컬렉션 'referenceimages'.
// URI 경로의 DB(test)를 그대로 쓴다.
const srcDb = src.db();
const cols = (await srcDb.listCollections().toArray()).map((c) => c.name);
const refCol = cols.find((c) => /referenceimages?/i.test(c));
if (!refCol) {
  console.log('레퍼런스 컬렉션을 찾지 못함. 존재하는 컬렉션:', cols.join(', '));
  process.exit(1);
}
const rows = await srcDb.collection(refCol).find({ active: { $ne: false } }).sort({ createdAt: -1 }).toArray();
console.log(`디자인 빌더 갤러리(${refCol}): 활성 ${rows.length}건`);

const dst = new MongoClient(mine.MONGODB_URI, { maxPoolSize: 3 });
await dst.connect();
const dstCol = dst.db(mine.MONGODB_DB || 'imgcreate').collection('references');

let added = 0, skipped = 0;
for (const r of rows) {
  if (!r.imageUrl) continue;
  const res = await dstCol.updateOne(
    { url: r.imageUrl },
    {
      $setOnInsert: {
        url: r.imageUrl,
        title: r.title || '디자인 빌더 레퍼런스',
        width: 0,
        height: 0,
        category: normalizeCategory(r.category),
        tags: r.tags ?? [],
        visualNotes: r.visualNotes ?? '',
        source: 'eventtemp',
        active: true,
        createdAt: r.createdAt ? new Date(r.createdAt) : new Date(),
      },
    },
    { upsert: true },
  );
  if (res.upsertedCount) added++; else skipped++;
}

const byCat = {};
for (const r of rows) { const k = normalizeCategory(r.category) ?? '(없음)'; byCat[k] = (byCat[k] || 0) + 1; }
console.log(`가져옴 ${added}건 · 이미 있던 것 ${skipped}건`);
console.log('분류별:', Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join(' · '));

await src.close();
await dst.close();
