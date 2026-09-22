import fs from 'node:fs';
import { MongoClient, ObjectId } from 'mongodb';
import sharp from 'sharp';
import { Client } from 'basic-ftp';
import { Readable } from 'node:stream';

/**
 * 모델 레퍼런스(model_refs) 카드를 전속 모델(talents)로 옮긴다 — 대화에서 힉스필드로 뽑은 3종 시트와 함께.
 *
 * 형식은 기존 전속 모델과 같다 (메모: 전속 모델 등록 형식):
 *   ① face 16:9 5칸 · ② expr 16:9 2줄×4칸(8표정) · ③ body 16:9 5칸 전신 · rep 3:4 정면
 *   rep 는 모델 레퍼런스 카드의 정면샷(aiFront)을 그대로 쓴다.
 * 표정 조각(expressionCrops)은 등록 뒤 make-expression-crops.mjs --codes=… 로 자른다.
 * 옮긴 모델 레퍼런스 카드는 hidden 처리한다(삭제 아님). createdAt 을 넣어야 하루 동안 "N" 이 뜬다.
 * 순서: order 를 끼워 넣고 뒤 모델들을 민다 — manifest 의 order 는 최종 자리, shift 는 기존 모델 이동표.
 *
 * 사용: node --env-file=.env.local scripts/register-talents-ai.mjs <manifest.json>
 *   manifest: { date:'20260922', shift:{M_A:7,...}, talents:[{ code, category, slot, name, identity, identityEn,
 *               thumbDesc, age, heightCm, bodyType, order, modelRefId, face, expr, body, jobs:{face,expr,body} }] }
 */

const HOST = (process.env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, '').replace(/\/$/, '');
const PORT = Number(process.env.FTP_PORT) || 21;
const ROOT = (process.env.FTP_REMOTE_DIR || '/web/img/imgc').replace(/^\/|\/$/g, '');
const BASE = (process.env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');
const SUB = 'talents';
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
    } catch (e) {
      if (String(e.message).startsWith('이미 있는 이름')) throw e;
      console.log(`   ↻ 업로드 오류 (${e.code || e.message}) — 다시 ${a}/3`);
    } finally { c.close(); }
  }
  throw new Error('업로드 3회 실패');
}
async function fetchJpg(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`받기 실패 ${r.status} ${url}`);
  return sharp(Buffer.from(await r.arrayBuffer())).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}

const m = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const mc = new MongoClient(process.env.MONGODB_URI);
await mc.connect();
const db = mc.db(process.env.MONGODB_DB || undefined);
const talents = db.collection('talents');
const refs = db.collection('model_refs');

// 이미 있는 코드면 멈춘다 — 다른 모델을 덮으면 안 된다
const clash = await talents.find({ code: { $in: m.talents.map((t) => t.code) } }).project({ code: 1 }).toArray();
if (clash.length) { console.error('이미 있는 코드:', clash.map((c) => c.code).join(', ')); process.exit(1); }

for (const t of m.talents) {
  const ref = await refs.findOne({ _id: new ObjectId(t.modelRefId) });
  if (!ref?.aiFront) throw new Error(`모델 레퍼런스 ${t.modelRefId} 에 정면샷이 없음`);
  const sheets = {};
  for (const k of ['face', 'expr', 'body']) sheets[k] = await putVerified(`${t.code}_${k}_${m.date}.jpg`, await fetchJpg(t[k]));
  const rep = await putVerified(`${t.code}_rep_${m.date}.jpg`, await fetchJpg(ref.aiFront));
  const now = new Date();
  await talents.insertOne({
    _id: t.code, code: t.code, category: t.category, slot: t.slot, name: t.name,
    identity: t.identity, identityEn: t.identityEn,
    size: ref.size, sizeEn: ref.sizeEn, age: t.age, heightCm: t.heightCm, bodyType: t.bodyType,
    thumbDesc: t.thumbDesc, rep, sheets, exprSheet: sheets.expr, outfits: [],
    status: '①얼굴 ②표정 ③바디 완료 ✅ (힉스필드 나노바나나 프로 2K)',
    order: t.order, active: true,
    source: { modelRef: t.modelRefId, faceJob: t.jobs.face, exprJob: t.jobs.expr, bodyJob: t.jobs.body, createdAt: now },
    createdAt: now,
  });
  await refs.updateOne({ _id: ref._id }, { $set: { hidden: true, movedToTalent: t.code, updatedAt: now } });
  console.log(`등록 ${t.code} ${t.name} (order ${t.order}) · 모델 레퍼런스 카드 숨김`);
}
for (const [code, order] of Object.entries(m.shift ?? {})) {
  await talents.updateOne({ code }, { $set: { order } });
}
console.log('순서:', (await talents.find({}).sort({ order: 1 }).project({ code: 1, order: 1 }).toArray()).map((d) => `${d.code}:${d.order}`).join(' '));
await mc.close();
