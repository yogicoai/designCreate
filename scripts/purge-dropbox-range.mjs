import { MongoClient } from 'mongodb';
import { Client } from 'basic-ftp';

/**
 * 드롭박스 화면 순서(드롭박스에 올라온 순서, 최신 업로드가 앞)에서 「첫 장 ~ 마지막 장」 구간을 지운다 — 사용자가 파일명으로 구간을 불러 줄 때.
 *
 * 최신순 목록에서는 수정 날짜가 비슷한 다른 폴더 사진(특히 2.7 제품사진의 공식 컷)이 사이에 끼어 있을 수 있다.
 * 그래서 기본은 **촬영본만** 지우고 사이에 낀 공식 제품사진(2.7 제품사진)은 남긴다(아래 isShoot)
 * (사용자 결정 2026-09-22: IMG_4072~DSC07356 에서 사이에 낀 허기보 공식 컷 60장은 남기고 촬영본 336장만).
 * --all 을 주면 구간 전체를 지운다.
 *
 * 지우는 것: cafe24 웹 사본 + 목록(deleted 표시). 드롭박스 원본은 건드리지 않는다. 생성 컷이 쓴 사진은 숨김만.
 *
 * 사용: node --env-file=.env.local scripts/purge-dropbox-range.mjs --from=IMG_4072 --to=DSC07356 [--from-path=… --to-path=…] [--all] [--dry]
 */

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const FROM = arg('from'), TO = arg('to');
const ALL = process.argv.includes('--all');
const DRY = process.argv.includes('--dry');
if (!FROM || !TO) { console.error('--from= 과 --to= 가 필요합니다'); process.exit(1); }

const BASE = (process.env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');
const ROOT = (process.env.FTP_REMOTE_DIR || '').replace(/^\/|\/$/g, '');
const SAFE = /^(product|brand)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.jpg$/;
const rel = (u) => (u.startsWith(`${BASE}/`) ? u.slice(BASE.length + 1) : '');
/** 「촬영/2020/유니랜서/…」 → 「촬영/2020/유니랜서」 — 같은 촬영분인지 가르는 기준 */
const shootKey = (sp) => sp.split('/').slice(0, 3).join('/');

const mc = new MongoClient(process.env.MONGODB_URI);
await mc.connect();
const db = mc.db(process.env.MONGODB_DB || undefined);
const col = db.collection('dropbox_assets');
const base = { section: { $ne: 'brand' }, active: { $ne: false } };
// 화면과 같은 순서 — src/lib/queries.ts 의 DROPBOX_SORT
const all = await col.find(base).sort({ srcUploaded: -1, srcMtime: -1, sourcePath: 1 }).project({ url: 1, title: 1, sourcePath: 1 }).toArray();

// 끝 사진 이름이 같은 폴더 안에서도 겹칠 때(원본 DSC02962.JPG · retouching/DSC02962.png) --from-path= / --to-path= 로 경로 일부를 준다
const FROM_PATH = arg('from-path'), TO_PATH = arg('to-path');
const hitsA = all.filter((d) => d.title === FROM && (!FROM_PATH || d.sourcePath.includes(FROM_PATH)));
const hitsB = all.filter((d) => d.title === TO && (!TO_PATH || d.sourcePath.includes(TO_PATH)));
if (hitsA.length !== 1 || hitsB.length !== 1) {
  console.log(`양 끝 사진이 하나씩이어야 합니다 — ${FROM} ${hitsA.length}건, ${TO} ${hitsB.length}건`);
  for (const d of [...hitsA, ...hitsB]) console.log('   ', d.title, d.sourcePath);
  await mc.close(); process.exit(1);
}
const a = all.indexOf(hitsA[0]), b = all.indexOf(hitsB[0]);
const keys = new Set([shootKey(hitsA[0].sourcePath), shootKey(hitsB[0].sourcePath)]);
/*
 * --by-number: 「JVD_6315~JVD_6909」 처럼 이름 앞부분이 같으면 목록 순서가 아니라 **파일 번호**로 고른다.
 * 최신순 목록에서는 같은 촬영분의 다른 번호(6030·7355 …)가 사이에 섞여 들어오기 때문
 * (사용자 결정 2026-09-22: 목록 순서 1,120장이 아니라 번호 범위 541장).
 */
const BY_NUMBER = process.argv.includes('--by-number');
const numOf = (t) => { const m = /^(.*?)(\d+)$/.exec(t); return m ? { pre: m[1], n: Number(m[2]) } : null; };
let seg;
if (BY_NUMBER) {
  const A = numOf(FROM), B = numOf(TO);
  if (!A || !B || A.pre !== B.pre) { console.log('--by-number 는 이름 앞부분이 같고 번호로 끝나야 합니다'); await mc.close(); process.exit(1); }
  const lo = Math.min(A.n, B.n), hi = Math.max(A.n, B.n);
  seg = all.filter((d) => { const x = numOf(d.title); return x && x.pre === A.pre && x.n >= lo && x.n <= hi; });
} else {
  seg = all.slice(Math.min(a, b), Math.max(a, b) + 1);
}
/*
 * 기본 규칙 (사용자 결정 2026-09-22): 구간 안의 **촬영본(「촬영/」·「촬영2022/」)은 지우고, 공식 제품사진(「제품사진/」)은 남긴다.**
 * 번호 구간은 같은 이름의 공식 컷(예: 제품사진/허기보/JVD_6339)이 우연히 번호가 겹칠 수 있어서 양 끝과 같은 촬영 폴더만 지운다.
 */
const isShoot = (sp) => /^촬영(2022)?\//.test(sp);
const target = ALL ? seg : seg.filter((d) => (BY_NUMBER ? keys.has(shootKey(d.sourcePath)) : isShoot(d.sourcePath)));
const skipped = seg.filter((d) => !target.includes(d));

const count = (list) => Object.entries(list.reduce((m, d) => ((m[shootKey(d.sourcePath)] = (m[shootKey(d.sourcePath)] || 0) + 1), m), {}))
  .map(([k, v]) => `${k} ${v}`).join(' | ');
console.log(BY_NUMBER ? `번호 구간 ${seg.length}장` : `구간 ${seg.length}장 (목록 ${Math.min(a, b) + 1}~${Math.max(a, b) + 1}번째)`);
console.log(`  지울 것 ${target.length}: ${count(target)}`);
if (skipped.length) console.log(`  남길 것 ${skipped.length}: ${count(skipped)}`);
if (DRY) { await mc.close(); process.exit(0); }

const urls = target.map((d) => d.url);
const used = new Set((await db.collection('cuts').find({ $or: [{ 'inputImages.url': { $in: urls } }, { 'inputImages.originalUrl': { $in: urls } }] })
  .project({ inputImages: 1 }).toArray()).flatMap((c) => (c.inputImages || []).flatMap((i) => [i.url, i.originalUrl])).filter(Boolean));
const purge = target.filter((d) => !used.has(d.url) && SAFE.test(rel(d.url)));
const hideOnly = target.filter((d) => !purge.includes(d));

const f = new Client(30000);
await f.access({ host: (process.env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, ''), port: Number(process.env.FTP_PORT) || 21, user: process.env.FTP_USER, password: process.env.FTP_PASS, secure: false });
const removed = [], failed = [];
for (const d of purge) {
  try { await f.remove(`${ROOT}/${rel(d.url)}`); removed.push(d); }
  catch (e) { if (e.code === 550) removed.push(d); else failed.push(d); }
}
f.close();
const now = new Date();
if (removed.length) await col.updateMany({ _id: { $in: removed.map((d) => d._id) } }, { $set: { active: false, deleted: true, deletedAt: now, deletedNote: `사용자 요청 구간 삭제 ${FROM}~${TO} (${now.toISOString().slice(0, 10)})`, updatedAt: now } });
const hide = [...hideOnly, ...failed];
if (hide.length) await col.updateMany({ _id: { $in: hide.map((d) => d._id) } }, { $set: { active: false, updatedAt: now } });
console.log(`삭제 ${removed.length} · 숨김만 ${hide.length} (생성 컷 사용 ${hideOnly.length} · FTP 실패 ${failed.length})`);
console.log('제품사진 탭 활성', await col.countDocuments(base));
await mc.close();
