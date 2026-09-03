/**
 * 인스타그램 "내 정보 다운로드" 압축 해제 폴더 → 레퍼런스 보관함(SNS 분류) 일괄 등록.
 *
 * 사용:
 *   node scripts/import-instagram-references.mjs <폴더경로>            # 드라이런 — 스캔 결과만 보고
 *   node scripts/import-instagram-references.mjs <폴더경로> --go       # 실제 업로드 + 등록
 *   node scripts/import-instagram-references.mjs <폴더경로> --go --limit 50
 *
 * 동작:
 *   1) 메타 내보내기 JSON(posts_*.json)을 찾아 게시물 목록(이미지 uri·캡션·시각)을 읽는다.
 *      (메타 내보내기는 폴더 구조가 자주 바뀐다 — content/, your_instagram_activity/ 등 어디에 있든 재귀로 찾는다)
 *   2) JSON 이 없으면 폴더 안 이미지 파일을 직접 긁는다 (posts 폴더 우선).
 *   3) 이미지만 등록한다 (영상 mp4 는 건너뛰고 개수만 보고).
 *   4) 파일 내용 md5 로 중복을 막는다 — 스크립트를 다시 돌려도 새 것만 추가된다.
 *   5) FTP 업로드(ref_ig_*.jpg) 후 references 에 category:'sns', source:'instagram' 으로 넣는다.
 *
 * 캡션 한글 깨짐: 메타 내보내기 JSON 은 UTF-8 바이트를 latin1 로 이스케이프하는 버그가 유명하다.
 * latin1 → utf8 재해석으로 복구한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { Client } from 'basic-ftp';
import { Readable } from 'node:stream';
import sharp from 'sharp';

function readEnv(p) {
  return Object.fromEntries(
    fs.readFileSync(p, 'utf8')
      .split('\n').filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; }),
  );
}
const env = readEnv(fileURLToPath(new URL('../.env.local', import.meta.url)));

const args = process.argv.slice(2);
const rootArg = args.find((a) => !a.startsWith('--'));
const GO = args.includes('--go');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) || Infinity : Infinity;

if (!rootArg) {
  console.log('사용법: node scripts/import-instagram-references.mjs <내보내기 폴더> [--go] [--limit N]');
  process.exit(1);
}
const ROOT_DIR = path.resolve(rootArg);
if (!fs.existsSync(ROOT_DIR)) { console.log('폴더가 없습니다:', ROOT_DIR); process.exit(1); }

/** 메타 내보내기의 latin1 로 깨진 UTF-8 복구 */
function fixText(s) {
  if (!s || !/[-ÿ]/.test(s)) return s || '';
  const c = Buffer.from(s, 'latin1').toString('utf8');
  return /�/.test(c) ? s : c;
}

/** 재귀로 파일 나열 */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const all = walk(ROOT_DIR);

// ── 1) 게시물 JSON 찾기 ─────────────────────────────────────────
const postJsons = all.filter((p) => /posts(_\d+)?\.json$/i.test(path.basename(p)));
/** { file(절대), ts(초), caption } */
let mediaItems = [];
let videoCount = 0;

for (const jp of postJsons) {
  try {
    const doc = JSON.parse(fs.readFileSync(jp, 'utf8'));
    const posts = Array.isArray(doc) ? doc : (doc.ig_posts ?? doc.posts ?? []);
    for (const post of posts) {
      const caption = fixText(post.title || '');
      for (const m of post.media ?? []) {
        const rel = m.uri || '';
        if (!rel || /^https?:/.test(rel)) continue; // 외부 링크 형은 건너뜀
        const abs = path.join(ROOT_DIR, rel);
        if (!fs.existsSync(abs)) continue;
        const ext = path.extname(abs).toLowerCase();
        if (ext === '.mp4' || ext === '.mov') { videoCount++; continue; }
        if (!IMG_EXT.has(ext)) continue;
        mediaItems.push({
          file: abs,
          ts: m.creation_timestamp || post.creation_timestamp || 0,
          caption: fixText(m.title || '') || caption,
        });
      }
    }
  } catch (e) {
    console.log('JSON 파싱 실패(건너뜀):', path.relative(ROOT_DIR, jp), '-', e.message);
  }
}

// ── 2) JSON 이 없으면 이미지 파일 직접 수집 (posts 폴더 우선) ──
if (!mediaItems.length) {
  const imgs = all.filter((p) => IMG_EXT.has(path.extname(p).toLowerCase()));
  const inPosts = imgs.filter((p) => /[\\/]posts[\\/]/i.test(p));
  const chosen = inPosts.length ? inPosts : imgs;
  videoCount = all.filter((p) => ['.mp4', '.mov'].includes(path.extname(p).toLowerCase())).length;
  mediaItems = chosen.map((p) => ({ file: p, ts: Math.floor(fs.statSync(p).mtimeMs / 1000), caption: '' }));
  if (mediaItems.length) console.log('게시물 JSON 을 못 찾아 이미지 파일을 직접 수집했습니다 (캡션 없음).');
}

// 같은 파일 중복 제거 + 최신순
const seenFile = new Set();
mediaItems = mediaItems.filter((m) => (seenFile.has(m.file) ? false : (seenFile.add(m.file), true)));
mediaItems.sort((a, b) => b.ts - a.ts);
const total = mediaItems.length;
mediaItems = mediaItems.slice(0, LIMIT);

console.log(`이미지 ${total}장 발견 (영상 ${videoCount}건 제외)${LIMIT < total ? ` · 이번엔 ${mediaItems.length}장만` : ''}`);
if (!mediaItems.length) process.exit(0);

// 샘플 미리보기
for (const m of mediaItems.slice(0, 5)) {
  const d = m.ts ? new Date(m.ts * 1000).toISOString().slice(0, 10) : '날짜미상';
  console.log('  ·', d, '|', (m.caption || '(캡션 없음)').split('\n')[0].slice(0, 40), '|', path.relative(ROOT_DIR, m.file));
}
if (!GO) {
  console.log('\n드라이런입니다. 실제 등록은 --go 를 붙여 다시 실행하세요.');
  process.exit(0);
}

// ── 3) 업로드 + 등록 ────────────────────────────────────────────
const FTP_HOST = (env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, '').replace(/\/$/, '');
const FTP_ROOT = (env.FTP_REMOTE_DIR || '/web/img/imgc').replace(/^\/|\/$/g, '');
const PUBLIC = (env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');

const mc = new MongoClient(env.MONGODB_URI);
await mc.connect();
const col = mc.db(env.MONGODB_DB || undefined).collection('references');

const ftp = new Client(30000);
await ftp.access({ host: FTP_HOST, port: Number(env.FTP_PORT) || 21, user: env.FTP_USER, password: env.FTP_PASS, secure: false });
await ftp.ensureDir(FTP_ROOT + '/update');

let added = 0, dup = 0, failed = 0;
for (let i = 0; i < mediaItems.length; i++) {
  const m = mediaItems[i];
  try {
    const raw = fs.readFileSync(m.file);
    const hash = crypto.createHash('md5').update(raw).digest('hex');
    if (await col.findOne({ igHash: hash })) { dup++; continue; }

    const out = await sharp(raw).rotate().jpeg({ quality: 92 }).toBuffer();
    const meta = await sharp(out).metadata();
    const stamp = new Date((m.ts || Date.now() / 1000) * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const fn = `ref_ig_${stamp}_${Math.random().toString(36).slice(2, 8)}.jpg`;
    await ftp.uploadFrom(Readable.from(out), fn);
    const url = `${PUBLIC}/update/${fn}`;

    const day = m.ts ? new Date(m.ts * 1000).toISOString().slice(0, 10) : '';
    const capLine = (m.caption || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
    const title = (capLine ? capLine.slice(0, 60) : `인스타그램 게시물${day ? ' ' + day : ''}`);

    await col.insertOne({
      url, title,
      width: meta.width ?? 0, height: meta.height ?? 0,
      category: 'sns', tags: ['instagram'],
      source: 'instagram', igHash: hash,
      active: true,
      createdAt: m.ts ? new Date(m.ts * 1000) : new Date(),
    });
    added++;
    if ((i + 1) % 10 === 0) console.log(`  ...${i + 1}/${mediaItems.length} (등록 ${added} · 중복 ${dup})`);
  } catch (e) {
    failed++;
    console.log('  실패:', path.basename(m.file), '-', e.message);
  }
}
ftp.close();
await mc.close();
console.log(`\n완료 — 등록 ${added} · 중복 건너뜀 ${dup} · 실패 ${failed} (영상 제외 ${videoCount})`);
console.log('보관함 SNS 분류에서 확인하세요.');
