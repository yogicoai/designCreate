/**
 * 드롭박스 폴더와 dropbox_assets 를 대조한다 — "다 들어갔나" 를 확인하는 읽기 전용 점검.
 *
 * 수집 스크립트(import-product-photos.mjs)와 다르게 **깊이 제한 없이** 훑는다.
 * 수집 스크립트의 walk() 는 폴더 5단계 아래까지만 내려가서, 그보다 깊은 파일은 조용히 빠질 수 있다.
 * 확장자도 따로 센다 — 수집은 jpg/jpeg/png/webp 만 받으므로 tif·heic 등은 애초에 안 들어간다.
 *
 * 드롭박스 원본은 읽지 않는다 — 목록과 파일 크기(stat)만 본다. 온라인전용이어도 내려받지 않는다.
 *
 * 사용: node scripts/audit-dropbox-coverage.mjs [--root=촬영2022] [--folders=스퀴지보,메이트]
 */
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';

for (const ln of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const DESIGN = 'C:/Users/Yogibo Design/Yogicorporation Dropbox/요기코퍼레이션_포워드/1. 디자인';
const ROOTS = {
  제품사진: `${DESIGN}/2.7 제품사진`,
  촬영2022: `${DESIGN}/2.6 촬영/2022촬영 (본사 스튜디오 제품촬영)`,
  촬영: `${DESIGN}/2.6 촬영`,
  브랜드: `${DESIGN}/0. 브랜드 이미지 (2025 월별 글로벌 에셋 정리)`,
};
const rootArg = process.argv.find((a) => a.startsWith('--root='))?.slice(7) || '촬영2022';
const foldersArg = process.argv.find((a) => a.startsWith('--folders='))?.slice(10);
const ROOT = ROOTS[rootArg];

const TAKEN = /\.(jpe?g|png|webp)$/i;                       // 수집 스크립트가 받는 것
const OTHER_IMG = /\.(tiff?|heic|heif|gif|bmp|psd|ai|eps)$/i; // 이미지지만 수집 안 하는 것
const RAW = /\.(cr2|cr3|nef|arw|dng|raf|orf)$/i;
const APPLE = /^\._/;

/** 깊이 제한 없이 훑는다. 반환: 상대경로 목록(수집 대상), 기타 이미지·RAW 개수, 가장 깊은 깊이 */
function scan(dir) {
  const taken = [];
  let other = 0, raw = 0, maxDepth = 0, beyondImportDepth = 0;
  (function walk(d, depth) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (APPLE.test(e.name)) continue;
      if (TAKEN.test(e.name)) {
        taken.push(path.relative(ROOT, p).replace(/\\/g, '/'));
        maxDepth = Math.max(maxDepth, depth);
        if (depth > 4) beyondImportDepth++;               // 수집 스크립트의 walk() 가 못 내려가는 깊이
      } else if (OTHER_IMG.test(e.name)) other++;
      else if (RAW.test(e.name)) raw++;
    }
  })(dir, 0);
  return { taken, other, raw, maxDepth, beyondImportDepth };
}

const mc = new MongoClient(process.env.MONGODB_URI);
await mc.connect();
const col = mc.db(process.env.MONGODB_DB || undefined).collection('dropbox_assets');

const subdirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const imported = foldersArg ? foldersArg.split(',') : null;

console.log(`루트: ${rootArg}  (${ROOT})\n`);
console.log('폴더'.padEnd(28) + '디스크'.padStart(8) + '등록'.padStart(8) + '빠짐'.padStart(7) + '  비고');
console.log('-'.repeat(78));

let totDisk = 0, totDb = 0, totMissing = 0;
const missingSamples = [];
const notImported = [];
for (const name of subdirs.sort((a, b) => a.localeCompare(b, 'ko'))) {
  const s = scan(path.join(ROOT, name));
  if (!s.taken.length && !s.other && !s.raw) continue;
  const prefix = `${rootArg}/${name}/`;
  const inDb = new Set((await col.find({ sourcePath: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } })
    .project({ sourcePath: 1 }).toArray()).map((d) => d.sourcePath));

  if (inDb.size === 0) { notImported.push({ name, n: s.taken.length }); continue; }

  const missing = s.taken.filter((rel) => !inDb.has(`${rootArg}/${rel}`));
  totDisk += s.taken.length; totDb += inDb.size; totMissing += missing.length;
  missing.slice(0, 3).forEach((m) => missingSamples.push(m));
  const notes = [];
  if (s.beyondImportDepth) notes.push(`⚠ 깊이 초과 ${s.beyondImportDepth}장`);
  if (s.other) notes.push(`tif·heic 등 ${s.other}`);
  if (s.raw) notes.push(`RAW ${s.raw}`);
  console.log(name.slice(0, 26).padEnd(28) + String(s.taken.length).padStart(8) + String(inDb.size).padStart(8)
    + String(missing.length).padStart(7) + '  ' + (missing.length ? '← 빠짐 ' : '✓ ') + notes.join(' · '));
}
console.log('-'.repeat(78));
console.log('들어간 폴더 합계'.padEnd(28) + String(totDisk).padStart(8) + String(totDb).padStart(8) + String(totMissing).padStart(7));
if (missingSamples.length) {
  console.log('\n빠진 파일 예:');
  missingSamples.slice(0, 8).forEach((m) => console.log('   ' + m));
}

if (notImported.length) {
  const n = notImported.reduce((a, b) => a + b.n, 0);
  console.log(`\n안 넣은 폴더 ${notImported.length}개 · ${n.toLocaleString()}장 (의도적으로 제외한 것 포함):`);
  notImported.sort((a, b) => b.n - a.n).forEach((f) => console.log(`   ${f.name.slice(0, 40).padEnd(42)} ${String(f.n).padStart(7)}장`));
}
await mc.close();
