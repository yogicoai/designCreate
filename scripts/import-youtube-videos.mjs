/**
 * youtube 프로젝트(Desktop/youtube)의 완성 영상을 imgCreate 영상 갤러리로 옮긴다.
 *
 * - cafe24 에 이미 올라간 것(famvid/…)은 주소만 등록한다 — 업로드 없음.
 * - 로컬에만 있는 완성본은 cafe24 /web/design/video/ 로 .jpg 위장 업로드 후 등록한다.
 *   (cafe24 는 .mp4 업로드를 막는다. 재생은 /api/video 프록시가 mp4 로 되돌린다.)
 *
 * 실행: node scripts/import-youtube-videos.mjs
 */
import { Client } from 'basic-ftp';
import { MongoClient } from 'mongodb';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/Yogibo Design/Desktop/youtube/public';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

/** 옮길 목록 — 각 프로젝트의 '완성본' 한 편씩 */
const ITEMS = [
  {
    title: '요기보 20초 단편 CF (자막)',
    project: '단편 CF',
    aspect: '9:16',
    note: '20초 · 자막 B안 · 1440p — 말로 시켜서 만든 첫 완성 CF',
    remote: 'web/img/ai/famvid/cf20_b_1440p_h264.jpg',
    order: 1,
  },
  {
    title: '요기보 20초 단편 CF (자막 없음)',
    project: '단편 CF',
    aspect: '9:16',
    note: '20초 · 자막 없는 A안 · 1440p — 자막을 새로 얹을 때 쓰는 원본',
    remote: 'web/img/ai/famvid/cf20_a_1440p_h264.jpg',
    order: 2,
  },
  {
    title: '가족 요기보 Max (1탄) — 15초 라이프스타일 CF',
    project: '가족 CF',
    aspect: '9:16',
    note: '완성형 · 24.4s · 혼합본 v66 + 음원 A(감성 피아노) 확정본. 시리즈의 1탄에 해당한다',
    remote: 'web/img/ai/famvid/ours_1440p_v67a_music_h264.jpg',
    order: 3,
  },
  {
    title: '가족 요기보 2탄 — 함께 자라는 자리',
    project: '가족 CF',
    aspect: '9:16',
    note: '사계절 성장 · 러프컷 v16 (4K 마스터는 youtube 프로젝트에 보관)',
    local: 'fam2/rough_v16.mp4',
    order: 4,
  },
  {
    title: '가족 요기보 3탄 — 노는 자리',
    project: '가족 CF',
    aspect: '9:16',
    note: '유아기 놀이 · 12.6s · 러프컷 v15 (4K 마스터는 youtube 프로젝트에 보관)',
    local: 'fam3/rough_v15.mp4',
    order: 5,
  },
  {
    title: '가족 요기보 4탄 — 저녁의 자리',
    project: '가족 CF',
    aspect: '9:16',
    note: '무비나잇 · 11.0s · 러프컷 v1 (4K 마스터는 youtube 프로젝트에 보관)',
    local: 'fam4/rough_v1.mp4',
    order: 6,
  },
  {
    title: '요기보 단편 CF — Kling vs Seedance 엔진 비교',
    project: '단편 CF',
    aspect: '9:16',
    note: '같은 원작 레퍼런스를 두 엔진으로 각각 제작해 비교한 러프컷 v3',
    local: 'cf12/rough_v3.mp4',
    order: 7,
  },
  {
    title: '가족 요기보 3탄 비교 — Seedance 30초 리메이크',
    project: '가족 CF',
    aspect: '16:9',
    note: '최종 러프컷(러프2) · 34.5s · 1920×1080 · 음원 포함 — 같은 캐스팅으로 하루 아크를 Seedance 로 풀리메이크한 엔진 비교 완성본. 로고 인트로 → 엔딩 화이트페이드 로고 리빌',
    local: 'fam3s/rough2_music.mp4',
    order: 9,
  },
  {
    title: '스티커 peel — 인물을 뜯어 붙이는 효과',
    project: '실험',
    aspect: '9:16',
    note: '떼기 → 배경 전환 → 붙이기 3컷 이어붙임 · Seedance 480p',
    local: 'sticker18/threecut_spliced.mp4',
    order: 8,
  },
];

const VIDEO_DIR = 'web/design/video';

async function withFtp(fn) {
  const c = new Client(120_000);
  await c.access({
    host: (env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, '').replace(/\/$/, ''),
    port: Number(env.FTP_PORT) || 21,
    user: env.FTP_USER,
    password: env.FTP_PASS,
    secure: false,
  });
  try { return await fn(c); } finally { c.close(); }
}

const mongo = new MongoClient(env.MONGODB_URI);
await mongo.connect();
const col = mongo.db('imgcreate').collection('videos');

// 업로드가 필요한 것만 골라 한 번의 FTP 연결로 처리한다
const uploads = ITEMS.filter((i) => i.local);
if (uploads.length) {
  await withFtp(async (c) => {
    await c.ensureDir(`/${VIDEO_DIR}`);
    for (const it of uploads) {
      const src = path.join(ROOT, it.local);
      if (!fs.existsSync(src)) { console.log(`  건너뜀(파일 없음): ${it.local}`); continue; }
      // .mp4 는 cafe24 가 막는다 → .jpg 로 위장
      const name = `${it.local.replace(/[\/]/g, '_').replace(/\.mp4$/, '')}.jpg`;
      it.remote = `${VIDEO_DIR}/${name}`;
      if (await col.countDocuments({ key: it.remote })) { console.log(`  이미 올라감: ${name}`); continue; }
      const mb = (fs.statSync(src).size / 1048576).toFixed(1);
      process.stdout.write(`  올리는 중 ${it.local} (${mb}MB) → ${name} … `);
      await c.uploadFrom(src, name);
      console.log('완료');
    }
  });
}

for (const it of ITEMS) {
  if (!it.remote) { console.log(`  등록 건너뜀: ${it.title}`); continue; }
  const doc = {
    title: it.title,
    key: it.remote,
    note: it.note,
    project: it.project,
    aspect: it.aspect,
    poster: '',
    order: it.order,
    createdAt: new Date(),
  };
  // 같은 파일을 두 번 돌려도 늘어나지 않게 key 기준 upsert
  await col.updateOne({ key: it.remote }, { $set: doc, $unset: { hidden: '' } }, { upsert: true });
  console.log(`  등록: ${it.title}`);
}

console.log(`\n총 ${await col.countDocuments({ hidden: { $ne: true } })}편`);
await mongo.close();
