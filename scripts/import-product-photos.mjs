/**
 * 드롭박스 제품사진 → FTP 업로드 + 레퍼런스 보관함 등록.
 *
 * 원본(드롭박스)은 읽기만 한다. 쓰기·이동·삭제를 하는 코드 경로가 이 파일에 없다.
 *
 * 라벨을 확정하지 않는 이유 —
 *   폴더명이 맞다는 보장이 없다. 실측하니 '슬림' 폴더의 41장이 파일명에 midi 를 달고 있었고,
 *   '롤 닷' 은 6장 전부 miniroll 이었다. 그래서 sub(확정 라벨)는 비워두고 근거만 따로 적는다.
 *     folderHint   폴더명 (근거①)
 *     filenameHint 파일명에서 찾은 제품 토큰 (근거②)
 *     labelStatus  agree | folder-only | conflict
 *     sourcePath   드롭박스 원본 경로 — 나중에 언제든 되돌아갈 수 있게
 *   검수 화면에서 conflict 부터 훑어 sub 를 채우면 된다.
 *
 * 파일명 —
 *   lib/ftp.ts 의 sanitizeFilename 은 한글을 전부 _ 로 날려 결국 upload_<타임스탬프> 가 된다.
 *   같은 밀리초에 여러 장이면 덮어쓴다. 그래서 여기서는 <슬러그>_<연번> 으로 직접 짓고
 *   원본 파일명은 title/sourceName 에 남긴다.
 *
 * 사용:
 *   node scripts/import-product-photos.mjs                      # 1차 배치 전체 드라이런
 *   node scripts/import-product-photos.mjs --folder=미디         # 한 폴더만 드라이런
 *   node scripts/import-product-photos.mjs --folder=미디 --go    # 실제 업로드 + 등록
 *   node scripts/import-product-photos.mjs --folder=미디 --unpin # 끝난 폴더 용량 회수(온라인전용 복귀)
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { Client } from 'basic-ftp';
import sharp from 'sharp';

/*
 * sharp 메모리 고삐 — 이걸 안 잡으면 프로세스가 조용히 죽는다.
 *
 * 실측 2026-09-21: 미디 폴더의 46~52MB 사진 3장을 연달아 축소하다가 세 번째에서
 * 종료 코드만 남기고 사라졌다. 원본이 12,769×9,579(122메가픽셀)라 raw 로 펴면
 * 장당 약 367MB 인데, libvips 가 기본적으로 디코딩 결과를 캐시에 쥐고 있어
 * 연속 처리에서 쌓인다. (인수인계 문서의 "exit 127 로 죽음" 도 같은 증상으로 보인다.)
 *
 * cache(false)   디코딩 버퍼를 붙들지 않는다 — 한 장씩 처리하는 이 스크립트엔 캐시가 무의미하다
 * concurrency(1) 동시 스레드 1 — 큰 이미지에서 스레드당 버퍼가 곱절로 든다
 */
sharp.cache(false);
sharp.concurrency(1);

// ── 설정 ────────────────────────────────────────────────────────────────────
const SRC_ROOT = 'C:/Users/Yogibo Design/Yogicorporation Dropbox/요기코퍼레이션_포워드/1. 디자인/2.7 제품사진';

/** 1차 배치 — 파일명 대조에서 신뢰도가 확인된 폴더만. 슬림·롤닷·롤맥스·인물은 검수 후에. */
const BATCH1 = ['미디', '허기보', '더블', '피라미드', '팟', '버블', '라운저', '서포트'];

/** 폴더명 → FTP 폴더 슬러그 (한글 경로는 FTP 에서 사고가 잦다) */
const SLUG = {
  미디: 'midi', 허기보: 'hugibo', 더블: 'double', 피라미드: 'pyramid',
  팟: 'pod', 버블: 'bubble', 라운저: 'lounger', 서포트: 'support',
  맥스: 'max', 미니: 'mini', 드롭: 'drop', 도기보: 'dogibo', 모듀: 'modu',
  메이트: 'mate', 오토만: 'ottoman', 프라임: 'prime', 슬림: 'slim',
  롤맥스: 'rollmax', 롤메이트: 'rollmate', '롤 닷': 'rolldot',
  카터필러_롤맥스: 'caterpillar-rollmax', 카터필러_롤미디: 'caterpillar-rollmidi',
};

/** 파일명에서 찾을 제품 토큰. 긴 것부터 봐야 max 가 rollmax 를 삼키지 않는다. */
const TOKENS = [
  ['rollmax', '롤맥스'], ['roll_max', '롤맥스'], ['roll-max', '롤맥스'],
  ['rollmate', '롤메이트'], ['roll_mate', '롤메이트'],
  ['rollmidi', '카터필러_롤미디'], ['rolldot', '롤 닷'], ['roll_dot', '롤 닷'],
  ['sallyfeel', '샐리필'], ['pyramid', '피라미드'], ['hugibo', '허기보'],
  ['dogibo', '도기보'], ['support', '서포트'], ['ottoman', '오토만'],
  ['lounger', '라운저'], ['lounge', '라운저'], ['bubble', '버블'],
  ['double', '더블'], ['prime', '프라임'], ['modu', '모듀'],
  ['drop', '드롭'], ['slim', '슬림'], ['midi', '미디'], ['mini', '미니'],
  ['mate', '메이트'], ['max', '맥스'], ['pod', '팟'],
].sort((a, b) => b[0].length - a[0].length);

const IMG = /\.(jpe?g|png|webp)$/i;

// ── 인자 ────────────────────────────────────────────────────────────────────
const GO = process.argv.includes('--go');
const UNPIN = process.argv.includes('--unpin');
const folderArg = process.argv.find((a) => a.startsWith('--folder='))?.slice(9);
const targets = folderArg ? [folderArg] : BATCH1;

function readEnv(p) {
  return Object.fromEntries(
    fs.readFileSync(p, 'utf8')
      .split('\n').filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; }),
  );
}
const env = readEnv(fileURLToPath(new URL('../.env.local', import.meta.url)));
const PUBLIC = (env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');
const REMOTE_ROOT = (env.FTP_REMOTE_DIR || '').replace(/\/$/, '');

// ── 수집 ────────────────────────────────────────────────────────────────────
/** 폴더를 재귀로 훑어 이미지 파일 경로를 모은다. 읽기만 한다. */
function walk(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (IMG.test(e.name)) out.push(p);
  }
  return out;
}

/** 파일명에서 제품 토큰을 찾아 폴더명과 대조한다. */
function judge(folder, filename) {
  const name = filename.toLowerCase().replace(/\s+/g, '');
  const hits = [];
  for (const [tok, owner] of TOKENS) {
    if (name.includes(tok) && !hits.some((h) => h.tok.includes(tok))) hits.push({ tok, owner });
  }
  if (!hits.length) return { filenameHint: [], labelStatus: 'folder-only' };
  const agree = hits.some((h) => h.owner === folder);
  return {
    filenameHint: hits.map((h) => h.tok),
    labelStatus: agree ? 'agree' : 'conflict',
  };
}

const plan = [];
for (const folder of targets) {
  const dir = path.join(SRC_ROOT, folder);
  if (!fs.existsSync(dir)) { console.log(`⚠ 폴더 없음: ${folder} — 건너뜀`); continue; }
  const slug = SLUG[folder];
  if (!slug) { console.log(`⚠ 슬러그 미정: ${folder} — 건너뜀`); continue; }
  const files = walk(dir).sort();
  files.forEach((abs, i) => {
    const base = path.basename(abs);
    const ext = (path.extname(base).slice(1) || 'jpg').toLowerCase();
    const rel = path.relative(SRC_ROOT, abs).replace(/\\/g, '/');
    plan.push({
      folder, slug, abs,
      sourcePath: rel,
      sourceName: base,
      remoteName: `${slug}_${String(i + 1).padStart(4, '0')}.${ext}`,
      url: `${PUBLIC}/product/${slug}/${slug}_${String(i + 1).padStart(4, '0')}.${ext}`,
      size: (() => { try { return fs.statSync(abs).size; } catch { return 0; } })(),
      ...judge(folder, base),
    });
  });
}

// ── 이미 등록된 것 제외 ──────────────────────────────────────────────────────
const mc = new MongoClient(env.MONGODB_URI);
await mc.connect();
/*
 * references 가 아니라 dropbox_assets 다 (사용자 결정 2026-09-21).
 * 레퍼런스가 이미 4,600장인데 드롭박스 9,565장을 섞으면 기존 촬영·모델컷 작업이 묻힌다.
 * 화면도 따로다 — 자산 관리 > 드롭박스 (/dropbox).
 */
const col = mc.db(env.MONGODB_DB || undefined).collection('dropbox_assets');
/*
 * sourcePath 는 멱등 키다 — 같은 원본이 두 번 들어오면 안 되므로 unique.
 * (sparse 로 만들면 migrate-dropbox-assets.mjs 가 만든 unique 인덱스와 사양이 달라
 *  IndexKeySpecsConflict 가 난다. 두 곳의 사양을 같게 유지할 것.)
 */
await col.createIndex({ sourcePath: 1 }, { unique: true });

const known = new Set(
  (await col.find({ sourcePath: { $in: plan.map((p) => p.sourcePath) } })
    .project({ sourcePath: 1 }).toArray()).map((d) => d.sourcePath),
);
const todo = plan.filter((p) => !known.has(p.sourcePath));

// ── 요약 ────────────────────────────────────────────────────────────────────
const gb = (n) => (n / 1024 / 1024 / 1024).toFixed(2);
console.log(`\n대상 폴더 ${targets.length}개 · 이미지 ${plan.length}장 (이미 등록 ${known.size}장 제외 → ${todo.length}장)\n`);
console.log('폴더'.padEnd(14) + '장수'.padStart(7) + '일치'.padStart(7) + '충돌'.padStart(7) + '단서없음'.padStart(9) + '용량'.padStart(10));
console.log('-'.repeat(56));
for (const f of targets) {
  const rows = todo.filter((p) => p.folder === f);
  if (!rows.length) continue;
  const a = rows.filter((r) => r.labelStatus === 'agree').length;
  const c = rows.filter((r) => r.labelStatus === 'conflict').length;
  const o = rows.filter((r) => r.labelStatus === 'folder-only').length;
  const sz = rows.reduce((s, r) => s + r.size, 0);
  console.log(f.padEnd(14) + String(rows.length).padStart(7) + String(a).padStart(7)
    + String(c).padStart(7) + String(o).padStart(9) + (gb(sz) + 'GB').padStart(10));
}
console.log('-'.repeat(56));
console.log(`합계 ${todo.length}장 · ${gb(todo.reduce((s, r) => s + r.size, 0))}GB`);
const conflicts = todo.filter((r) => r.labelStatus === 'conflict');
if (conflicts.length) {
  console.log(`\n⚠ 폴더명과 파일명이 어긋나는 것 ${conflicts.length}장 (등록은 하되 sub 는 비워둔다):`);
  conflicts.slice(0, 8).forEach((r) => console.log(`   ${r.folder}/${r.sourceName}  →  ${r.filenameHint.join(',')}`));
  if (conflicts.length > 8) console.log(`   … 외 ${conflicts.length - 8}장`);
}

if (!GO) {
  console.log('\n드라이런입니다. 실제 업로드는 --go 를 붙여 실행하세요.');
  await mc.close();
  process.exit(0);
}

// ── 업로드 + 등록 ───────────────────────────────────────────────────────────
/*
 * cafe24 FTP 는 수백 장을 연속으로 올리는 중에 데이터 소켓을 끊는다(ECONNRESET).
 * 한 번 끊기면 클라이언트가 닫힌 상태로 남아 이후 호출이 전부 실패하므로,
 * 끊김을 정상 경로로 취급해 다시 붙고 이어서 올린다.
 * 업로드는 절대경로로 보낸다 — 재연결 후 작업 디렉토리가 초기화되어도 영향이 없다.
 */
let ftp = null;
async function connect() {
  if (ftp) { try { ftp.close(); } catch { /* 이미 닫힘 */ } }
  ftp = new Client(60000);
  await ftp.access({
    host: (env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, ''),
    port: Number(env.FTP_PORT) || 21,
    user: env.FTP_USER, password: env.FTP_PASS, secure: false,
  });
}

const RECOVERABLE = /ECONNRESET|EPIPE|ETIMEDOUT|ECONNABORTED|closed|socket|Timeout/i;

/** 끊기면 재연결 후 재시도. 복구 불가능한 오류(권한·경로 등)는 그대로 던진다. */
async function withFtp(fn, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      if (!ftp || ftp.closed) await connect();
      return await fn(ftp);
    } catch (e) {
      const msg = `${e.code || ''} ${e.message || ''}`;
      if (i >= attempts || !RECOVERABLE.test(msg)) throw e;
      console.log(`   ↻ 연결 끊김 (${(e.code || e.message || '').slice(0, 40)}) — 재연결 후 재시도 ${i}/${attempts - 1}`);
      await new Promise((r) => setTimeout(r, 1500 * i));
      await connect();
    }
  }
}

/** cafe24 가 용량으로 거부할 때의 응답 — 552 Transfer aborted. File too large */
const TOO_LARGE = /\b552\b|File too large/i;

/**
 * 한 장 업로드 — 원본 그대로 보내고, 서버가 용량으로 거부하면 그때만 줄여서 다시 보낸다.
 *
 * 왜 미리 안 줄이나: 한계값을 모른다. 실측(2026-09-21, 팟 폴더) 16.6MB 는 통과했고
 * 53.5MB / 54.3MB 는 552 로 거부됐다. 그 사이 어딘가라서, 미리 자르면 멀쩡한 사진까지
 * 손해를 본다. 1차 배치 1,687장 중 18MB 초과는 14장(0.8%)뿐이라 "막히면 줄인다" 가 맞다.
 *
 * 줄이는 방식: 긴 변 4500px. 생성 참조로 쓰기에 충분하고 50MB 가 3~5MB 가 된다.
 * 확장자와 내용이 어긋나지 않게 원본 포맷을 그대로 유지한다(png 는 png 로).
 * 드롭박스 원본은 건드리지 않는다 — 여기서도 읽기만 한다.
 */
async function uploadOne(abs, dest) {
  const originalBytes = fs.statSync(abs).size;
  try {
    await withFtp((c) => c.uploadFrom(abs, dest));
    return { resized: false, originalBytes, uploadedBytes: originalBytes };
  } catch (e) {
    if (!TOO_LARGE.test(`${e.code || ''} ${e.message || ''}`)) throw e;
    const isPng = /\.png$/i.test(abs);
    /*
     * sequentialRead: 큰 JPEG 을 줄에 따라 흘려 읽는다 — 전체를 메모리에 펴지 않는다.
     * limitInputPixels: 기본 한계(268MP)를 넘는 것도 받아들이되, 위 cache(false) 와 함께라야 안전하다.
     */
    const img = sharp(abs, { sequentialRead: true, limitInputPixels: 500_000_000, failOn: 'none' })
      .rotate()
      .resize(4500, 4500, { fit: 'inside', withoutEnlargement: true });
    const buf = await (isPng ? img.png({ compressionLevel: 9 }) : img.jpeg({ quality: 88 })).toBuffer();
    await withFtp((c) => c.uploadFrom(Readable.from(buf), dest));
    console.log(`   ⤓ 용량 초과 — 줄여서 올림 ${(originalBytes / 1048576).toFixed(1)}MB → ${(buf.length / 1048576).toFixed(1)}MB  ${path.basename(abs)}`);
    return { resized: true, originalBytes, uploadedBytes: buf.length };
  }
}

await connect();

let done = 0, failed = 0;
const failures = [];
for (const folder of targets) {
  const rows = todo.filter((p) => p.folder === folder);
  if (!rows.length) continue;
  const slug = SLUG[folder];
  const remoteDir = `${REMOTE_ROOT}/product/${slug}`;
  // ensureDir 은 멱등이라 재연결 후 다시 불러도 안전하다.
  await withFtp((c) => c.ensureDir(remoteDir));
  console.log(`\n▶ ${folder} (${rows.length}장) → /product/${slug}/`);

  for (const r of rows) {
    try {
      // 절대경로로 올린다 — 재연결로 cwd 가 초기화돼도 엉뚱한 곳에 안 떨어진다.
      // (폴더는 위에서 한 번 만들어뒀고, 재연결해도 서버에 그대로 남아 있다)
      const up = await uploadOne(r.abs, `${remoteDir}/${r.remoteName}`);   // ← 원본은 읽기만 한다
      await col.updateOne(
        { sourcePath: r.sourcePath },
        {
          $setOnInsert: {
            url: r.url,
            title: r.sourceName.replace(/\.[^.]+$/, ''),
            width: 0, height: 0,
            // category/tags 는 없다 — 컬렉션 자체가 '드롭박스 파일'이라 분류 칸이 필요 없고,
            // 폴더명을 태그로 넣으면 분류처럼 보여서 오히려 해롭다 (아래 folderHint 참고)
            sub: null,                 // 확정 라벨 — 검수 후에 채운다
            folderHint: r.folder,
            filenameHint: r.filenameHint,
            labelStatus: r.labelStatus,
            sourcePath: r.sourcePath,
            sourceName: r.sourceName,
            source: 'dropbox-product',
            // 용량 때문에 줄여 올린 건 그 사실을 남긴다 — 나중에 원본이 필요하면
            // sourcePath 로 드롭박스에서 다시 가져올 수 있어야 한다
            ...(up.resized ? { resized: true, originalBytes: up.originalBytes, uploadedBytes: up.uploadedBytes } : {}),
            active: true,
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );
      done++;
      if (done % 50 === 0) console.log(`   …${done}/${todo.length}`);
    } catch (e) {
      failed++;
      failures.push(`${r.sourcePath}: ${e.message}`);
    }
  }

  // 업로드가 끝난 폴더만 온라인전용으로 되돌려 디스크를 회수한다.
  // 주의: 되돌린 뒤 다시 읽으면 또 내려받아진다 — 끝난 폴더는 건드리지 않는다.
  if (UNPIN) {
    try {
      const win = path.join(SRC_ROOT, folder).replace(/\//g, '\\');
      execFileSync('attrib.exe', ['+U', '-P', `${win}\\*`, '/S'], { stdio: 'ignore' });
      console.log(`   ↩ ${folder} 온라인전용 복귀 요청 (디스크 회수는 드롭박스가 백그라운드로 처리)`);
    } catch (e) {
      console.log(`   ⚠ 온라인전용 복귀 실패: ${e.message}`);
    }
  }
}

ftp.close();
await mc.close();
console.log(`\n완료 — 등록 ${done} · 실패 ${failed}`);
if (failures.length) {
  console.log('실패 목록(최대 10건):');
  failures.slice(0, 10).forEach((f) => console.log('  ' + f));
}
