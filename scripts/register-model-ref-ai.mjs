import fs from 'node:fs';
import { MongoClient, ObjectId } from 'mongodb';
import sharp from 'sharp';
import { Client } from 'basic-ftp';
import { Readable } from 'node:stream';

/**
 * 대화에서 힉스필드로 뽑은 AI 모델 얼굴을 「모델 레퍼런스」(model_refs) 카드에 붙인다.
 *
 * 두 가지 모양:
 *   sheet — 얼굴 시트(정면·3/4·옆모습 5칸 가로 한 줄). 칸별로 잘라 aiPanels 에 넣고 정면(1칸)을 aiFront 로.
 *           예전 카드들과 같은 모양이다 (facesheet_*_p1~p5).
 *   front — 정면샷 한 장. aiCut·aiFront·aiPanels 가 모두 그 한 장.
 *
 * 카드가 이미 있으면(id) AI 결과만 채우고, 없으면(create) 새 카드를 만든다.
 * 새 카드는 앱 API(POST /api/model-refs)로 만든다 — 사이즈 문장("Max 170 기준 …")을 서버가 조립하므로.
 * 파일은 cafe24 /web/design/models/ 에 새 이름으로만 올린다(7일 캐시 — 덮어쓰지 않는다).
 *
 * 사용: node --env-file=.env.local scripts/register-model-ref-ai.mjs <manifest.json> [--api=http://localhost:6100]
 *   manifest: [{ mode:'sheet'|'front', url, fileBase, id?, create?:{name,age,heightCm,bodyType,fitPct,note}, note? }]
 */

const HOST = (process.env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, '').replace(/\/$/, '');
const PORT = Number(process.env.FTP_PORT) || 21;
const ROOT = (process.env.FTP_REMOTE_DIR || '/web/img/imgc').replace(/^\/|\/$/g, '');
const BASE = (process.env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');
const SUB = 'models';
const PANELS = 5;

const manifestPath = process.argv[2];
const API = process.argv.find((a) => a.startsWith('--api='))?.slice(6) || 'http://localhost:6100';
if (!manifestPath) { console.error('manifest 경로가 필요합니다'); process.exit(1); }
sharp.cache(false);

async function putVerified(name, buf) {
  for (let a = 1; a <= 3; a++) {
    const c = new Client(30000);
    try {
      await c.access({ host: HOST, port: PORT, user: process.env.FTP_USER, password: process.env.FTP_PASS, secure: false });
      await c.ensureDir(`${ROOT}/${SUB}`);
      if (await c.size(name).catch(() => -1) >= 0) throw new Error(`이미 있는 이름 ${name} — 덮어쓰지 않는다`);
      await c.uploadFrom(Readable.from(buf), name);
      if ((await c.size(name)) === buf.length) return `${BASE}/${SUB}/${name}`;
      console.log(`   ↻ 크기 불일치 — 다시 ${a}/3`);
    } catch (e) {
      if (String(e.message).startsWith('이미 있는 이름')) throw e;
      console.log(`   ↻ 업로드 오류 (${e.code || e.message}) — 다시 ${a}/3`);
    } finally { c.close(); }
  }
  throw new Error('업로드 3회 실패');
}

const items = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const mc = new MongoClient(process.env.MONGODB_URI);
await mc.connect();
const col = mc.db(process.env.MONGODB_DB || undefined).collection('model_refs');

for (const it of items) {
  const res = await fetch(it.url);
  if (!res.ok) { console.log('✗ 받기 실패', it.fileBase, res.status); continue; }
  const raw = Buffer.from(await res.arrayBuffer());
  const sheet = await sharp(raw).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  const aiCut = await putVerified(`${it.fileBase}.jpg`, sheet);

  let aiPanels = [aiCut];
  if (it.mode === 'sheet') {
    // 5칸 가로 한 줄 — 같은 폭으로 자른다 (예전 시트와 같은 방식)
    const { width, height } = await sharp(sheet).metadata();
    const w = Math.floor(width / PANELS);
    aiPanels = [];
    for (let i = 0; i < PANELS; i++) {
      const p = await sharp(sheet).extract({ left: i * w, top: 0, width: w, height }).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
      aiPanels.push(await putVerified(`${it.fileBase}_p${i + 1}.jpg`, p));
    }
  }
  const aiFront = aiPanels[0];

  if (it.id) {
    const set = { aiCut, aiFront, aiPanels, aiStatus: 'done', updatedAt: new Date() };
    if (it.note) set.note = it.note;
    const r = await col.updateOne({ _id: new ObjectId(it.id) }, { $set: set });
    console.log(`카드 갱신 ${it.id} (${r.modifiedCount}) → ${aiFront}`);
  } else if (it.create) {
    const body = { ...it.create, rep: aiFront, aiCut, aiFront, aiPanels, aiStatus: 'done' };
    const r = await fetch(`${API}/api/model-refs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (!j?.ok) { console.log('✗ 카드 생성 실패', it.create.name, j?.error ?? r.status); continue; }
    console.log(`새 카드 ${it.create.name} (${j.id}) → ${aiFront}`);
  }
}
await mc.close();
console.log('완료');
