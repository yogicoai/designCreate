/**
 * 외부(MCP 힉스필드 등)에서 생성한 컷을 우리 FTP + 갤러리에 등록한다.
 *
 * 앱의 /api/generate 를 안 거친 생성물은 어디에도 기록이 없다. 이 스크립트가
 * 파일을 /web/design/<날짜>/ 로 옮기고 cuts 문서를 만들어 갤러리에 올린다.
 *
 * 사용: node scripts/import-external-cut.mjs <원본URL> <메타JSON파일>
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { Client } from 'basic-ftp';
import { Readable } from 'node:stream';
import { MongoClient } from 'mongodb';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);

const [srcUrl, metaPath] = process.argv.slice(2);
if (!srcUrl || !metaPath) { console.error('사용: node scripts/import-external-cut.mjs <URL> <meta.json>'); process.exit(1); }
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

// 1) 내려받기
const res = await fetch(srcUrl);
if (!res.ok) { console.error('다운로드 실패', res.status); process.exit(1); }
const raw = Buffer.from(await res.arrayBuffer());
const jpg = await sharp(raw).jpeg({ quality: 92 }).toBuffer();
const dim = await sharp(jpg).metadata();
console.log(`내려받음: ${dim.width}x${dim.height} · ${(jpg.length / 1024 / 1024).toFixed(2)}MB`);

// 2) FTP 업로드 — 생성물 규칙과 동일하게 /web/design/<YYYY-MM-DD>/
const iso = new Date().toISOString();
const day = iso.slice(0, 10);
const stamp = iso.replace(/[-:T]/g, '').slice(0, 14);
const rand = Math.random().toString(36).slice(2, 7);
const filename = `${(meta.namePart || 'gen').replace(/[^a-zA-Z0-9_-]/g, '_')}_${stamp}_${rand}.jpg`;

const ROOT = (env.FTP_REMOTE_DIR || '/web/design').replace(/^\/|\/$/g, '');
const ftp = new Client(30000);
await ftp.access({
  host: (env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, ''),
  port: Number(env.FTP_PORT) || 21, user: env.FTP_USER, password: env.FTP_PASS, secure: false,
});
await ftp.ensureDir(`${ROOT}/${day}`);
await ftp.uploadFrom(Readable.from(jpg), filename);
ftp.close();

const publicUrl = `${(env.FTP_PUBLIC_BASE || '').replace(/\/$/, '')}/${day}/${filename}`;
console.log('업로드:', publicUrl);

// 3) 갤러리 등록
const mongo = new MongoClient(env.MONGODB_URI, { maxPoolSize: 3 });
await mongo.connect();
const now = new Date(iso);
const doc = {
  line: meta.line ?? '',
  colorKey: meta.colorKey ?? '',
  colorName: meta.colorName ?? '',
  hex: meta.hex ?? '',
  url: publicUrl,
  title: meta.title ?? '',
  spec: meta.spec ?? '',
  recipe: meta.recipe ?? { talentCodes: [] },
  source: 'imgcreate',
  prompt: meta.prompt ?? '',
  promptMode: 'manual',
  aiModel: meta.aiModel ?? 'higgsfield/nano_banana_pro',
  provider: 'higgs',
  sizeValue: `${dim.width}x${dim.height}`,
  sizeLabel: meta.sizeLabel ?? '',
  aspect: meta.aspect ?? '',
  inputImages: meta.inputImages ?? [],
  direction: meta.direction ?? '',
  width: dim.width,
  height: dim.height,
  deltaE: meta.deltaE ?? null,
  measuredHex: meta.measuredHex ?? null,
  note: meta.note ?? '',
  hidden: false,
  createdAt: now,
  updatedAt: now,
};
const ins = await mongo.db(env.MONGODB_DB || 'imgcreate').collection('cuts').insertOne(doc);
await mongo.close();
console.log('갤러리 등록 완료 · id =', String(ins.insertedId));
