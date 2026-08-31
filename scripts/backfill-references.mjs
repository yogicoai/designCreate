/**
 * 보관함 소급 등록 — references 컬렉션 도입 전에 /web/design/update/ 로 올라간
 * 레퍼런스 파일들을 FTP 에서 스캔해 보관함에 등록한다. (1회성)
 *
 * 사용: node scripts/backfill-references.mjs
 */
import fs from 'node:fs';
import { Client } from 'basic-ftp';
import { MongoClient } from 'mongodb';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8')
    .split('\n').filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);

const REMOTE_DIR = 'web/design/update';
const PUBLIC_BASE = 'https://yogibo.openhost.cafe24.com/web/design/update';

const ftp = new Client(30000);
await ftp.access({
  host: (env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, ''),
  port: Number(env.FTP_PORT) || 21,
  user: env.FTP_USER,
  password: env.FTP_PASS,
  secure: false,
});

let files = [];
try {
  files = (await ftp.list(REMOTE_DIR)).filter((f) => f.isFile && /\.(jpe?g|png|webp|gif)$/i.test(f.name));
} catch {
  console.log('update/ 폴더가 아직 없음 — 등록할 것 없음');
}
ftp.close();
console.log(`FTP ${REMOTE_DIR}/ 파일 ${files.length}건`);

if (files.length) {
  const mongo = new MongoClient(env.MONGODB_URI, { maxPoolSize: 3 });
  await mongo.connect();
  const col = mongo.db(env.MONGODB_DB || 'imgcreate').collection('references');
  let added = 0;
  for (const f of files) {
    const url = `${PUBLIC_BASE}/${f.name}`;
    const r = await col.updateOne(
      { url },
      {
        $setOnInsert: {
          url,
          title: f.name,
          width: 0,
          height: 0,
          bytes: f.size,
          active: true,
          createdAt: f.modifiedAt ? new Date(f.modifiedAt) : new Date(),
        },
      },
      { upsert: true },
    );
    if (r.upsertedCount) { added++; console.log('  +', f.name, `(${Math.round(f.size / 1024)}KB)`); }
  }
  await mongo.close();
  console.log(`보관함 소급 등록 ${added}건 (이미 있던 것 ${files.length - added}건)`);
}
