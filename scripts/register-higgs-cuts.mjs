import { MongoClient } from 'mongodb';
import sharp from 'sharp';
import { Client } from 'basic-ftp';
import { Readable } from 'node:stream';

/**
 * 대화에서 힉스필드로 뽑은 결과를 앱 컷 갤러리(cuts)에 등록한다.
 *
 * 힉스필드 결과는 힉스필드 클라우드에만 있어 앱에서 안 보인다. 이 스크립트가
 * 받아서 목표 배너 크기로 잘라(cover) cafe24 에 올리고 cuts 에 넣는다 —
 * 그러면 다른 생성 컷과 똑같이 대시보드 생성컷·배너 배경 목록에 뜬다.
 * (src/lib/ftp.ts 는 TS 라 node 에서 못 부른다 — 같은 로직을 인라인)
 */

const HOST = (process.env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, '').replace(/\/$/, '');
const PORT = Number(process.env.FTP_PORT) || 21;
const USER = process.env.FTP_USER || '';
const PASS = process.env.FTP_PASS || '';
const ROOT = (process.env.FTP_REMOTE_DIR || '/web/img/imgc').replace(/^\/|\/$/g, '');
const PUBLIC_BASE = (process.env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');

async function uploadBuffer(sub, filename, buffer) {
  const dir = sub ? `${ROOT}/${sub}` : ROOT;
  const c = new Client(30000);
  try {
    await c.access({ host: HOST, port: PORT, user: USER, password: PASS, secure: false });
    await c.ensureDir(dir);
    await c.uploadFrom(Readable.from(buffer), filename);
  } finally { c.close(); }
  return sub ? `${PUBLIC_BASE}/${sub}/${filename}` : `${PUBLIC_BASE}/${filename}`;
}

const ITEMS = [
  { url: 'https://d8j0ntlcm91z4.cloudfront.net/user_3GqUAvuXPXzI4QTJXVT0jqaM2ll/hf_20260902_033510_e67b1bf7-fe87-48d4-8074-59a082318b86.png',
    w: 1900, h: 675, title: '올리브 맥스 · 여성B 배너 A (왼쪽 여백)', talents: ['W_B'], size: '1900x675', sizeLabel: '자사몰 웹 메인' },
  { url: 'https://d8j0ntlcm91z4.cloudfront.net/user_3GqUAvuXPXzI4QTJXVT0jqaM2ll/hf_20260902_033510_f2610b58-5cde-4229-8101-dc2de382c1f8.png',
    w: 1900, h: 675, title: '올리브 맥스 · 여성B 배너 B (측면 리클라인)', talents: ['W_B'], size: '1900x675', sizeLabel: '자사몰 웹 메인' },
  { url: 'https://d8j0ntlcm91z4.cloudfront.net/user_3GqUAvuXPXzI4QTJXVT0jqaM2ll/hf_20260902_033510_7f435945-2577-42f5-a0cb-fc575e47dfb5.png',
    w: 1080, h: 1080, title: '여성 3인 · 요기보 라운지 (레퍼런스 교체)', talents: ['W_B', 'W_A', 'W_C'], size: '1080x1080', sizeLabel: '인스타 정사각' },
];

if (!HOST || !USER) { console.error('FTP 설정 없음'); process.exit(1); }

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const cuts = client.db(process.env.MONGODB_DB || undefined).collection('cuts');

for (const it of ITEMS) {
  const res = await fetch(it.url);
  if (!res.ok) { console.log('받기 실패', it.title, res.status); continue; }
  const raw = Buffer.from(await res.arrayBuffer());
  const out = await sharp(raw).resize(it.w, it.h, { fit: 'cover' }).jpeg({ quality: 94 }).toBuffer();

  const iso = new Date().toISOString();
  const sub = iso.slice(0, 10);
  const stamp = iso.replace(/[-:T]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 7);
  const url = await uploadBuffer(sub, `higgs_${stamp}_${rand}.jpg`, out);

  await cuts.insertOne({
    line: '', colorKey: '', colorName: '', hex: '',
    url, title: it.title,
    spec: `힉스필드 · ${it.talents.join('·')} · ${it.sizeLabel}`,
    recipe: { talentCodes: it.talents },
    source: 'imgcreate',
    promptMode: 'local',
    aiModel: 'nano_banana_pro',
    provider: 'higgsfield',
    sizeValue: it.size, sizeLabel: it.sizeLabel, aspect: `${it.w}:${it.h}`,
    inputImages: [],
    direction: '', width: it.w, height: it.h,
    deltaE: null, measuredHex: null, note: '대화에서 힉스필드로 생성해 등록',
    hidden: false, createdAt: new Date(iso), updatedAt: new Date(iso),
  });
  console.log('등록:', it.title, '→', url);
}

await client.close();
console.log('완료');
