/**
 * dropbox_assets 의 `sourcePath` 에 루트 별칭 접두사를 채운다.
 *
 * 왜 필요한가 (2026-09-21):
 *   `sourcePath` 는 멱등 키(unique)인데, 초기에는 드롭박스 루트 안의 상대경로만 담았다.
 *   루트가 하나뿐이면 문제가 없지만 `2.6 촬영` 을 추가로 가져오면서 두 루트에
 *   같은 상대경로(`서포트/...`, `더블/...`)가 생겼다. 이번엔 하위 폴더 구조가 달라
 *   우연히 안 겹쳤지만, 겹치면 나중 것이 "이미 등록됨" 으로 조용히 건너뛰어진다.
 *
 *   수집 스크립트는 이제 `<루트별칭>/<상대경로>` 로 만든다. 기존 문서에도 같은 접두사를
 *   채워야 다음 실행이 그것들을 "새 파일" 로 보고 6,680장을 통째로 다시 올리지 않는다.
 *
 * 어느 루트에서 왔는지 구분하는 법 — URL 과 폴더명으로 되짚는다:
 *   - url 에 `_r2` 가 있으면 제품사진 (1차 배치를 2000px 로 재업로드한 것)
 *   - folderHint 가 맥스·미니·드롭이면 제품사진 (2차 배치)
 *   - folderHint 가 스퀴지보·메이트면 촬영2022 (제품사진에는 없는 폴더)
 *   - folderHint 가 서포트·더블인데 `_r2` 가 없으면 촬영2022
 *   - 나머지는 제품사진
 *
 * 사용:
 *   node scripts/migrate-dropbox-sourcepath.mjs        # 드라이런
 *   node scripts/migrate-dropbox-sourcepath.mjs --go
 */
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';

const GO = process.argv.includes('--go');
for (const ln of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const mc = new MongoClient(process.env.MONGODB_URI);
await mc.connect();
const col = mc.db(process.env.MONGODB_DB || undefined).collection('dropbox_assets');

/*
 * import-product-photos.mjs 의 ROOTS 키와 같아야 한다. 여기 빠진 별칭이 있으면 그 루트의 문서를
 * "접두사 없음" 으로 보고 '제품사진/브랜드/…' 처럼 한 번 더 접두사를 붙여 멱등 키를 깨뜨린다
 * (2026-09-21 검토에서 '브랜드' 가 빠져 있던 것을 잡았다).
 */
const KNOWN_ROOTS = ['제품사진', '촬영2022', '촬영', '누끼', '브랜드'];
const SHOOT_ONLY = new Set(['스퀴지보', '메이트']);
const BATCH2 = new Set(['맥스', '미니', '드롭']);

function rootOf(d) {
  const url = String(d.url || '');
  /*
   * macOS 리소스 포크는 제품사진 1차 배치에서만 딸려 들어왔고(이후 수집기에서 걸러진다),
   * 이미지가 아니라 재업로드에 실패해 `_r2` 가 없다 — 그래서 아래 "_r2 없으면 촬영2022"
   * 규칙에 잘못 걸린다. 먼저 걸러낸다.
   */
  if (/^\._/.test(String(d.sourceName || ''))) return '제품사진';
  if (url.includes('_r2.')) return '제품사진';
  if (SHOOT_ONLY.has(d.folderHint)) return '촬영2022';
  if (BATCH2.has(d.folderHint)) return '제품사진';
  if (d.folderHint === '서포트' || d.folderHint === '더블') return '촬영2022';
  return '제품사진';
}

// 브랜드 정리는 처음부터 접두사를 달고 들어왔다 — 이 일회성 보정의 대상이 아니다
const docs = await col.find({ section: { $ne: 'brand' } }).project({ sourcePath: 1, url: 1, folderHint: 1, sourceName: 1 }).toArray();
const todo = docs.filter((d) => !KNOWN_ROOTS.some((r) => String(d.sourcePath || '').startsWith(`${r}/`)));

const tally = {};
for (const d of todo) {
  const r = rootOf(d);
  tally[r] = (tally[r] || 0) + 1;
}
console.log(`전체 ${docs.length}장 · 접두사 없는 것 ${todo.length}장`);
console.log('붙일 접두사별:', Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ') || '(없음)');

// 접두사를 붙였을 때 서로 부딪히는 것이 없는지 먼저 본다 — unique 인덱스라 부딪히면 실패한다
const after = new Set(docs
  .filter((d) => KNOWN_ROOTS.some((r) => String(d.sourcePath || '').startsWith(`${r}/`)))
  .map((d) => d.sourcePath));
const clash = [];
for (const d of todo) {
  const next = `${rootOf(d)}/${d.sourcePath}`;
  if (after.has(next)) clash.push(next);
  after.add(next);
}
console.log('충돌 검사:', clash.length ? `⚠ ${clash.length}건` : '없음');
clash.slice(0, 5).forEach((c) => console.log('   ' + c));

if (!GO) {
  console.log('\n드라이런입니다. 적용하려면 --go 를 붙이세요.');
  await mc.close();
  process.exit(0);
}
if (clash.length) {
  console.log('\n충돌이 있어 중단합니다 — 먼저 해결하세요.');
  await mc.close();
  process.exit(1);
}

let n = 0;
for (const d of todo) {
  await col.updateOne({ _id: d._id }, { $set: { sourcePath: `${rootOf(d)}/${d.sourcePath}`, sourceRoot: rootOf(d) } });
  if (++n % 500 === 0) console.log(`  …${n}/${todo.length}`);
}
console.log(`\n적용 ${n}장`);
for (const r of KNOWN_ROOTS) {
  const c = await col.countDocuments({ sourcePath: { $regex: `^${r}/` } });
  if (c) console.log(`  ${r}/ → ${c}장`);
}
await mc.close();
