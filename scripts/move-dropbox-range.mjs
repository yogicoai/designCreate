import { MongoClient } from 'mongodb';

/**
 * 드롭박스 화면 순서(원본 수정일 최신순)에서 「첫 장 ~ 마지막 장」 구간을 한 제품 폴더(라벨)로 옮긴다 — 사용자가 파일명으로 불러 줄 때.
 * 예: 「UE3A1207 ~ 20211112_yogibo_2997 럭스로 이동」, 「DSC00947~DSC00767 맥스 이동」
 *
 * 「옮긴다」 = 원래 라벨을 지우고 그 라벨 하나만 남긴다(products=[라벨], productsSource 'human' — AI 가 다시 덮지 않는다).
 * 원래 라벨은 relabel.from 에 남겨서 되돌릴 수 있다. 목록(DB) 라벨만 바뀐다 — 드롭박스 원본·cafe24 파일은 그대로.
 *
 * 구간 고르는 규칙은 purge-dropbox-range.mjs 와 같다 (사용자 결정 2026-09-22):
 *   - 이름 앞부분이 다르면 목록 순서, 같으면 --by-number(파일 번호, 양 끝과 같은 촬영 폴더만)
 *   - 촬영본(「촬영/」·「촬영2022/」)만 옮기고, 사이에 낀 공식 제품사진(「제품사진/」)은 제자리에 둔다
 *   - 끝 사진 이름이 공식 컷과 겹치면(UE3A1207 처럼) 촬영본 쪽을 끝으로 본다
 * --folder=<경로 앞부분> 을 주면 구간 대신 그 촬영 폴더 전체를 옮긴다(파스텔처럼 폴더가 곧 구간일 때).
 * --in=<라벨> 을 주면 그 제품 칩 화면의 순서로 구간을 잡는다 — 칩을 눌러 놓고 불러 준 구간일 때
 * (예: 미디 칩에서 「4Z5A2914~646A3447_」 = 미디 20장. 전체 순서로는 서포트·피라미드·파스텔까지 546장이 걸린다, 2026-09-22).
 * --all 을 주면 공식 제품사진도 같이 옮긴다 — 사용자가 공식 컷을 직접 짚었을 때만
 * (예: 「Nov 17 2021 - Yogibo」 4장은 제품사진/미디 폴더지만 사용자가 맥스로 옮기라고 함, 2026-09-22).
 *
 * 사용: node --env-file=.env.local scripts/move-dropbox-range.mjs --label=럭스 --from=UE3A1207 --to=20211112_yogibo_2997 [--by-number] [--dry]
 *       node --env-file=.env.local scripts/move-dropbox-range.mjs --label=파스텔 --folder="촬영/2021 (럭스_파스텔_유연석)/2021_파스텔 상품촬영/" [--dry]
 */

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const FROM = arg('from'), TO = arg('to'), LABEL = arg('label'), FOLDER = arg('folder'), IN = arg('in');
const BY_NUMBER = process.argv.includes('--by-number');
const ALL = process.argv.includes('--all');
const DRY = process.argv.includes('--dry');
if (!LABEL || !(FOLDER || (FROM && TO))) { console.error('--label= 과 (--from= --to=) 또는 --folder= 가 필요합니다'); process.exit(1); }

// src/lib/dropbox-products.ts 의 PRODUCT_LABELS 에 있는 이름만 — 화면 칩·정리 모드 버튼과 맞아야 한다
const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/lib/dropbox-products.ts', import.meta.url), 'utf8'));
const labels = [...(/PRODUCT_LABELS = \[([\s\S]*?)\]/.exec(src)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
if (!labels.includes(LABEL) || LABEL === '제품 없음') { console.error(`「${LABEL}」 은 제품 라벨이 아닙니다 — src/lib/dropbox-products.ts 에 먼저 넣으세요`); process.exit(1); }

const isShoot = (sp) => /^촬영(2022)?\//.test(sp);
/** 「촬영/2020/유니랜서/…」 → 「촬영/2020/유니랜서」 — 같은 촬영분인지 가르는 기준 */
const shootKey = (sp) => sp.split('/').slice(0, 3).join('/');
const numOf = (t) => { const m = /^(.*?)(\d+)$/.exec(t); return m ? { pre: m[1], n: Number(m[2]) } : null; };

const mc = new MongoClient(process.env.MONGODB_URI);
await mc.connect();
const col = mc.db(process.env.MONGODB_DB || undefined).collection('dropbox_assets');
// --in=<라벨>: 화면에서 그 제품 칩을 눌러 놓고 본 순서로 구간을 잡는다(칩 안에서 연속인 것만)
const base = { section: { $ne: 'brand' }, active: { $ne: false }, ...(IN ? { products: IN } : {}) };
// 화면과 같은 순서 — src/lib/queries.ts 의 DROPBOX_SORT
const all = await col.find(base).sort({ srcMtime: -1, sourcePath: 1 }).project({ title: 1, sourcePath: 1, products: 1 }).toArray();

let target, note;
if (FOLDER) {
  target = all.filter((d) => d.sourcePath.startsWith(FOLDER));
  note = `폴더 ${FOLDER}`;
  console.log(`폴더 ${target.length}장`);
} else {
  const pick = (t) => { const hits = all.filter((d) => d.title === t); return hits.length > 1 ? hits.filter((d) => isShoot(d.sourcePath)) : hits; };
  const hitsA = pick(FROM), hitsB = pick(TO);
  if (hitsA.length !== 1 || hitsB.length !== 1) {
    console.log(`양 끝 사진이 하나씩이어야 합니다 — ${FROM} ${hitsA.length}건, ${TO} ${hitsB.length}건`);
    for (const d of [...hitsA, ...hitsB]) console.log('   ', d.title, d.sourcePath);
    await mc.close(); process.exit(1);
  }
  let seg;
  if (BY_NUMBER) {
    const A = numOf(FROM), B = numOf(TO);
    if (!A || !B || A.pre !== B.pre) { console.log('--by-number 는 이름 앞부분이 같고 번호로 끝나야 합니다'); await mc.close(); process.exit(1); }
    const lo = Math.min(A.n, B.n), hi = Math.max(A.n, B.n);
    const keys = new Set([shootKey(hitsA[0].sourcePath), shootKey(hitsB[0].sourcePath)]);
    seg = all.filter((d) => { const x = numOf(d.title); return x && x.pre === A.pre && x.n >= lo && x.n <= hi; });
    target = ALL ? seg : seg.filter((d) => keys.has(shootKey(d.sourcePath)));
    console.log(`번호 구간 ${seg.length}장`);
  } else {
    const a = all.indexOf(hitsA[0]), b = all.indexOf(hitsB[0]);
    seg = all.slice(Math.min(a, b), Math.max(a, b) + 1);
    target = ALL ? seg : seg.filter((d) => isShoot(d.sourcePath));
    console.log(`구간 ${seg.length}장 (목록 ${Math.min(a, b) + 1}~${Math.max(a, b) + 1}번째)`);
  }
  note = `${FROM}~${TO}`;
  const skipped = seg.filter((d) => !target.includes(d));
  if (skipped.length) {
    const m = skipped.reduce((acc, d) => ((acc[d.sourcePath.split('/').slice(0, 2).join('/')] = (acc[d.sourcePath.split('/').slice(0, 2).join('/')] || 0) + 1), acc), {});
    console.log(`  제자리 ${skipped.length}: ${Object.entries(m).map(([k, v]) => `${k} ${v}`).join(' | ')}`);
  }
}

const byFolder = target.reduce((m, d) => ((m[d.sourcePath.split('/').slice(0, 4).join('/')] = (m[d.sourcePath.split('/').slice(0, 4).join('/')] || 0) + 1), m), {});
console.log(`  「${LABEL}」 로 옮길 것 ${target.length}: ${Object.entries(byFolder).map(([k, v]) => `${k} ${v}`).join(' | ')}`);
const already = target.filter((d) => (d.products || []).length === 1 && d.products[0] === LABEL).length;
if (already) console.log(`  (이미 「${LABEL}」 만 붙은 것 ${already})`);
if (DRY || !target.length) { await mc.close(); process.exit(0); }

const now = new Date();
const by = `사용자 구간 지시 ${note} (${now.toISOString().slice(0, 10)})`;
let written = 0;
for (let i = 0; i < target.length; i += 500) {
  const r = await col.bulkWrite(target.slice(i, i + 500).map((d) => ({
    updateOne: {
      filter: { _id: d._id },
      update: { $set: { products: [LABEL], productsSource: 'human', relabel: { from: d.products || [], to: LABEL, by, at: now }, updatedAt: now } },
    },
  })));
  written += r.modifiedCount;
}
console.log(`옮김 ${written}`);
await mc.close();
