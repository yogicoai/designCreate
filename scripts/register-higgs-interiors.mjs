import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import sharp from 'sharp';
import { Client } from 'basic-ftp';
import { Readable } from 'node:stream';

/**
 * 대화에서 힉스필드로 뽑은 "빈 인테리어 배경"을 레퍼런스 보관함의 인테리어 칸에 넣는다.
 *
 * 왜 cuts 가 아니라 references 인가 (사용자 요청 2026-09-21):
 *   이 사진들은 완성 컷이 아니라 ⑥ 배경 변경에 넣는 재료다. 레퍼런스 보관함의 인테리어는
 *   ⑥ 에서 보관함을 열면 맨 앞에 나오므로, 여기 있어야 MD 가 바로 골라 쓴다.
 *   (제품 형태 시트를 ai_products 에 따로 두는 것과 같은 이유 — 배너 배경 목록에 섞이지 않게)
 *
 * 크기는 채널 실제 규격으로 자른다(cover): 16:9 → 1920×1080 · 4:5 → 1080×1350 · 1:1 → 1300×1300
 * 파일 이름은 힉스필드 job id 에서 만든다 — 다시 돌려도 같은 이름이라 두 번 올라가지 않는다.
 * cafe24 는 업로드가 조용히 잘릴 수 있어서, 올린 뒤 서버 쪽 크기가 맞는지 확인하고 틀리면 다시 올린다.
 *
 * 사용: node --env-file=.env.local scripts/register-higgs-interiors.mjs <manifest.json> [--save=<폴더>]
 *   manifest: [{ index, jobId, url, sub, ratio, w, h, title, tags, prompt }]
 *   --save: 올린 파일을 이 폴더에도 남긴다(검수용 밀착 인화에 쓴다)
 */

const HOST = (process.env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, '').replace(/\/$/, '');
const PORT = Number(process.env.FTP_PORT) || 21;
const USER = process.env.FTP_USER || '';
const PASS = process.env.FTP_PASS || '';
const ROOT = (process.env.FTP_REMOTE_DIR || '/web/img/imgc').replace(/^\/|\/$/g, '');
const PUBLIC_BASE = (process.env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');
const SUB = 'update'; // src/lib/ftp.ts 의 REF_SUBPATH — 레퍼런스 업로드와 같은 폴더

const manifestPath = process.argv[2];
const saveDir = process.argv.find((a) => a.startsWith('--save='))?.slice(7);
if (!manifestPath) { console.error('manifest 경로가 필요합니다'); process.exit(1); }
if (!HOST || !USER) { console.error('FTP 설정 없음'); process.exit(1); }
if (saveDir) fs.mkdirSync(saveDir, { recursive: true });

async function putVerified(filename, buf) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const c = new Client(30000);
    try {
      await c.access({ host: HOST, port: PORT, user: USER, password: PASS, secure: false });
      await c.ensureDir(`${ROOT}/${SUB}`);
      await c.uploadFrom(Readable.from(buf), filename);
      const size = await c.size(filename);
      if (size === buf.length) return `${PUBLIC_BASE}/${SUB}/${filename}`;
      console.log(`   ↻ 크기 불일치 ${size}/${buf.length} — 다시 올림 ${attempt}/3`);
    } catch (e) {
      console.log(`   ↻ 업로드 오류 (${e.code || e.message}) — 다시 ${attempt}/3`);
    } finally { c.close(); }
  }
  throw new Error('업로드 3회 실패');
}

const items = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const mc = new MongoClient(process.env.MONGODB_URI);
await mc.connect();
const refs = mc.db(process.env.MONGODB_DB || undefined).collection('references');

let added = 0, skipped = 0;
const failed = [];
for (const it of items) {
  try {
    if (!it.jobId || !it.url) throw new Error('jobId/url 없음');
    if (await refs.findOne({ higgsJobId: it.jobId }, { projection: { _id: 1 } })) { skipped++; continue; }

    const res = await fetch(it.url);
    if (!res.ok) throw new Error(`받기 실패 ${res.status}`);
    const raw = Buffer.from(await res.arrayBuffer());
    const out = await sharp(raw).resize(it.w, it.h, { fit: 'cover' }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();

    const filename = `ref_higgs_${it.jobId.replace(/-/g, '').slice(0, 16)}.jpg`;
    const url = await putVerified(filename, out);
    if (saveDir) fs.writeFileSync(path.join(saveDir, `${String(it.index).padStart(3, '0')}.jpg`), out);

    const now = new Date();
    await refs.insertOne({
      url, title: it.title,
      width: it.w, height: it.h, bytes: out.length,
      category: 'interior', sub: it.sub,
      tags: it.tags ?? [],
      source: 'higgsfield',
      higgsJobId: it.jobId, higgsIndex: it.index, prompt: it.prompt,
      note: '빈 인테리어 배경 — ⑥ 배경 변경용 (힉스필드 nano_banana_pro 2K, 대화에서 생성)',
      active: true, createdAt: now, updatedAt: now,
    });
    added++;
    console.log(`등록 #${it.index} ${it.title} → ${filename}`);
  } catch (e) {
    failed.push({ index: it.index, error: e.message });
    console.log(`✗ #${it.index} ${e.message}`);
  }
}
await mc.close();
console.log(`완료 — 등록 ${added} · 이미 있음 ${skipped} · 실패 ${failed.length}`);
if (failed.length) console.log('실패:', JSON.stringify(failed));
