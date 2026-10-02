/**
 * 외부(MCP 힉스필드 등)에서 생성한 컷을 우리 FTP + 갤러리에 등록한다.
 *
 * 앱의 /api/generate 를 안 거친 생성물은 어디에도 기록이 없다. 이 스크립트가
 * 파일을 /web/design/<날짜>/ 로 옮기고 cuts 문서를 만들어 갤러리에 올린다.
 *
 * 사용: node scripts/import-external-cut.mjs <원본URL> <메타JSON파일>
 *       node scripts/import-external-cut.mjs <원본URL|로컬 파일> --handoff <넘기기 id> [--prompt-file <보낸 프롬프트>] [--model nano_banana_pro] [--title "제목"]
 *
 * --handoff (점검 2026-10-02 5번) — 넘기기 기록에서 나온 컷은 이쪽으로 등록한다.
 *   넘기기 기록의 요청을 앱(/api/generate)에 다시 보내면서 그림만 밖에서 가져오게 한다(external). 그러면
 *   자르기 → 로고 지우기 → 스튜디오 색 보정 → 얼굴·장면 검사 → 제품·모델·참조 기록까지 앱에서 만든 컷과 똑같이 지나가고,
 *   「생성 품질」 화면에도 잡힌다. 엔진은 부르지 않아 생성 비용은 없고 검사 비전 호출만 든다. 개발 서버가 떠 있어야 한다.
 * 메타 JSON 방식은 앱 선택이 없는 작업(배경 넓히기·코드 합성 중간본 등)에만 쓴다 — 검사를 안 타고 promptBase='conversation' 으로 남는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { Client } from 'basic-ftp';
import { Readable } from 'node:stream';
import { MongoClient, ObjectId } from 'mongodb';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return ''; const v = args[i + 1] ?? ''; args.splice(i, 2); return v; };
const handoffId = flag('--handoff');
const promptFile = flag('--prompt-file');
const modelName = flag('--model');
const titleArg = flag('--title');
const [srcUrl, metaPath] = args;

if (handoffId) {
  if (!srcUrl) { console.error('사용: node scripts/import-external-cut.mjs <URL|파일> --handoff <id>'); process.exit(1); }
  const mongo = new MongoClient(env.MONGODB_URI, { maxPoolSize: 2 });
  await mongo.connect();
  const h = await mongo.db(env.MONGODB_DB || 'imgcreate').collection('handoffs').findOne({ _id: new ObjectId(handoffId) });
  await mongo.close();
  if (!h) { console.error('넘기기 기록이 없습니다:', handoffId); process.exit(1); }
  // 요청 본문 — 10/2 이후 기록은 통째로 있고, 그 전 기록은 선택값에서 되살린다(빠진 칸이 있을 수 있다)
  const s = h.selection ?? {};
  const request = h.request ?? {
    mode: s.mode ?? undefined, editTargets: s.editTargets, preservation: s.preservation ?? undefined,
    talents: s.talents, products: s.products, uploadedRefs: s.uploadedRefs, direction: s.direction, sizeValue: s.sizeValue,
  };
  if (!h.request) console.log('주의: 예전 넘기기 기록이라 선택값 일부(구도·변형 등)는 빠진 채로 검사합니다.');
  const src = /^https?:/i.test(srcUrl) ? srcUrl : path.resolve(srcUrl);
  const sent = promptFile ? fs.readFileSync(promptFile, 'utf8') : '';
  const API = process.env.GENERATE_API || 'http://localhost:6100/api/generate';
  let json;
  try {
    const res = await fetch(API, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...request, ...(titleArg ? { title: titleArg } : {}), dryRun: false, promptMode: 'local',
        external: { url: src, handoffId, ...(modelName ? { model: modelName } : {}), ...(sent.trim() ? { prompt: sent } : {}) },
      }),
    });
    json = await res.json();
  } catch (e) {
    console.error('개발 서버에 닿지 못했습니다 (npm run dev 가 떠 있나요?)', e.message);
    process.exit(1);
  }
  const r = (json.results ?? [])[0];
  if (!json.ok || !r?.ok) { console.error('등록 실패:', json.error || r?.error || '알 수 없음'); process.exit(1); }
  console.log('갤러리 등록 완료 · id =', r.id);
  console.log('  ', r.url, `· ${r.width}x${r.height}`);
  // 검사 결과 — 앱 화면의 칩과 같은 내용을 글로
  const q = r.qc ?? {};
  const notes = [];
  if (q.logoErased) notes.push(`로고·태그 ${q.logoErased}곳 지움`);
  if (q.topFold?.suspected) notes.push(`윗부분 말림 의심 — ${q.topFold.note}`);
  if (q.colorFix) notes.push(`색 보정 ΔE ${q.colorFix.before} → ${q.colorFix.after}`);
  for (const v of q.face?.verdicts ?? []) if (v.verdict === 'drift' || v.verdict === 'weak') notes.push(`얼굴 ${v.verdict === 'drift' ? '변형' : '약함'}${v.code ? ` (${v.code})` : ''}${v.note ? ` — ${v.note}` : ''}`);
  if (q.scene?.checked) {
    if (!q.scene.product.ok) notes.push(`제품 불일치 — ${q.scene.product.note}`);
    if (!q.scene.scale.ok) notes.push(`크기 어긋남 — ${q.scene.scale.note}`);
    if (q.scene.light.score > 0 && q.scene.light.score < 75) notes.push(`조명 ${q.scene.light.score}점 — ${q.scene.light.note}`);
    if (q.scene.colour && !q.scene.colour.ok) notes.push(`색 계열 벗어남 — ${q.scene.colour.note}`);
  }
  if (r.deltaE != null && q.studio) notes.push(`컬러 ΔE ${r.deltaE}`);
  console.log(notes.length ? '검사:\n  - ' + notes.join('\n  - ') : '검사: 걸린 것 없음');
  process.exit(0);
}

if (!srcUrl || !metaPath) { console.error('사용: node scripts/import-external-cut.mjs <URL> <meta.json>   또는   <URL|파일> --handoff <id>'); process.exit(1); }
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

// 1) 내려받기 — URL 이면 받아오고, 로컬 경로면 바로 읽는다
//    (후보정한 파일을 다시 어딘가에 올려서 URL 을 만들 필요가 없게)
let raw;
if (/^https?:\/\//i.test(srcUrl)) {
  const res = await fetch(srcUrl);
  if (!res.ok) { console.error('다운로드 실패', res.status); process.exit(1); }
  raw = Buffer.from(await res.arrayBuffer());
} else {
  if (!fs.existsSync(srcUrl)) { console.error('파일이 없습니다:', srcUrl); process.exit(1); }
  raw = fs.readFileSync(srcUrl);
}
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
  // 앱 템플릿 없이 대화에서 처음부터 쓴 프롬프트 — 생성 품질 화면이 넘기기 경로(template)와 따로 센다
  promptBase: meta.promptBase === 'template' ? 'template' : 'conversation',
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
