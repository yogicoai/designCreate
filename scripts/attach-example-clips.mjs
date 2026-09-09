/**
 * 예제 스토리보드(하루의 끝, 요기보)에 컷별 완성 클립을 달아준다.
 *
 * 클립은 youtube 프로젝트의 요기보 20초 단편 CF 에서 컷별로 뽑아둔 것이다.
 * 대부분 힉스필드 CDN 에 그대로 살아 있어서 주소만 달면 되고(재생 확인함),
 * 엔딩 카드만 로컬 파일이라 cafe24 로 올린다(.jpg 위장 — /api/video 가 되돌린다).
 *
 * 실행: node scripts/attach-example-clips.mjs
 */
import { Client } from 'basic-ftp';
import { MongoClient } from 'mongodb';
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const CDN = 'https://d8j0ntlcm91z4.cloudfront.net/user_3FWrSdFH0VITbqcbxBmMqiSOYx0';
const PUBLIC = (env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');
const YT = 'C:/Users/Yogibo Design/Desktop/youtube/public';

/** 컷 번호 → 완성 클립 + 그 컷에 붙일 한 줄 메모 */
const CLIPS = [
  { no: 1, url: `${CDN}/hf_20260630_031541_b0c7761e-ebba-49fe-a6a8-5737d3ab1e3d.mp4`, note: '깨어남 · 2s' },
  { no: 2, url: `${CDN}/hf_20260630_062121_7bf59e08-3b0b-45ff-b8e0-0e54872c1774.mp4`, note: '깜짝 · 폰 확인 · 2s' },
  { no: 3, url: `${CDN}/hf_20260630_060907_5999907d-43f0-40f5-9c47-6ac5906a6931.mp4`, note: '정신없이 갈아입기 · 3s' },
  { no: 4, url: `${CDN}/hf_20260630_033101_1bd41b2d-8bc4-4b18-bb7b-81186490570b.mp4`, note: '출근 · 3s' },
  { no: 5, url: `${CDN}/hf_20260629_084705_b01e2bef-9c80-4061-8480-9fc67370bbea.mp4`, note: '바쁜 회사 · 2s' },
  { no: 6, url: `${CDN}/hf_20260630_060911_d02a8f67-9684-46fe-a591-2d4e9905bf64.mp4`, note: '동료와 짧은 회의 · 2s' },
  { no: 7, url: `${CDN}/hf_20260630_052303_36b70a55-7dfc-49d5-b141-19bed08a394e.mp4`, note: '지친 표정 · 3s' },
  { no: 8, url: `${CDN}/hf_20260630_013307_828039cc-b5b3-45ee-8d73-ec2db6f50e6c.mp4`, note: '쓰러지듯 다이브 · 1s' },
  { no: 9, url: `${CDN}/hf_20260630_010352_ed65ab7d-43d8-4581-b653-df759c81ba46.mp4`, note: '잠들며 마무리 · 3s' },
  { no: 10, local: 'endcard.mp4', note: '엔딩 로고 · 2.2s' },
];

const mongo = new MongoClient(env.MONGODB_URI);
await mongo.connect();
const db = mongo.db('imgcreate');
const boards = db.collection('storyboards');

// 로컬 엔딩 카드만 올린다 (cafe24 는 .mp4 를 막으므로 .jpg 로)
const localOnes = CLIPS.filter((c) => c.local);
if (localOnes.length) {
  const c = new Client(60_000);
  await c.access({
    host: (env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, '').replace(/\/$/, ''),
    port: Number(env.FTP_PORT) || 21, user: env.FTP_USER, password: env.FTP_PASS, secure: false,
  });
  await c.ensureDir('/web/design/video');
  for (const it of localOnes) {
    const src = `${YT}/${it.local}`;
    if (!fs.existsSync(src)) { console.log(`  건너뜀(없음): ${it.local}`); continue; }
    const name = `cf20_${it.local.replace(/\.mp4$/, '')}.jpg`;
    await c.uploadFrom(src, name);
    it.url = `${PUBLIC}/video/${name}`;
    console.log(`  올림: ${it.local} → ${name}`);
  }
  c.close();
}

const board = await boards.findOne({ title: /하루의 끝, 요기보/ });
if (!board) { console.error('예제 스토리보드를 찾지 못했습니다.'); process.exit(1); }

const shots = (board.shots ?? []).map((s) => {
  const hit = CLIPS.find((c) => c.no === s.no);
  return hit?.url ? { ...s, clip: hit.url, clipNote: hit.note } : s;
});

await boards.updateOne(
  { _id: board._id },
  { $set: { shots, status: '영상완료', updatedAt: new Date() } },
);
console.log(`클립 연결: ${shots.filter((s) => s.clip).length}/${shots.length}컷`);

// 완성본(이어붙인 20초 CF)도 갤러리에 이미 있으니, 스토리보드에서 바로 가리키게 남긴다
await boards.updateOne(
  { _id: board._id },
  { $set: { finalClip: 'web/img/ai/famvid/cf20_b_1440p_h264.jpg', finalNote: '10컷을 이어붙인 완성본 · 20초 · 자막 B안' } },
);
console.log('완성본 연결: 요기보 20초 단편 CF (자막)');
await mongo.close();
