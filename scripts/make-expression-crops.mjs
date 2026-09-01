/**
 * 표정 시트(2행×4열, 8표정)를 칸별로 잘라 개별 표정컷으로 만든다.
 *
 * 왜: 8칸 그리드를 통째로 참조로 주면 모델이 (a) 격자를 해석하고 (b) 글로 지정한 칸을
 * 찾고 (c) 나머지 7개 표정(화남·슬픔 포함)을 무시해야 한다 — 세 단계가 다 새는 지점.
 * 요청한 표정 한 칸만 주면 신호가 깨끗하고 얼굴 해상도도 그리드 대비 크다.
 *
 * 칸 순서 = expressions 컬렉션 order (seed-english.mjs 의 EXPRESSIONS):
 *   1행: neutral · soft_smile · bright_smile · surprised
 *   2행: sad · angry · focused · shy
 *
 * 업로드: /web/design/assets/expressions/<모델코드>_<표정id>.jpg
 * 기록:   talents.expressionCrops = { <표정id>: url }
 *
 * 사용: node scripts/make-expression-crops.mjs
 */
import fs from 'node:fs';
import sharp from 'sharp';
import { Client } from 'basic-ftp';
import { MongoClient } from 'mongodb';
import { Readable } from 'node:stream';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8')
    .split('\n').filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);

const REMOTE_DIR = 'web/design/assets/expressions';
const PUBLIC_BASE = 'https://yogibo.openhost.cafe24.com/web/design/assets/expressions';
const COLS = 4;
const ROWS = 2;
/** 칸 경계선·시트 상하단의 작은 캡션 텍스트를 피하기 위한 안쪽 여백 (칸 크기 대비) */
const INSET_X = 0.03;
const INSET_Y = 0.05;

const mongo = new MongoClient(env.MONGODB_URI, { maxPoolSize: 3 });
await mongo.connect();
const db = mongo.db(env.MONGODB_DB || 'imgcreate');
const exprs = await db.collection('expressions').find({}).sort({ order: 1 }).toArray();
if (exprs.length !== COLS * ROWS) {
  console.error(`expressions 컬렉션이 ${exprs.length}건 — ${COLS * ROWS}칸 시트와 맞지 않음`);
  process.exit(1);
}
const talents = await db.collection('talents').find({}).sort({ order: 1 }).toArray();

const ftp = new Client(30000);
await ftp.access({
  host: (env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, ''),
  port: Number(env.FTP_PORT) || 21,
  user: env.FTP_USER,
  password: env.FTP_PASS,
  secure: false,
});
await ftp.ensureDir(REMOTE_DIR);

let uploaded = 0;
for (const t of talents) {
  if (!t.exprSheet) { console.log(`  - ${t.code}: 표정 시트 없음`); continue; }
  const res = await fetch(t.exprSheet);
  if (!res.ok) { console.log(`  ✗ ${t.code}: 시트 로딩 실패 ${res.status}`); continue; }
  const sheet = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(sheet).metadata();
  const cellW = meta.width / COLS;
  const cellH = meta.height / ROWS;

  const crops = {};
  for (let i = 0; i < exprs.length; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const left = Math.round(col * cellW + cellW * INSET_X);
    const top = Math.round(row * cellH + cellH * INSET_Y);
    const width = Math.round(cellW * (1 - INSET_X * 2));
    const height = Math.round(cellH * (1 - INSET_Y * 2));
    const buf = await sharp(sheet).extract({ left, top, width, height }).jpeg({ quality: 90 }).toBuffer();
    const name = `${t.code}_${exprs[i]._id}.jpg`;
    await ftp.uploadFrom(Readable.from(buf), name); // ensureDir 이 이미 그 폴더로 이동한 상태
    crops[exprs[i]._id] = `${PUBLIC_BASE}/${name}`;
    uploaded++;
  }
  await db.collection('talents').updateOne({ _id: t._id }, { $set: { expressionCrops: crops } });
  console.log(`  ✂️ ${t.code}: ${exprs.length}칸 (${Math.round(cellW)}x${Math.round(cellH)}) → ${Object.keys(crops).join(', ')}`);
}

ftp.close();
await mongo.close();
console.log(`\n완료 — 표정컷 ${uploaded}장 업로드 + talents.expressionCrops 기록`);
