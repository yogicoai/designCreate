/**
 * 외부(MCP 힉스필드 등)에서 만든 영상을 우리 FTP + 영상 갤러리에 등록한다.
 *
 * 이미지용 import-external-cut.mjs 의 영상판이다. 앱의 /api/generate 를 안 거친 영상은
 * 어디에도 기록이 없어서, 나중에 "그때 그 클립" 을 못 찾는다 — 사용자 요청 2026-09-30:
 * "모든 과정은 영상 제작물 쪽에서 생성해서 남기면서 가보자, 나중에 필요한 레퍼런스가 될 수 있으니".
 *
 * 포스터(썸네일)는 ffmpeg 로 첫 프레임 근처를 뽑아 같이 올린다 — 갤러리가 poster 로 목록을 그린다.
 *
 * 사용: node --env-file=.env.local scripts/import-external-video.mjs <영상URL|로컬경로> <meta.json>
 *   meta: { namePart, title, project, note, aspect, order }
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Client } from 'basic-ftp';
import { Readable } from 'node:stream';
import { MongoClient } from 'mongodb';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);

const [src, metaPath] = process.argv.slice(2);
if (!src || !metaPath) { console.error('사용: node scripts/import-external-video.mjs <URL|경로> <meta.json>'); process.exit(1); }
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

// 1) 영상 확보 — URL 이면 받고, 로컬이면 그대로 읽는다
let mp4;
if (/^https?:\/\//i.test(src)) {
  const r = await fetch(src);
  if (!r.ok) { console.error('다운로드 실패', r.status); process.exit(1); }
  mp4 = Buffer.from(await r.arrayBuffer());
} else {
  if (!fs.existsSync(src)) { console.error('파일이 없습니다:', src); process.exit(1); }
  mp4 = fs.readFileSync(src);
}
const tmpDir = process.env.TEMP || '.';
const tmpMp4 = `${tmpDir}/_imp_${Date.now()}.mp4`;
const tmpJpg = tmpMp4.replace(/\.mp4$/, '.jpg');
fs.writeFileSync(tmpMp4, mp4);

// 2) 길이·해상도를 재고 포스터 한 장을 뽑는다 (0.5초 지점 — 첫 프레임은 검은 화면일 때가 많다)
const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,duration', '-of', 'json', tmpMp4], { encoding: 'utf8' });
const st = JSON.parse(probe).streams?.[0] ?? {};
const width = Number(st.width) || 0, height = Number(st.height) || 0;
const seconds = Math.round((Number(st.duration) || 0) * 100) / 100;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '0.5', '-i', tmpMp4, '-frames:v', '1', '-q:v', '3', tmpJpg]);
const poster = fs.readFileSync(tmpJpg);
console.log(`영상: ${width}x${height} · ${seconds}초 · ${(mp4.length / 1024 / 1024).toFixed(2)}MB`);

// 3) FTP 업로드 — 영상은 /web/design/video/ 아래 (기존 영상 레퍼런스와 같은 자리)
const iso = new Date().toISOString();
const stamp = iso.replace(/[-:T]/g, '').slice(0, 14);
const rand = Math.random().toString(36).slice(2, 7);
const base = `${(meta.namePart || 'clip').replace(/[^a-zA-Z0-9_-]/g, '_')}_${stamp}_${rand}`;
const ROOT = (env.FTP_REMOTE_DIR || '/web/design').replace(/^\/|\/$/g, '');
const SUB = 'video';

const ftp = new Client(60000);
await ftp.access({
  host: (env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, ''),
  port: Number(env.FTP_PORT) || 21, user: env.FTP_USER, password: env.FTP_PASS, secure: false,
});
await ftp.ensureDir(`${ROOT}/${SUB}`);
/*
 * cafe24 는 .mp4 업로드를 막는다 (FTP 550 Operation not permitted).
 * 그래서 영상도 .jpg 확장자로 올리고, 재생은 /api/video/<경로> 가 video/mp4 로 바꿔 흘려보낸다
 * — 기존 영상들이 쓰는 방식 그대로다 (src/app/api/video/[...key]/route.ts 주석 참고).
 */
await ftp.uploadFrom(Readable.from(mp4), `${base}.jpg`);
await ftp.uploadFrom(Readable.from(poster), `${base}_poster.jpg`);
ftp.close();
fs.rmSync(tmpMp4, { force: true }); fs.rmSync(tmpJpg, { force: true });

const BASE = (env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');
const key = `${ROOT}/${SUB}/${base}.jpg`;           // videos.key 는 경로다 (도메인 없이, 확장자는 위장한 .jpg)
const posterUrl = `${BASE}/${SUB}/${base}_poster.jpg`;
console.log('업로드:', `${BASE}/${SUB}/${base}.jpg`, '(재생은 /api/video/' + key + ')');

// 4) 갤러리 등록
const mongo = new MongoClient(env.MONGODB_URI, { maxPoolSize: 3 });
await mongo.connect();
const col = mongo.db(env.MONGODB_DB || undefined).collection('videos');
const maxOrder = (await col.find({}).sort({ order: -1 }).limit(1).toArray())[0]?.order ?? 0;
const doc = {
  key, poster: posterUrl,
  title: meta.title ?? base,
  project: meta.project ?? '',
  note: [meta.note, `${seconds}초 · ${width}x${height}`].filter(Boolean).join('\n'),
  aspect: meta.aspect ?? (width && height ? (width >= height ? '16:9' : '9:16') : ''),
  order: meta.order ?? maxOrder + 1,
  seconds, width, height,
  createdAt: new Date(iso),
};
const ins = await col.insertOne(doc);
await mongo.close();
console.log('영상 갤러리 등록 완료 · id =', String(ins.insertedId));
