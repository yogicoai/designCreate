/**
 * 모델컷(/web/design/modal/*) → 레퍼런스 보관함 등록.
 *
 * 파일은 이미 cafe24 에 있으므로 재업로드 없이 URL 만 등록한다.
 *   category: 'model'(모델컷) — 하위 폴더가 있으면 sub 로 나뉘어 칩이 생긴다.
 * URL 중복은 건너뛰므로 다시 돌려도 안전하다.
 *
 * 사용:
 *   node scripts/import-model-refs.mjs          # 드라이런 — 목록·URL 접근 확인만
 *   node scripts/import-model-refs.mjs --go     # 실제 등록
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { Client } from 'basic-ftp';

function readEnv(p) {
  return Object.fromEntries(
    fs.readFileSync(p, 'utf8')
      .split('\n').filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; }),
  );
}
const env = readEnv(fileURLToPath(new URL('../.env.local', import.meta.url)));
const GO = process.argv.includes('--go');

const BASE = '/web/design/modal';
const PUBLIC = (env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');   // …/web/design 까지 포함
const IMG = /\.(jpe?g|png|webp)$/i;

const ftp = new Client(30000);
await ftp.access({
  host: (env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, ''),
  port: Number(env.FTP_PORT) || 21,
  user: env.FTP_USER, password: env.FTP_PASS, secure: false,
});

/** 루트 파일 + 한 단계 하위 폴더까지 훑는다 (모델별 폴더링을 지원) */
const items = []; // { url, sub, name }
const root = await ftp.list(BASE);
for (const f of root) {
  if (f.type === 1 && IMG.test(f.name)) {
    items.push({ url: `${PUBLIC}/modal/${encodeURIComponent(f.name)}`, sub: '', name: f.name });
  }
}
for (const d of root.filter((x) => x.type === 2)) {
  const files = await ftp.list(`${BASE}/${d.name}`).catch(() => []);
  for (const f of files) {
    if (f.type !== 1 || !IMG.test(f.name)) continue;
    items.push({
      url: `${PUBLIC}/modal/${encodeURIComponent(d.name)}/${encodeURIComponent(f.name)}`,
      sub: d.name,
      name: f.name,
    });
  }
}
ftp.close();
console.log(`폴더 ${root.filter((x) => x.type === 2).length} · 이미지 ${items.length}장`);

// 인코딩된 URL 이 실제로 열리는지 첫 3장 확인 — 경로가 틀리면 전부 엑박이 된다
for (const it of items.slice(0, 3)) {
  const r = await fetch(it.url, { method: 'HEAD' }).catch(() => null);
  console.log(' 접근확인', r?.status ?? 'ERR', '-', decodeURIComponent(it.url.slice(-60)));
  if (!r || r.status !== 200) {
    console.log('⚠ URL 이 열리지 않습니다 — 경로/인코딩을 확인해야 합니다. 중단.');
    process.exit(1);
  }
}

if (!GO) {
  const by = {};
  items.forEach((i) => { const k = i.sub || '(루트)'; by[k] = (by[k] || 0) + 1; });
  Object.entries(by).forEach(([k, v]) => console.log('  ·', k.padEnd(24), v + '장'));
  console.log('\n드라이런입니다. 실제 등록은 --go 를 붙여 실행하세요.');
  process.exit(0);
}

const mc = new MongoClient(env.MONGODB_URI);
await mc.connect();
const col = mc.db(env.MONGODB_DB || undefined).collection('references');

let added = 0, dup = 0;
for (const it of items) {
  const res = await col.updateOne(
    { url: it.url },
    {
      $setOnInsert: {
        url: it.url,
        title: `${it.sub ? `${it.sub} · ` : ''}${it.name.replace(/\.[^.]+$/, '')}`,
        width: 0, height: 0,
        category: 'model',
        ...(it.sub ? { sub: it.sub } : {}),
        tags: ['model', ...(it.sub ? [it.sub] : [])],
        source: 'modal',
        active: true,
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
  if (res.upsertedCount) added++; else dup++;
  if ((added + dup) % 200 === 0) console.log(`  ...${added + dup}/${items.length}`);
}
await mc.close();
console.log(`완료 — 등록 ${added} · 이미 있던 것 ${dup}`);
