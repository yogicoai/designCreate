/**
 * 제품사진 업로드 검증 — 등록된 URL 이 실제로 열리는지 확인한다.
 * 경로·인코딩이 틀리면 화면에서 전부 엑박이 되므로 배치마다 한 번씩 돌린다.
 *
 *   node scripts/check-product-photos.mjs            # 폴더별 현황 + 표본 4장 접근확인
 *   node scripts/check-product-photos.mjs --all      # 전량 접근확인 (느리다)
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const env = Object.fromEntries(
  fs.readFileSync(fileURLToPath(new URL('../.env.local', import.meta.url)), 'utf8')
    .split('\n').filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; }));

const mc = new MongoClient(env.MONGODB_URI);
await mc.connect();
// references 가 아니라 dropbox_assets — 드롭박스 제품사진은 별도 컬렉션에 산다 (2026-09-21)
const col = mc.db(env.MONGODB_DB || undefined).collection('dropbox_assets');

const total = await col.countDocuments({ source: 'dropbox-product' });
console.log(`등록된 제품사진: ${total}장\n`);

const byFolder = await col.aggregate([
  { $match: { source: 'dropbox-product' } },
  { $group: { _id: '$folderHint', n: { $sum: 1 },
      conflict: { $sum: { $cond: [{ $eq: ['$labelStatus', 'conflict'] }, 1, 0] } } } },
  { $sort: { n: -1 } },
]).toArray();
for (const f of byFolder) {
  console.log(`  ${String(f._id).padEnd(14)} ${String(f.n).padStart(5)}장` + (f.conflict ? `  (충돌 ${f.conflict})` : ''));
}

const docs = process.argv.includes('--all')
  ? await col.find({ source: 'dropbox-product' }).toArray()
  : await col.find({ source: 'dropbox-product' }).limit(4).toArray();

console.log(`\n접근확인 (${docs.length}장)`);
let ok = 0, bad = [];
for (const d of docs) {
  const r = await fetch(d.url, { method: 'HEAD' }).catch(() => null);
  if (r?.status === 200) ok++; else bad.push(`${r?.status ?? 'ERR'} ${d.url}`);
  if (docs.length <= 6) {
    const mb = r ? (Number(r.headers.get('content-length')) / 1024 / 1024).toFixed(1) : '-';
    console.log(`  [${r?.status ?? 'ERR'}] ${mb}MB  ${r?.headers.get('content-type') ?? '-'}`);
    console.log(`        ${d.url}`);
    console.log(`        title="${d.title}"  folderHint=${d.folderHint}  labelStatus=${d.labelStatus}  sub=${d.sub}`);
    console.log(`        원본 ${d.sourcePath}\n`);
  }
}
console.log(`정상 ${ok} / 실패 ${bad.length}`);
bad.slice(0, 10).forEach((b) => console.log('  ' + b));
await mc.close();
