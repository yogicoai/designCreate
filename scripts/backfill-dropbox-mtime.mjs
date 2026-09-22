import fs from 'node:fs';
import { MongoClient } from 'mongodb';

/**
 * dropbox_assets 에 드롭박스 원본 파일의 수정일(srcMtime)을 채운다 — "최신 업데이트 순" 정렬용 (사용자 요청 2026-09-22).
 *
 * 원본은 읽지 않는다 — 파일 정보(stat)만 본다. 온라인 전용(자리표시자) 파일이어도 stat 은 내려받기를 일으키지 않는다.
 * 원본이 없어졌으면 srcMtime 을 비워 둔다(정렬 맨 뒤). 여러 번 돌려도 된다.
 *
 * 사용: node --env-file=.env.local scripts/backfill-dropbox-mtime.mjs [--dry]
 */

const DESIGN = 'C:/Users/Yogibo Design/Yogicorporation Dropbox/요기코퍼레이션_포워드/1. 디자인';
// import-product-photos.mjs 의 ROOTS 와 같아야 한다 — sourcePath 는 「별칭/상대경로」 모양이다
const ROOTS = {
  제품사진: `${DESIGN}/2.7 제품사진`,
  촬영2022: `${DESIGN}/2.6 촬영/2022촬영 (본사 스튜디오 제품촬영)`,
  촬영: `${DESIGN}/2.6 촬영`,
  누끼: `${DESIGN}/2.7_2 누끼`,
  브랜드: `${DESIGN}/0. 브랜드 이미지 (2025 월별 글로벌 에셋 정리)`,
};
const DRY = process.argv.includes('--dry');

const mc = new MongoClient(process.env.MONGODB_URI);
await mc.connect();
const col = mc.db(process.env.MONGODB_DB || undefined).collection('dropbox_assets');
const docs = await col.find({}).project({ sourcePath: 1 }).toArray();

let found = 0, missing = 0;
const ops = [];
for (const d of docs) {
  const sp = String(d.sourcePath || '');
  const slash = sp.indexOf('/');
  const base = ROOTS[sp.slice(0, slash)];
  let mtime = null;
  if (base && slash > 0) {
    try { mtime = fs.statSync(`${base}/${sp.slice(slash + 1)}`).mtime; found++; } catch { missing++; }
  } else missing++;
  ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { srcMtime: mtime } } } });
}
console.log(`문서 ${docs.length} · 수정일 찾음 ${found} · 원본 없음 ${missing}`);
if (!DRY) {
  for (let i = 0; i < ops.length; i += 1000) await col.bulkWrite(ops.slice(i, i + 1000));
  await col.createIndex({ srcMtime: -1, sourcePath: 1 });
  console.log('반영 완료 + 정렬 인덱스');
}
const sample = await col.find({ srcMtime: { $ne: null } }).sort({ srcMtime: -1 }).limit(5).project({ sourcePath: 1, srcMtime: 1 }).toArray();
for (const s of sample) console.log('  최신', s.srcMtime?.toISOString?.().slice(0, 10), s.sourcePath.slice(0, 80));
await mc.close();
