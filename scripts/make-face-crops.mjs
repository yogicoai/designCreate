import fs from 'node:fs';
import { MongoClient } from 'mongodb';
import sharp from 'sharp';
import { Client } from 'basic-ftp';
import { Readable } from 'node:stream';

/**
 * 전속 모델의 ① 페이스 턴어라운드 시트(16:9 가로 5칸)를 칸별로 잘라 talents.faceCrops 에 넣는다.
 *
 * 왜 필요한가 (2026-09-23): 생성에 들어가는 얼굴 참조는 대표컷(정면 3:4)과 표정 조각(정면) 둘뿐이라,
 * 컷에서 인물이 고개를 돌리면 모델이 옆얼굴을 스스로 지어낸다. 실측으로 유럽계 여성(W_A)이
 * 동아시아 여성으로 바뀌어 나왔다 — 얼굴 대조 40점. 시트에는 3/4·옆모습이 이미 다 들어 있는데
 * 생성에는 한 번도 안 들어가고 얼굴 검사(face-guard) 대조용으로만 쓰였다.
 *
 * 시트를 통째로 넣지 않는 이유: 5칸이 한꺼번에 보이면 결과 얼굴이 굳거나 흔들린다
 * (prompt-writer 의 repShot 주석 — 기존 팀 규칙 + 실사용 피드백). 그래서 칸 하나만 골라 넣는다.
 *
 * 자르기: 균등 분할은 금지다. 생성 모델은 칸을 정확히 1/5 로 나눠주지 않는다 —
 * 실측(3168px 5칸)에서 경계가 703/1318/1901/2495 로 나왔다(균등이면 634/1267/1901/2534).
 * src/lib/sheet-slice.ts 의 findColumnCuts 와 같은 방식으로 '거의 흰 세로 여백' 을 찾아 경계를 잡는다.
 * 그 모듈은 server-only 라 스크립트에서 import 할 수 없어 로직을 옮겨 왔다.
 *
 * 파일명은 날짜를 박아 새 이름으로만 올린다 — cafe24 는 7일 캐시라 덮어쓰면 옛 그림이 남는다.
 *
 * 사용: node --env-file=.env.local scripts/make-face-crops.mjs --codes=W_A,W_B [--date=20260923] [--dry]
 *   --codes 없이 돌리면 faceCrops 가 아직 없는 모델 전부를 자른다 (이미 있는 모델은 건너뛴다).
 */

const HOST = (process.env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, '').replace(/\/$/, '');
const PORT = Number(process.env.FTP_PORT) || 21;
const ROOT = (process.env.FTP_REMOTE_DIR || '/web/img/imgc').replace(/^\/|\/$/g, '');
const BASE = (process.env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');
const SUB = 'talents';
sharp.cache(false);

/*
 * 칸 순서는 등록 형식으로 고정돼 있다 — 정면 · 3/4 · 옆 · 3/4 · 옆.
 * 좌/우는 실측으로 확인했다(W_A, 2026-09-23): _l 은 얼굴이 화면 왼쪽을 향하고 _r 은 오른쪽을 향한다.
 * 그래서 두 사람이 마주 보는 컷에서 왼쪽 사람에게 _r, 오른쪽 사람에게 _l 을 줄 수 있다.
 */
const PANEL_IDS = ['front', 'three_quarter_l', 'profile_l', 'three_quarter_r', 'profile_r'];

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--codes=')) || '').slice(8).split(',').filter(Boolean);
const DATE = (args.find((a) => a.startsWith('--date=')) || '').slice(7) || new Date().toISOString().slice(0, 10).replace(/-/g, '');
const DRY = args.includes('--dry');

/** 칸 사이의 '거의 흰 세로 구간' 중앙을 경계로 삼는다 — 못 찾은 자리만 균등값으로 메운다 */
async function findColumnCuts(img, panels) {
  const { data, info } = await sharp(img).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;

  const white = [];
  for (let x = 0; x < W; x++) {
    let mn = 255;
    for (let y = 0; y < H; y += 4) {
      const v = data[y * W + x];
      if (v < mn) mn = v;
    }
    if (mn > 225) white.push(x);
  }

  const runs = [];
  let st = -1;
  let prev = -2;
  for (const x of white) {
    if (x !== prev + 1) { if (st >= 0) runs.push([st, prev]); st = x; }
    prev = x;
  }
  if (st >= 0) runs.push([st, prev]);

  const mids = runs
    .filter((r) => r[1] - r[0] >= 6 && r[0] > W * 0.05 && r[1] < W * 0.95)
    .map((r) => Math.round((r[0] + r[1]) / 2));

  const want = Array.from({ length: panels - 1 }, (_, i) => Math.round((W * (i + 1)) / panels));
  const picked = want.map((w) => {
    const near = mids
      .filter((m) => Math.abs(m - w) < W * 0.09)
      .sort((a, b) => Math.abs(a - w) - Math.abs(b - w));
    return near.length ? near[0] : w;
  });
  for (let i = 1; i < picked.length; i++) {
    if (picked[i] <= picked[i - 1]) picked[i] = want[i];
  }
  return { bounds: [0, ...picked, W], width: W, height: H, detected: picked.map((p, i) => p !== want[i]) };
}

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

const mc = new MongoClient(process.env.MONGODB_URI);
await mc.connect();
const db = mc.db(process.env.MONGODB_DB || undefined);
const talents = db.collection('talents');

const q = only.length ? { code: { $in: only } } : {};
const list = (await talents.find(q).sort({ order: 1 }).toArray())
  .filter((t) => t.sheets?.face)
  .filter((t) => only.length || !Object.keys(t.faceCrops || {}).length);

if (!list.length) { console.log('대상 없음 (얼굴 시트가 있고 아직 안 자른 모델이 없다)'); await mc.close(); process.exit(0); }
console.log(`${list.length}명 · 날짜 ${DATE}${DRY ? ' · 시험만(업로드·저장 안 함)' : ''}`);

for (const t of list) {
  const res = await fetch(t.sheets.face);
  if (!res.ok) { console.log(`✗ ${t.code} 시트 받기 실패 ${res.status}`); continue; }
  const sheet = Buffer.from(await res.arrayBuffer());
  const { bounds, width, height, detected } = await findColumnCuts(sheet, PANEL_IDS.length);
  const widths = PANEL_IDS.map((_, i) => bounds[i + 1] - bounds[i]);
  const even = Math.round(width / PANEL_IDS.length);
  console.log(`\n${t.code} ${t.name || ''} — ${width}x${height}`);
  console.log(`  경계 ${bounds.slice(1, -1).join('/')} (균등이면 ${PANEL_IDS.slice(0, -1).map((_, i) => Math.round((width * (i + 1)) / PANEL_IDS.length)).join('/')})`);
  console.log(`  칸 폭 ${widths.join('/')} · 검출 ${detected.filter(Boolean).length}/${detected.length}${widths.some((w) => Math.abs(w - even) > even * 0.15) ? ' ⚠ 폭이 고르지 않다' : ''}`);

  const crops = {};
  for (let i = 0; i < PANEL_IDS.length; i++) {
    const left = bounds[i];
    const w = bounds[i + 1] - bounds[i];
    if (w < 8) { console.log(`  ✗ ${PANEL_IDS[i]} 칸이 너무 좁다 (${w}px)`); continue; }
    const buf = await sharp(sheet).extract({ left, top: 0, width: w, height }).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    if (DRY) {
      const out = `C:/Users/YOGIBO~1/AppData/Local/Temp/claude/c--Users-Yogibo-Design-Desktop-imgCreate/0b7908b6-bb66-4fb2-92ce-5dcfd7df4943/scratchpad/face_${t.code}_${PANEL_IDS[i]}.jpg`;
      fs.writeFileSync(out, buf);
      console.log(`  · ${PANEL_IDS[i]} ${w}px → ${out}`);
      continue;
    }
    crops[PANEL_IDS[i]] = await putVerified(`${t.code}_face_${PANEL_IDS[i]}_${DATE}.jpg`, buf);
    console.log(`  ✓ ${PANEL_IDS[i]} ${w}px`);
  }
  if (DRY) continue;
  // 표정 조각과 같은 형태로 맵을 통째로 넣는다 — 한 칸이라도 빠지면 그 모델은 다시 돌린다
  if (Object.keys(crops).length !== PANEL_IDS.length) { console.log(`  ✗ ${t.code} 칸이 모자라 저장하지 않는다`); continue; }
  await talents.updateOne({ _id: t._id }, { $set: { faceCrops: crops } });
  console.log(`  저장 완료`);
}

await mc.close();
