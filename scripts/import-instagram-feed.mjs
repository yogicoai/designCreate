/**
 * 인스타그램 피드 프록시 → 레퍼런스 보관함(SNS 분류) 일괄 등록.
 *
 * 자사몰이 이미 쓰는 피드 프록시(cloudtype /api/instagramFeed)를 첫 페이지로 삼고,
 * 응답의 paging.next(그래프 API URL + 토큰 포함)를 따라가며 전체 게시물을 가져온다.
 * 캐러셀은 children 을 풀어 장수대로, 영상은 건너뛴다(개수만 보고).
 *
 * 사용:
 *   node scripts/import-instagram-feed.mjs               # 드라이런 — 전체 스캔 결과만 보고
 *   node scripts/import-instagram-feed.mjs --go          # 실제 업로드 + 등록
 *   node scripts/import-instagram-feed.mjs --go --limit 30
 *
 * 중복: 게시물/자식 미디어 id(igId) + 파일 md5(igHash) 로 막는다 —
 * 나중에 다시 돌리면 새 게시물만 추가된다 (동기화 용도로 재실행 OK).
 * 토큰은 프록시 응답에서 얻어 그래프 API 호출에만 쓰고, 어디에도 출력·저장하지 않는다.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { Client } from 'basic-ftp';
import { Readable } from 'node:stream';
import sharp from 'sharp';

const FEED_URL = 'https://port-0-admichat-lzgmwhc4d9883c97.sel4.cloudtype.app/api/instagramFeed';
const MAX_PAGES = 50; // 안전장치 — 페이지당 25~40개면 충분히 전체를 덮는다

function readEnv(p) {
  return Object.fromEntries(
    fs.readFileSync(p, 'utf8')
      .split('\n').filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; }),
  );
}
const env = readEnv(fileURLToPath(new URL('../.env.local', import.meta.url)));

const args = process.argv.slice(2);
const GO = args.includes('--go');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) || Infinity : Infinity;

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── 1) 전체 게시물 수집 (프록시 → paging.next 추적) ─────────────
let page = await getJson(FEED_URL);
let token = '';
try { token = new URL(page.paging?.next ?? '').searchParams.get('access_token') || ''; } catch { /* next 없음 */ }

const posts = [];
for (let i = 0; i < MAX_PAGES; i++) {
  posts.push(...(page.data ?? []));
  const next = page.paging?.next;
  if (!next) break;
  page = await getJson(next);
}
console.log(`게시물 ${posts.length}건 수집 (이미지/캐러셀/영상 포함)`);

// ── 2) 이미지 미디어로 풀기 (캐러셀 children 포함) ──────────────
/** { igId, url, caption, ts } */
const medias = [];
let videoCount = 0;
for (const p of posts) {
  const caption = p.caption || '';
  const ts = p.timestamp || '';
  if (p.media_type === 'IMAGE') {
    if (p.media_url) medias.push({ igId: String(p.id), url: p.media_url, caption, ts });
  } else if (p.media_type === 'VIDEO') {
    videoCount++;
  } else if (p.media_type === 'CAROUSEL_ALBUM') {
    if (!token) { console.log('  캐러셀인데 토큰이 없어 건너뜀:', p.permalink); continue; }
    try {
      const kids = await getJson(`https://graph.instagram.com/v22.0/${p.id}/children?fields=media_url,media_type&access_token=${token}`);
      for (const k of kids.data ?? []) {
        if (k.media_type === 'IMAGE' && k.media_url) medias.push({ igId: String(k.id), url: k.media_url, caption, ts });
        else if (k.media_type === 'VIDEO') videoCount++;
      }
    } catch (e) {
      console.log('  캐러셀 children 실패:', p.permalink, '-', e.message);
    }
  }
}
const total = medias.length;
const work = medias.slice(0, LIMIT);
console.log(`이미지 ${total}장 (영상 ${videoCount}건 제외)${LIMIT < total ? ` · 이번엔 ${work.length}장만` : ''}`);
for (const m of work.slice(0, 5)) {
  console.log('  ·', String(m.ts).slice(0, 10), '|', (m.caption || '(캡션 없음)').split('\n')[0].slice(0, 40));
}
if (!GO) {
  console.log('\n드라이런입니다. 실제 등록은 --go 를 붙여 다시 실행하세요.');
  process.exit(0);
}

// ── 3) 다운로드 → FTP → 등록 ────────────────────────────────────
const FTP_HOST = (env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, '').replace(/\/$/, '');
const FTP_ROOT = (env.FTP_REMOTE_DIR || '/web/img/imgc').replace(/^\/|\/$/g, '');
const PUBLIC = (env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');

const mc = new MongoClient(env.MONGODB_URI);
await mc.connect();
const col = mc.db(env.MONGODB_DB || undefined).collection('references');

const ftp = new Client(30000);
await ftp.access({ host: FTP_HOST, port: Number(env.FTP_PORT) || 21, user: env.FTP_USER, password: env.FTP_PASS, secure: false });
// 인스타 백필은 전용 폴더에 쌓는다 — 보관함 일반 업로드(update/)와 섞지 않는다
await ftp.ensureDir(FTP_ROOT + '/instar');

let added = 0, dup = 0, failed = 0;
for (let i = 0; i < work.length; i++) {
  const m = work[i];
  try {
    if (await col.findOne({ igId: m.igId })) { dup++; continue; }
    const res = await fetch(m.url);
    if (!res.ok) throw new Error(`다운로드 HTTP ${res.status}`);
    const raw = Buffer.from(await res.arrayBuffer());
    const hash = crypto.createHash('md5').update(raw).digest('hex');
    if (await col.findOne({ igHash: hash })) { dup++; continue; }

    const out = await sharp(raw).rotate().jpeg({ quality: 92 }).toBuffer();
    const meta = await sharp(out).metadata();
    const when = m.ts ? new Date(m.ts) : new Date();
    const stamp = when.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const fn = `ref_ig_${stamp}_${Math.random().toString(36).slice(2, 8)}.jpg`;
    await ftp.uploadFrom(Readable.from(out), fn);

    const capLine = (m.caption || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
    /*
     * 외부 작가·크리에이터 크레딧 흔적 감지 — ©, photo by, 촬영:, @작가님 류.
     * 그런 컷은 저작권 워터마크가 박혀 있거나 2차 활용 권리 확인이 필요한 경우가 많아
     * 'credit' 태그로 눈에 띄게 표시한다 (제외하진 않는다 — 판단은 사람 몫).
     */
    const hasCredit = /©|ⓒ|rights\s*reserved|무단\s*전재|photo\s*by|촬영\s*[:：]|출처\s*[:：]|@[\w가-힣._]{2,}\s*(님|작가)/i.test(m.caption || '');
    await col.insertOne({
      url: `${PUBLIC}/instar/${fn}`,
      title: capLine ? capLine.slice(0, 60) : `인스타그램 ${when.toISOString().slice(0, 10)}`,
      width: meta.width ?? 0, height: meta.height ?? 0,
      category: 'instagram', tags: hasCredit ? ['instagram', 'credit'] : ['instagram'],
      source: 'instagram', igId: m.igId, igHash: hash,
      active: true, createdAt: when,
    });
    added++;
    if ((i + 1) % 10 === 0) console.log(`  ...${i + 1}/${work.length} (등록 ${added} · 중복 ${dup})`);
  } catch (e) {
    failed++;
    console.log('  실패:', m.igId, '-', e.message);
  }
}
ftp.close();
await mc.close();
console.log(`\n완료 — 등록 ${added} · 중복 건너뜀 ${dup} · 실패 ${failed} · 영상 제외 ${videoCount}`);
console.log('보관함 SNS 분류에서 확인하세요. 새 게시물이 생기면 이 스크립트를 다시 돌리면 됩니다.');
