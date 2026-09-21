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
import { createHash } from 'node:crypto';
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
const DESIGN = 'C:/Users/Yogibo Design/Yogicorporation Dropbox/요기코퍼레이션_포워드/1. 디자인';

/*
 * 어느 드롭박스 폴더에서 가져오는가. 기본은 제품사진이고, `--root=촬영2022` 처럼 별칭으로 바꾼다.
 * 촬영 아카이브(2.6 촬영)는 12만 장·1TB 라 통째로는 못 넣는다 — 필요한 하위 폴더만 집어서 쓴다
 * (사용자 결정 2026-09-21: 스퀴지보·메이트·서포트·더블).
 */
const ROOTS = {
  제품사진: `${DESIGN}/2.7 제품사진`,
  촬영2022: `${DESIGN}/2.6 촬영/2022촬영 (본사 스튜디오 제품촬영)`,
  촬영: `${DESIGN}/2.6 촬영`,
  누끼: `${DESIGN}/2.7_2 누끼`,
  브랜드: `${DESIGN}/0. 브랜드 이미지 (2025 월별 글로벌 에셋 정리)`,
};
const rootArg = process.argv.find((a) => a.startsWith('--root='))?.slice(7) || '제품사진';
const SRC_ROOT = ROOTS[rootArg] || rootArg;   // 별칭이 없으면 경로를 그대로 받는다

/*
 * 브랜드 정리 (사용자 요청 2026-09-21) — 제품사진과 다르게 다룬다.
 *   · 폴더명이 곧 캠페인 이름(「04월 (PASTEL LOVE)」, 「#1_Winter (12~2월)」)이라 **그대로 믿는다.**
 *     제품사진처럼 파일명과 대조하지 않고, 폴더명을 확정 라벨(sub)로 바로 넣는다.
 *   · 라벨은 파일이 들어 있는 **맨 안쪽 폴더** — `기존/04월 (PASTEL LOVE)/x.jpg` 면 「04월 (PASTEL LOVE)」.
 *   · 상위 묶음(group)은 「시즌」(#1~#4) 또는 「월별」(기존/…) — 화면에서 칩을 두 줄로 나눈다.
 *   · FTP 는 /brand/ 아래 — 제품사진(/product/)과 섞이지 않게.
 */
const SECTION = rootArg === '브랜드' ? 'brand' : 'product';
const FTP_BASE = SECTION === 'brand' ? 'brand' : 'product';
/** 브랜드 정리의 칩은 하나다 — 캠페인은 제목으로 간다 */
const BRAND_BUCKET = '브랜드 정리';
function brandLabel(abs) {
  const rel = path.relative(SRC_ROOT, abs).replace(/\\/g, '/').split('/');
  const leaf = rel.length > 1 ? rel[rel.length - 2] : '(분류없음)';
  const group = rel[0].startsWith('#') ? '시즌' : '월별';
  return { leaf, group };
}

/*
 * 원격 파일명 = `<슬러그>_<출처>_<원본경로 해시>`.
 *
 * ⚠ 예전에는 `<슬러그>_<폴더 안 정렬 순번>` 이었다. 그러면 드롭박스 폴더에 파일이 하나 끼어드는
 *   순간 그 뒤 번호가 전부 한 칸씩 밀려, **새 파일이 이미 올라간 다른 사진의 FTP 파일을 덮어쓰고**
 *   두 문서가 같은 URL 을 가리키게 된다 (2026-09-21 적대적 검토에서 확인). 제품사진(표시 없음)과
 *   촬영2022(s22 없이 올라간 3,865장)의 `support_NNNN.jpg` 가 겹칠 수 있었던 것도 같은 원인이다.
 *   멱등 키(sourcePath)의 해시로 지으면 같은 원본은 늘 같은 이름, 다른 원본은 절대 같은 이름이
 *   될 수 없다. 옛 이름(`_NNNN`, `_NNNN_r2`, `_s22_NNNN`, `_br_NNNN`)과도 모양이 달라 안 겹친다.
 *   이미 올라간 문서의 URL 은 DB 에 저장돼 있고 재실행 때 건너뛰므로 바뀌지 않는다.
 */
const ROOT_TAG = { 제품사진: 'p', 촬영2022: 's22', 촬영: 'sh', 누끼: 'nk', 브랜드: 'br' };
const TAG = ROOT_TAG[rootArg] ?? 'x';
const fileBase = (slug, sourcePath) =>
  `${slug}_${TAG}_${createHash('sha1').update(sourcePath).digest('hex').slice(0, 12)}`;

/** 1차 배치 — 파일명 대조에서 신뢰도가 확인된 폴더만. 슬림·롤닷·롤맥스·인물은 검수 후에. */
const BATCH1 = ['미디', '허기보', '더블', '피라미드', '팟', '버블', '라운저', '서포트'];

/*
 * 2차 배치 — 제품 DB 에 치수가 등록돼 있어 나중에 라벨을 확정할 근거가 있는 것만 (사용자 결정 2026-09-21).
 * 도기보 754 · 모듀 63 · 프라임 26 · 오토만 24 는 "필요 없는 제품" 이라 올리지 않는다.
 * 메이트 46 은 치수가 있으나 사용자가 우선순위에서 뺐다 — 나중에 따로.
 */
const BATCH2 = ['맥스', '미니', '드롭'];

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
/*
 * macOS 리소스 포크(AppleDouble) — 맥에서 만든 파일 옆에 `._이름.jpg` 로 남는 메타데이터 껍데기다.
 * 확장자가 .jpg 라 IMG 를 통과하지만 이미지가 아니다 (sharp: "unsupported image format").
 * 실측 2026-09-21: 더블 폴더에서 10개가 딸려 들어왔다.
 */
const APPLE_DOUBLE = /(^|[\\/])\._/;
const isImage = (name) => IMG.test(name) && !APPLE_DOUBLE.test(name);

// ── 인자 ────────────────────────────────────────────────────────────────────
const GO = process.argv.includes('--go');
const UNPIN = process.argv.includes('--unpin');
const folderArg = process.argv.find((a) => a.startsWith('--folder='))?.slice(9);
const BATCH = process.argv.includes('--batch2') ? BATCH2 : BATCH1;
/*
 * 브랜드 정리는 폴더가 85장뿐이고 전부 가져온다 — 제품사진용 배치 목록(BATCH1/2)은 폴더명이
 * 맞지 않으므로, 루트 바로 아래 폴더를 전부 대상으로 삼는다.
 */
const targets = folderArg
  ? [folderArg]
  : SECTION === 'brand'
    ? fs.readdirSync(SRC_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : BATCH;

/*
 * 브랜드 루트 바로 아래(폴더 없이)에 놓인 사진은 위 대상에 안 잡힌다 — 조용히 빠지지 않게 알린다.
 * 캠페인 이름을 폴더명에서 가져오는 구조라, 폴더 밖 사진은 사람이 캠페인 폴더에 넣어야 한다.
 */
if (SECTION === 'brand' && !folderArg) {
  const loose = fs.readdirSync(SRC_ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && isImage(e.name)).map((e) => e.name);
  if (loose.length) {
    console.log(`⚠ 브랜드 루트에 폴더 없이 놓인 사진 ${loose.length}장은 캠페인을 알 수 없어 건너뜁니다 — 캠페인 폴더에 넣은 뒤 다시 돌리세요:`);
    loose.slice(0, 10).forEach((n) => console.log(`   ${n}`));
  }
}

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
  /*
   * 깊이 제한은 무한 루프(링크 순환) 방지용 안전장치일 뿐이다 — 실제 폴더 구조를 자르면 안 된다.
   * 예전엔 4 였는데, 2.6 촬영/2024촬영 이 6단계까지 들어가 있어 94장이 조용히 빠질 뻔했다
   * (2026-09-21, scripts/audit-dropbox-coverage.mjs 로 확인). 드롭박스 폴더는 이만큼 깊지 않다.
   */
  if (depth > 20) { console.log(`⚠ 폴더가 20단계보다 깊어 더 내려가지 않음: ${dir}`); return out; }
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (isImage(e.name)) out.push(p);
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
  /*
   * FTP 폴더 이름. 표에 없으면 폴더명을 로마자 안전 문자열로 만들어 쓴다 —
   * 촬영 아카이브의 폴더명(맥스_롤맥스_서포트 등)은 SLUG 표에 없는 것이 많고,
   * 한글 경로는 FTP 에서 사고가 잦다.
   */
  const slug = SLUG[folder] || `x${Buffer.from(folder).toString('hex').slice(0, 16)}`;
  const files = walk(dir).sort();
  files.forEach((abs, i) => {
    const base = path.basename(abs);
    /*
     * sourcePath 는 멱등 키(unique)다. 루트 별칭을 앞에 붙여야 다른 드롭박스 폴더의
     * 같은 상대경로와 안 겹친다 — 제품사진에도 `서포트/`, 촬영2022 에도 `서포트/` 가 있다.
     * (2026-09-21: 이 접두사 없이 촬영2022 를 한 번 넣었고, 하위 폴더 구조가 달라 우연히
     *  안 겹쳤다. scripts/migrate-dropbox-sourcepath.mjs 가 그 문서들에 접두사를 채웠다.)
     */
    const rel = `${rootArg}/${path.relative(SRC_ROOT, abs).replace(/\\/g, '/')}`;
    plan.push({
      folder, slug, abs,
      sourcePath: rel,
      sourceName: base,
      remoteName: `${fileBase(slug, rel)}.jpg`,
      url: `${PUBLIC}/${FTP_BASE}/${slug}/${fileBase(slug, rel)}.jpg`,
      size: (() => { try { return fs.statSync(abs).size; } catch { return 0; } })(),
      // 브랜드 정리는 폴더명을 믿으므로 파일명 대조를 하지 않는다 — 전부 '일치' 로 둔다
      ...(SECTION === 'brand'
        ? { filenameHint: [], labelStatus: 'agree', brand: brandLabel(abs) }
        : judge(folder, base)),
    });
  });
}

/*
 * 브랜드 정리의 제목 — 캠페인 이름 + 캠페인 안 번호 ('04월 (PASTEL LOVE) 01').
 * 번호는 캠페인 안에서 원본 경로 순으로 매긴다 — scripts/migrate-brand-titles.mjs 와 같은 순서라
 * 이미 들어간 85장과 번호가 맞는다. 나중에 캠페인 중간에 파일이 끼어들면 새 파일의 번호가
 * 기존 것과 겹칠 수 있지만 제목은 키가 아니라(sourcePath 가 키) 표시만 겹친다.
 */
if (SECTION === 'brand') {
  const seq = new Map();
  for (const p of [...plan].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))) {
    const c = p.brand.leaf;
    const n = (seq.get(c) || 0) + 1;
    seq.set(c, n);
    p.brandTitle = `${c.replace(/\s+/g, ' ').trim()} ${String(n).padStart(2, '0')}`;
  }
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

const MAX_EDGE = 2000;
const QUALITY = 82;

/**
 * 한 장 올리고 **검증한다.**
 *
 * 원본을 그대로 올리지 않는다 — 이건 웹용 라이브러리이고 원본 화질은 드롭박스에 그대로 있다.
 * 긴 변 2000px 로 줄이면 원본 8.19GB 가 265MB(3.2%)가 되고, 목록 썸네일 생성이
 * 장당 4,481ms 에서 44~236ms 로 떨어진다(실측 2026-09-21). 552(용량 한계)도 사라진다.
 *
 * 그리고 올린 뒤 **원격 크기를 대조한다.** 이게 없어서 1차 배치 1,687장 중 1,122장(66.8%)이
 * 잘린 채 "성공" 으로 남았다 — cafe24 가 전송 중 소켓을 끊어도 basic-ftp 가 항상 예외를
 * 던지지는 않기 때문이다. 잘린 JPEG 도 HTTP 200 을 주므로 접근 확인으로는 못 잡는다.
 */
async function uploadOne(abs, dest, tries = 3) {
  const srcBytes = fs.statSync(abs).size;
  const buf = await sharp(abs, { sequentialRead: true, limitInputPixels: 500_000_000, failOn: 'none' })
    .rotate()
    .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: QUALITY })
    .toBuffer();
  const meta = await sharp(buf).metadata();

  for (let i = 1; i <= tries; i++) {
    await withFtp((c) => c.uploadFrom(Readable.from(buf), dest));
    let remote = -1;
    try { remote = await withFtp((c) => c.size(dest)); } catch { /* size 미지원 서버 대비 */ }
    if (remote === buf.length) {
      return { ok: true, srcBytes, uploadedBytes: buf.length, width: meta.width ?? 0, height: meta.height ?? 0 };
    }
    if (i === tries) return { ok: false, srcBytes, uploadedBytes: buf.length, width: 0, height: 0 };
    console.log(`   ⟳ 크기 불일치 (보낸 ${buf.length} / 원격 ${remote}) — 재업로드 ${i}/${tries - 1}`);
    await connect();
  }
}

await connect();

let done = 0, failed = 0;
const failures = [];
for (const folder of targets) {
  const rows = todo.filter((p) => p.folder === folder);
  if (!rows.length) continue;
  // 수집 단계에서 이미 정한 슬러그를 그대로 쓴다 — SLUG 표에 없는 폴더도 있다
  const slug = rows[0].slug;
  const remoteDir = `${REMOTE_ROOT}/${FTP_BASE}/${slug}`;
  // ensureDir 은 멱등이라 재연결 후 다시 불러도 안전하다.
  await withFtp((c) => c.ensureDir(remoteDir));
  console.log(`\n▶ ${folder} (${rows.length}장) → /${FTP_BASE}/${slug}/`);

  for (const r of rows) {
    try {
      // 절대경로로 올린다 — 재연결로 cwd 가 초기화돼도 엉뚱한 곳에 안 떨어진다.
      // (폴더는 위에서 한 번 만들어뒀고, 재연결해도 서버에 그대로 남아 있다)
      const up = await uploadOne(r.abs, `${remoteDir}/${r.remoteName}`);   // ← 원본은 읽기만 한다
      if (!up.ok) { failed++; failures.push(`${r.sourcePath}: 업로드 크기 검증 실패`); continue; }
      await col.updateOne(
        { sourcePath: r.sourcePath },
        {
          $setOnInsert: {
            url: r.url,
            // 브랜드 정리는 캠페인 이름 + 캠페인 안 번호 ('04월 (PASTEL LOVE) 01'), 제품사진은 원본 파일명
            title: r.brandTitle || r.sourceName.replace(/\.[^.]+$/, ''),
            width: up.width, height: up.height,
            // category/tags 는 없다 — 컬렉션 자체가 '드롭박스 파일'이라 분류 칸이 필요 없고,
            // 폴더명을 태그로 넣으면 분류처럼 보여서 오히려 해롭다 (아래 folderHint 참고)
            section: SECTION,
            /*
             * 제품사진: 확정 라벨은 검수 후에 채운다(null). 폴더명은 근거일 뿐이다.
             * 브랜드 정리: 캠페인별로 칩을 나누지 않고 한 묶음('브랜드 정리')에 둔다 —
             *   캠페인 이름은 제목(title)과 campaign 필드로 간다 (사용자 요청 2026-09-21,
             *   scripts/migrate-brand-titles.mjs 와 같은 규칙).
             */
            sub: SECTION === 'brand' ? BRAND_BUCKET : null,
            group: SECTION === 'brand' ? r.brand.group : '',
            ...(SECTION === 'brand' ? { campaign: r.brand.leaf, originalTitle: r.sourceName.replace(/\.[^.]+$/, '') } : {}),
            folderHint: SECTION === 'brand' ? BRAND_BUCKET : r.folder,
            filenameHint: r.filenameHint,
            labelStatus: r.labelStatus,
            sourcePath: r.sourcePath,
            sourceName: r.sourceName,
            source: SECTION === 'brand' ? 'dropbox-brand' : 'dropbox-product',
            // 웹용으로 줄여 올린 크기 — 원본 화질이 필요하면 sourcePath 로 드롭박스에서 가져온다
            srcBytes: up.srcBytes, uploadedBytes: up.uploadedBytes, maxEdge: MAX_EDGE,
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
