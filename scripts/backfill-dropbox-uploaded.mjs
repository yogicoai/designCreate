import fs from 'node:fs';
import { MongoClient } from 'mongodb';

/**
 * dropbox_assets 에 "드롭박스에 올라온 시각"(srcUploaded)을 채운다 — 목록을 업로드 최신순으로 보여주기 위해 (사용자 요청 2026-09-23).
 *
 * 왜 수정일(srcMtime)이 아닌가: 수정일은 사진 자체의 날짜(촬영일)다. 2021년에 찍어 2024-12 에 드롭박스로 올린 사진은
 * 수정일이 2021 이라 목록 한참 뒤에 묻힌다. 실측(표본 12장, 2026-09-23):
 *   촬영/220210308요기보1308.jpg — 수정일 2021-04-02 · 올라온 시각 2024-12-10
 *   촬영2022/_M4A4774.jpg        — 수정일 2022-11-14 · 올라온 시각 2023-01-17
 * 파일이 이 PC 의 드롭박스 폴더에 만들어진 시각(birthtime)이 곧 "그 파일이 드롭박스에 들어온 때"다.
 * (ctime 은 우리가 9/21 에 훑은 흔적이라 전부 같은 날로 나온다 — 쓰면 안 된다.)
 *
 * 원본은 읽지 않는다 — 파일 정보(stat)만 본다. 온라인 전용(자리표시자) 파일이어도 내려받기를 일으키지 않는다.
 * 원본이 없어졌으면 비워 둔다(정렬 맨 뒤). 여러 번 돌려도 된다.
 * 주의: 드롭박스를 새 PC 에 다시 받으면 birthtime 이 그 시점으로 바뀐다 — 그때는 이 스크립트를 다시 돌리지 말고 기존 값을 쓴다.
 *
 * 사용: node --env-file=.env.local scripts/backfill-dropbox-uploaded.mjs [--dry] [--only-missing]
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
const ONLY_MISSING = process.argv.includes('--only-missing');

const mc = new MongoClient(process.env.MONGODB_URI);
await mc.connect();
const col = mc.db(process.env.MONGODB_DB || undefined).collection('dropbox_assets');
const docs = await col
  .find(ONLY_MISSING ? { srcUploaded: { $exists: false } } : {})
  .project({ sourcePath: 1 })
  .toArray();

let found = 0, missing = 0;
const ops = [];
for (const d of docs) {
  const sp = String(d.sourcePath || '');
  const slash = sp.indexOf('/');
  const base = ROOTS[sp.slice(0, slash)];
  let uploaded = null;
  if (base && slash > 0) {
    try {
      const st = fs.statSync(`${base}/${sp.slice(slash + 1)}`);
      // birthtime 이 없거나 0 인 파일 시스템이면 수정일로 대신한다 (정렬에서 빠지는 것보다 낫다)
      uploaded = st.birthtimeMs ? st.birthtime : st.mtime;
      found++;
    } catch { missing++; }
  } else missing++;
  ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { srcUploaded: uploaded } } } });
}
console.log(`문서 ${docs.length} · 올라온 시각 찾음 ${found} · 원본 없음 ${missing}`);
if (!DRY) {
  for (let i = 0; i < ops.length; i += 1000) {
    await col.bulkWrite(ops.slice(i, i + 1000));
    if ((i + 1000) % 5000 === 0) console.log(`  ...${Math.min(i + 1000, ops.length)}/${ops.length}`);
  }
  // 목록 정렬용 인덱스 — src/lib/queries.ts 의 DROPBOX_SORT 와 같은 순서여야 한다
  await col.createIndex({ srcUploaded: -1, srcMtime: -1, sourcePath: 1 });
  console.log('반영 완료 + 정렬 인덱스');
}
const sample = await col.find({ srcUploaded: { $ne: null } }).sort({ srcUploaded: -1 }).limit(5)
  .project({ sourcePath: 1, srcUploaded: 1, srcMtime: 1 }).toArray();
for (const s of sample) {
  console.log('  최신 업로드', s.srcUploaded?.toISOString?.().slice(0, 10), '· 촬영/수정', s.srcMtime?.toISOString?.().slice(0, 10), s.sourcePath.slice(0, 70));
}
await mc.close();
