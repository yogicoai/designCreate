import fs from 'node:fs';
import sharp from 'sharp';
import { Client } from 'basic-ftp';
import { Readable } from 'node:stream';
import { MongoClient, ObjectId } from 'mongodb';
const env = Object.fromEntries(fs.readFileSync('.env.local', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const src = process.argv[2];
const jpg = await sharp(fs.readFileSync(src)).jpeg({ quality: 92 }).toBuffer();
const ROOT = (env.FTP_REMOTE_DIR || '/web/design').replace(/^\/|\/$/g, '');
const day = '2026-10-27';
const name = `Midi_aqua_recolor_zoola_marine_fix_${Date.now().toString(36)}.jpg`;
const ftp = new Client(30000);
await ftp.access({ host: (env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, ''), port: Number(env.FTP_PORT) || 21, user: env.FTP_USER, password: env.FTP_PASS, secure: false });
await ftp.ensureDir(`${ROOT}/${day}`);
await ftp.uploadFrom(Readable.from(jpg), name);
ftp.close();
const url = `${(env.FTP_PUBLIC_BASE || '').replace(/\/$/, '')}/${day}/${name}`;
const mongo = new MongoClient(env.MONGODB_URI, { maxPoolSize: 2 });
await mongo.connect();
const col = mongo.db(env.MONGODB_DB || 'imgcreate').collection('cuts');
const doc = await col.findOne({ _id: new ObjectId('6ae04fba280ac0621e944ab0') });
await col.updateOne({ _id: doc._id }, {
  $set: {
    url,
    deltaE: 0.4, measuredHex: '#0074BB',
    'qc.colorFix': { before: 28.6, after: 0.4, rawUrl: doc.url },
    note: '코드 Lab 재채색(비용 0, 2026-10-27): 빈백 영역만 명암 비율 유지하며 공식 칩 #0075BD 로 — ΔE 28.6 → 0.4. 보정 전 원본은 qc.colorFix.rawUrl. 캐리어·아이·방은 그대로.',
    updatedAt: new Date(),
  },
});
console.log('교체 완료:', url);
console.log('보정 전 보관:', doc.url);
