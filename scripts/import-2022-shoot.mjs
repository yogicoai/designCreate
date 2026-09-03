/**
 * 2022 촬영본(/web/design/22/<제품폴더>/*.jpg) → 레퍼런스 보관함 등록.
 *
 * 파일은 이미 cafe24 에 있으므로 재업로드 없이 URL 만 등록한다.
 *   category: 'shoot'(촬영), sub: '22 <폴더명>' — 촬영 탭 안에서 하위 칩으로 나뉜다.
 * URL 중복은 건너뛰므로 다시 돌려도 안전하다.
 *
 * 사용:
 *   node scripts/import-2022-shoot.mjs          # 드라이런 — 목록·URL 접근 확인만
 *   node scripts/import-2022-shoot.mjs --go     # 실제 등록
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

const BASE = '/web/design/22';
const PUBLIC = (env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');   // …/web/design 까지 포함

const ftp = new Client(30000);
await ftp.access({
  host: (env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, ''),
  port: Number(env.FTP_PORT) || 21,
  user: env.FTP_USER, password: env.FTP_PASS, secure: false,
});

/** 폴더별 이미지 나열 */
const dirs = (await ftp.list(BASE)).filter((d) => d.type === 2);
const items = []; // { url, folder, name }
for (const d of dirs) {
  const files = await ftp.list(`${BASE}/${d.name}`);
  for (const f of files) {
    if (f.type !== 1 || !/\.(jpe?g|png|webp)$/i.test(f.name)) continue;
    // 한글 폴더/파일명은 URL 인코딩한다 — 브라우저 주소창과 같은 규칙
    const url = `${PUBLIC}/22/${encodeURIComponent(d.name)}/${encodeURIComponent(f.name)}`;
    items.push({ url, folder: d.name, name: f.name });
  }
}
ftp.close();
console.log(`폴더 ${dirs.length} · 이미지 ${items.length}장`);

// 인코딩된 URL 이 실제로 열리는지 첫 3장 확인 — 한글 경로가 서버에서 안 열리면 전부 엑박이 된다
for (const it of items.slice(0, 3)) {
  const r = await fetch(it.url, { method: 'HEAD' }).catch(() => null);
  console.log(' 접근확인', r?.status ?? 'ERR', '-', decodeURIComponent(it.url.slice(-60)));
  if (!r || r.status !== 200) {
    console.log('⚠ URL 이 열리지 않습니다 — 인코딩/경로를 확인해야 합니다. 중단.');
    process.exit(1);
  }
}

if (!GO) {
  const byFolder = {};
  items.forEach((i) => { byFolder[i.folder] = (byFolder[i.folder] || 0) + 1; });
  Object.entries(byFolder).forEach(([k, v]) => console.log('  ·', `22 ${k}`.padEnd(26), v + '장'));
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
        title: `${it.folder} · ${it.name.replace(/\.[^.]+$/, '')}`,
        width: 0, height: 0,
        category: 'shoot',
        sub: `22 ${it.folder}`,
        tags: ['2022', it.folder],
        source: 'shoot22',
        active: true,
        createdAt: new Date('2022-12-31T00:00:00+09:00'), // 촬영 연도로 정렬되게
      },
    },
    { upsert: true },
  );
  if (res.upsertedCount) added++; else dup++;
  if ((added + dup) % 200 === 0) console.log(`  ...${added + dup}/${items.length}`);
}
await mc.close();
console.log(`완료 — 등록 ${added} · 이미 있던 것 ${dup}`);
