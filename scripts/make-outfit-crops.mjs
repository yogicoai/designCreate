/**
 * 의상 컨셉 레퍼 11장의 "얼굴 제거 크롭"을 만든다.
 *
 * 원본(web/img/none/clothes/*.jpg)은 쇼핑몰 모델 전신컷이라 얼굴·헤어가 통째로 들어 있다.
 * 이걸 그대로 생성 참조로 넣으면 레퍼 속 모델 얼굴이 결과에 섞인다 —
 * 실제 사고 기록: "남성A 앳된 얼굴화 · 여성A 롱헤어화" (thumbnails Etc spec, 2026-08-23).
 *
 * 세로 20%~80% 밴드만 남긴다(머리·발 제거, 상의+하의 유지).
 * 결과는 /web/design/assets/outfits/<code>_crop.jpg 로 올리고 talents.outfits[].cropUrl 에 기록.
 *
 * 사용: node scripts/make-outfit-crops.mjs
 */
import fs from 'node:fs';
import { Client } from 'basic-ftp';
import { Readable } from 'node:stream';
import { MongoClient } from 'mongodb';
import sharp from 'sharp';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8')
    .split('\n').filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);

const REMOTE_DIR = 'web/design/assets/outfits';
const PUBLIC_BASE = 'https://yogibo.openhost.cafe24.com/web/design/assets/outfits';

// 머리 제거 시작점 — 기본 20%. 롱헤어 모델(여성B·D·아동B 의상)은 머리카락이 가슴까지
// 내려오므로 더 깊이 자른다. 의상 식별에는 몸통 밴드면 충분하다.
const CROP_TOP = { default: 0.2, B_W_C_01: 0.26, B_W_C_02: 0.26, D_W_C_01: 0.26, D_W_C_02: 0.26, KID_B_01: 0.26, C_W_C_02: 0.26, D_W_C_03: 0.26 };
const CROP_BOTTOM = 0.8;

const mongo = new MongoClient(env.MONGODB_URI, { maxPoolSize: 3 });
await mongo.connect();
const db = mongo.db(env.MONGODB_DB || 'imgcreate');
const talents = await db.collection('talents').find({}).toArray();

const ftp = new Client(30000);
await ftp.access({
  host: (env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, ''),
  port: Number(env.FTP_PORT) || 21,
  user: env.FTP_USER,
  password: env.FTP_PASS,
  secure: false,
});
await ftp.ensureDir(REMOTE_DIR); // 생성 + 이동

let made = 0;
for (const t of talents) {
  const outfits = [];
  for (const o of t.outfits || []) {
    const res = await fetch(o.imageUrl);
    if (!res.ok) { console.log(`  ⚠️ ${o.code} 원본 로딩 실패 ${res.status}`); outfits.push(o); continue; }
    const raw = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(raw).metadata();
    const top = Math.round(meta.height * (CROP_TOP[o.code] ?? CROP_TOP.default));
    const height = Math.round(meta.height * CROP_BOTTOM) - top;
    const buf = await sharp(raw)
      .extract({ left: 0, top, width: meta.width, height })
      .jpeg({ quality: 88 })
      .toBuffer();
    const filename = `${o.code}_crop.jpg`;
    await ftp.uploadFrom(Readable.from(buf), filename);
    const cropUrl = `${PUBLIC_BASE}/${filename}`;
    outfits.push({ ...o, cropUrl });
    made++;
    console.log(`  ✂️ ${o.code} → ${filename} (${meta.width}x${height})`);
  }
  await db.collection('talents').updateOne({ _id: t._id }, { $set: { outfits } });
}

ftp.close();
await mongo.close();
console.log(`\n완료 — 얼굴 제거 크롭 ${made}장 업로드 + talents.outfits[].cropUrl 기록`);
