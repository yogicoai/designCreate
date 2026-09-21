/**
 * 드롭박스 제품사진을 references → dropbox_assets 로 옮긴다.
 *
 * 왜 옮기나 (사용자 결정 2026-09-21):
 *   레퍼런스가 이미 4,600장인데 드롭박스에는 9,565장이 있다. 한 컬렉션에 섞으면
 *   촬영 1,072장·모델컷 1,257장 같은 기존 작업이 그대로 묻힌다. 그래서 컬렉션과 화면을
 *   따로 둔다 — 메뉴는 자산 관리 > 레퍼런스 바로 아래 「드롭박스」(/dropbox).
 *
 * 무엇이 바뀌나:
 *   - category / tags 는 버린다. 컬렉션 자체가 '드롭박스 파일'이라 분류 칸이 필요 없고,
 *     옛 값(category:'product', tags:['product', 폴더명])은 폴더명을 분류처럼 보이게 해서
 *     오히려 해롭다 — 폴더명은 folderHint 에만 근거로 남는다.
 *   - 나머지(url·title·folderHint·filenameHint·labelStatus·sourcePath·sourceName)는 그대로.
 *
 * FTP 파일은 건드리지 않는다. 경로는 /web/design/product/<슬러그>/ 그대로 유지하기로 했고
 * (사용자 결정), 출처 구분은 컬렉션과 source 필드로 충분하다.
 *
 * 사용:
 *   node scripts/migrate-dropbox-assets.mjs         # 드라이런 — 무엇이 옮겨질지만 출력
 *   node scripts/migrate-dropbox-assets.mjs --go    # 실제 이동
 *   node scripts/migrate-dropbox-assets.mjs --rollback --go   # 되돌리기
 */
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';

const GO = process.argv.includes('--go');
const ROLLBACK = process.argv.includes('--rollback');

for (const ln of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const mc = new MongoClient(process.env.MONGODB_URI);
await mc.connect();
const db = mc.db(process.env.MONGODB_DB || undefined);
const refs = db.collection('references');
const assets = db.collection('dropbox_assets');

const SOURCE = 'dropbox-product';

if (ROLLBACK) {
  const rows = await assets.find({}).toArray();
  console.log(`되돌리기 대상 ${rows.length}장 (dropbox_assets → references)`);
  if (!GO) { console.log('\n드라이런입니다. 실제로 되돌리려면 --go 를 붙이세요.'); await mc.close(); process.exit(0); }
  let n = 0;
  for (const d of rows) {
    const { _id, ...rest } = d;
    await refs.updateOne(
      { sourcePath: d.sourcePath },
      { $set: { ...rest, category: 'dropbox', tags: ['dropbox'] } },
      { upsert: true },
    );
    n++;
  }
  await assets.deleteMany({});
  console.log(`되돌림 ${n}장`);
  await mc.close();
  process.exit(0);
}

// ── 이동 ────────────────────────────────────────────────────────────────────
const todo = await refs.find({ source: SOURCE }).toArray();
console.log(`references 안의 드롭박스 제품사진: ${todo.length}장`);

const byFolder = {};
for (const d of todo) byFolder[d.folderHint || '(없음)'] = (byFolder[d.folderHint || '(없음)'] || 0) + 1;
console.log('폴더별:', Object.entries(byFolder).map(([k, v]) => `${k} ${v}`).join(' · '));

const already = await assets.countDocuments();
console.log(`dropbox_assets 에 이미 있는 것: ${already}장`);

// 옮기면서 버릴 값 — 폴더명이 분류처럼 보이던 옛 흔적
const sample = todo[0];
if (sample) {
  console.log('\n예시 한 건 —');
  console.log('  버림:  category =', JSON.stringify(sample.category), ', tags =', JSON.stringify(sample.tags));
  console.log('  유지:  folderHint =', JSON.stringify(sample.folderHint), ', labelStatus =', JSON.stringify(sample.labelStatus), ', sub =', JSON.stringify(sample.sub ?? null));
  console.log('  경로:  ', sample.sourcePath, '→', sample.url);
}

if (!GO) {
  console.log(`\n드라이런입니다. ${todo.length}장을 dropbox_assets 로 옮기려면 --go 를 붙이세요.`);
  console.log('(references 에서는 옮긴 뒤 삭제됩니다. 되돌리려면 --rollback --go)');
  await mc.close();
  process.exit(0);
}

let moved = 0;
for (const d of todo) {
  // eslint-disable-next-line no-unused-vars
  const { _id, category, tags, ...keep } = d;
  await assets.updateOne(
    { sourcePath: d.sourcePath },
    {
      $set: { ...keep, active: d.active !== false },
      $setOnInsert: { migratedAt: new Date() },
    },
    { upsert: true },
  );
  moved++;
  if (moved % 100 === 0) console.log(`  …${moved}/${todo.length}`);
}

// 옮긴 것만 골라 지운다 — sourcePath 로 확인하고 지워야 실수로 남의 문서를 건드리지 않는다
const movedPaths = todo.map((d) => d.sourcePath);
const del = await refs.deleteMany({ source: SOURCE, sourcePath: { $in: movedPaths } });

// 조회 인덱스 — sourcePath 는 멱등 키라 유일해야 한다
await assets.createIndex({ sourcePath: 1 }, { unique: true });
await assets.createIndex({ url: 1 });
await assets.createIndex({ folderHint: 1, sourcePath: 1 });
await assets.createIndex({ labelStatus: 1 });

const left = await refs.countDocuments({ source: SOURCE });
console.log(`\n이동 ${moved}장 · references 에서 삭제 ${del.deletedCount}장 · 남은 것 ${left}장`);
console.log(`dropbox_assets 총 ${await assets.countDocuments()}장`);
console.log(`references 총 ${await refs.countDocuments()}장`);
await mc.close();
