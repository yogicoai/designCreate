/**
 * 드롭박스 자산 재업로드 — 축소본으로 다시 올리고, 올린 것을 매번 검증한다.
 *
 * 왜 다시 올리나 (2026-09-21):
 *   1차 배치 1,687장 중 **1,122장(66.8%)이 잘려 있었다.** 심한 건 14.1MB 원본이 0.77MB(5%)로
 *   올라갔다. cafe24 가 전송 중 데이터 소켓을 끊는데(ECONNRESET), basic-ftp 가 그걸 항상
 *   예외로 던지지는 않아 부분 파일이 "성공"으로 남았다. HTTP 200 만 보는 검증으로는 못 잡는다 —
 *   잘린 JPEG 도 200 을 준다.
 *
 * 그래서 이 스크립트는 두 가지를 바꾼다:
 *   ① **축소해서 올린다** (긴 변 2000px · q82). 전송이 짧아 끊김 자체가 훨씬 덜 나고,
 *      552(파일 크기 한계)도 사라진다. 실측: 21.4MB 원본은 썸네일 1장 만드는 데 4,481ms,
 *      228KB 는 67ms — 목록 화면 속도가 50~70배 차이난다. 원본 화질은 드롭박스에 그대로 있다.
 *   ② **올린 뒤 원격 크기를 대조한다.** 안 맞으면 다시 올린다. 이게 없어서 생긴 일이다.
 *
 * 파일명은 새로 짓는다 — cafe24 는 같은 주소를 7일 캐시하므로 덮어쓰면 옛 파일이 계속 보인다.
 * `<슬러그>_<연번>_r2.jpg` 로 올리고 DB url 을 갱신한다. 옛 파일은 지우지 않는다(캐시 만료 후 정리).
 *
 * 원본(드롭박스)은 읽기만 한다. 쓰기·이동·삭제 코드 경로가 없다.
 *
 * 사용:
 *   node scripts/rebuild-dropbox-assets.mjs                    # 드라이런 — 무엇이 대상인지만
 *   node scripts/rebuild-dropbox-assets.mjs --folder=버블 --go   # 한 폴더 재업로드
 *   node scripts/rebuild-dropbox-assets.mjs --go               # 전부
 *   node scripts/rebuild-dropbox-assets.mjs --go --only-broken # 잘린 것만
 *   ... --unpin  끝난 폴더 온라인전용 복귀(디스크 회수)
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { MongoClient } from 'mongodb';
import { Client } from 'basic-ftp';
import sharp from 'sharp';

/* 큰 사진을 연속으로 줄이면 libvips 캐시가 쌓여 프로세스가 조용히 죽는다 (실측 2026-09-21) */
sharp.cache(false);
sharp.concurrency(1);

const SRC_ROOT = 'C:/Users/Yogibo Design/Yogicorporation Dropbox/요기코퍼레이션_포워드/1. 디자인/2.7 제품사진';
const MAX_EDGE = 2000;
const QUALITY = 82;

const GO = process.argv.includes('--go');
const UNPIN = process.argv.includes('--unpin');
const ONLY_BROKEN = process.argv.includes('--only-broken');
const folderArg = process.argv.find((a) => a.startsWith('--folder='))?.slice(9);

const env = {};
for (const ln of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const REMOTE_ROOT = `/${(env.FTP_REMOTE_DIR || '/web/img/imgc').replace(/^\/|\/$/g, '')}`;
const PUBLIC = (env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');

const mc = new MongoClient(env.MONGODB_URI);
await mc.connect();
const col = mc.db(env.MONGODB_DB || undefined).collection('dropbox_assets');

const q = { active: { $ne: false } };
if (folderArg) q.folderHint = folderArg;
const docs = await col.find(q).project({ url: 1, sourcePath: 1, folderHint: 1, rebuiltAt: 1 }).toArray();

// 대상 추리기 — 이미 재업로드한 것은 건너뛴다(멱등)
let todo = docs.filter((d) => !d.rebuiltAt);
if (ONLY_BROKEN) {
  console.log('잘린 것만 고르는 중 — 원격 크기와 원본 크기를 대조합니다…');
  const keep = [];
  for (let i = 0; i < todo.length; i += 40) {
    await Promise.all(todo.slice(i, i + 40).map(async (d) => {
      let src = 0;
      try { src = fs.statSync(path.join(SRC_ROOT, d.sourcePath)).size; } catch { return; }
      let up = 0;
      try { const r = await fetch(d.url, { method: 'HEAD' }); up = Number(r.headers.get('content-length') || 0); } catch { /* 네트워크 실패는 대상으로 */ }
      if (up !== src) keep.push(d);
    }));
  }
  todo = keep;
}

const byFolder = {};
for (const d of todo) byFolder[d.folderHint] = (byFolder[d.folderHint] || 0) + 1;
console.log(`재업로드 대상 ${todo.length}장`);
console.log(Object.entries(byFolder).map(([k, v]) => `${k} ${v}`).join(' · ') || '  (없음)');
console.log(`\n방식: 긴 변 ${MAX_EDGE}px · JPEG q${QUALITY} · 업로드 후 원격 크기 대조`);

if (!GO) {
  console.log('\n드라이런입니다. 실제로 올리려면 --go 를 붙이세요.');
  await mc.close();
  process.exit(0);
}

// ── FTP ─────────────────────────────────────────────────────────────────────
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
async function withFtp(fn, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      if (!ftp || ftp.closed) await connect();
      return await fn(ftp);
    } catch (e) {
      const msg = `${e.code || ''} ${e.message || ''}`;
      if (i >= attempts || !RECOVERABLE.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 1200 * i));
      await connect();
    }
  }
}

/**
 * 올리고 **검증한다.** 원격 크기가 보낸 바이트와 다르면 잘린 것이므로 다시 올린다.
 * 이 대조가 없어서 1,122장이 잘린 채로 "성공" 처리됐다.
 */
async function putVerified(buf, dest, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    await withFtp((c) => c.uploadFrom(Readable.from(buf), dest));
    let remote = -1;
    try { remote = await withFtp((c) => c.size(dest)); } catch { /* size 미지원이면 아래 HTTP 로 */ }
    if (remote === buf.length) return true;
    if (i === tries) return false;
    console.log(`   ⟳ 크기 불일치 (보낸 ${buf.length} / 원격 ${remote}) — 재업로드 ${i}/${tries - 1}`);
    await connect();
  }
  return false;
}

await connect();

const folders = [...new Set(todo.map((d) => d.folderHint))];
let ok = 0, bad = 0, skipped = 0;
const failures = [];

for (const folder of folders) {
  const rows = todo.filter((d) => d.folderHint === folder);
  const slug = rows[0].url.split('/product/')[1]?.split('/')[0] || 'etc';
  const remoteDir = `${REMOTE_ROOT}/product/${slug}`;
  await withFtp((c) => c.ensureDir(remoteDir));
  console.log(`\n▶ ${folder} (${rows.length}장) → /product/${slug}/`);

  let n = 0;
  for (const d of rows) {
    const abs = path.join(SRC_ROOT, d.sourcePath);
    try {
      if (!fs.existsSync(abs)) { skipped++; failures.push(`${d.sourcePath}: 원본 없음`); continue; }
      const srcBytes = fs.statSync(abs).size;
      const img = sharp(abs, { sequentialRead: true, limitInputPixels: 500_000_000, failOn: 'none' })
        .rotate()
        .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true });
      const buf = await img.jpeg({ quality: QUALITY }).toBuffer();
      const meta = await sharp(buf).metadata();

      // 새 파일명 — cafe24 7일 캐시 때문에 덮어쓰면 옛 파일이 계속 보인다
      const base = d.url.split('/').pop().replace(/\.[^.]+$/, '');
      const name = `${base}_r2.jpg`;
      const dest = `${remoteDir}/${name}`;

      if (!(await putVerified(buf, dest))) {
        bad++; failures.push(`${d.sourcePath}: 검증 실패`); continue;
      }

      await col.updateOne({ _id: d._id }, {
        $set: {
          url: `${PUBLIC}/product/${slug}/${name}`,
          width: meta.width ?? 0, height: meta.height ?? 0,
          srcBytes, uploadedBytes: buf.length,
          rebuiltAt: new Date(), maxEdge: MAX_EDGE,
        },
        $unset: { resized: '' },   // 이제 전부 축소본이라 이 표시는 의미가 없다
      });
      ok++;
    } catch (e) {
      bad++; failures.push(`${d.sourcePath}: ${e.message}`);
    }
    if (++n % 50 === 0) console.log(`   …${n}/${rows.length}`);
  }

  if (UNPIN) {
    try {
      execFileSync('attrib.exe', ['+U', '-P', `${path.join(SRC_ROOT, folder).replace(/\//g, '\\')}\\*`, '/S'], { stdio: 'ignore' });
      console.log(`   ↩ ${folder} 온라인전용 복귀 요청`);
    } catch (e) { console.log(`   ⚠ 복귀 실패: ${e.message}`); }
  }
}

ftp.close();
await mc.close();
console.log(`\n완료 — 성공 ${ok} · 실패 ${bad} · 건너뜀 ${skipped}`);
if (failures.length) {
  console.log('실패 목록(최대 10건):');
  failures.slice(0, 10).forEach((f) => console.log('  ' + f));
}
