/**
 * 얼굴 검사를 다시 돌린다 — 검사 방식을 고친 뒤 예전 판정을 바로잡는다 (점검 2026-10-02 8번).
 *
 * 2026-10-02: 여러 명이 나오는 컷에서 모든 모델을 "가장 잘 보이는 얼굴" 하나와 비교하고 있었다(아이 시트를 옆의 어른과 비교).
 * 고친 검사로 다시 돌리면 헛 경고가 빠지고, 머리 위치(headBox)가 남아 「생성 품질」의 시리즈 일관성 줄에 그 컷이 나온다.
 *
 * 사용: node --env-file=.env.local scripts/recheck-faces.mjs            얼굴 검사 기록이 있는 컷 전부 (머리 위치가 없는 것만)
 *       node --env-file=.env.local scripts/recheck-faces.mjs --multi    2명 이상 나온 컷만
 *       node --env-file=.env.local scripts/recheck-faces.mjs --drift    지금 "어긋남" 으로 찍힌 컷만 (두 번 물어 확인하는 규칙을 적용)
 *       node --env-file=.env.local scripts/recheck-faces.mjs --dry      대상 수만 본다
 * 컷마다 모델 수만큼 비전을 부른다(가벼운 호출). 개발 서버(http://localhost:6100)가 떠 있어야 한다.
 */
import { MongoClient } from 'mongodb';
const MULTI = process.argv.includes('--multi');
const DRY = process.argv.includes('--dry');
const DRIFT = process.argv.includes('--drift');
const API = process.env.QC_RECHECK_API || 'http://localhost:6100/api/qc/recheck';
const m = new MongoClient(process.env.MONGODB_URI); await m.connect();
const cuts = await m.db(process.env.MONGODB_DB || undefined).collection('cuts')
  .find({ source: 'imgcreate', 'qc.face.checked': true, 'recipe.talentCodes.0': { $exists: true }, ...(DRIFT ? { 'qc.face.verdicts.verdict': 'drift' } : { 'qc.face.verdicts.headBox': { $exists: false } }) })
  .project({ recipe: 1 }).sort({ createdAt: -1 }).toArray();
await m.close();
const ids = cuts.filter((c) => !MULTI || (c.recipe?.talentCodes ?? []).length >= 2).map((c) => String(c._id));
const calls = cuts.filter((c) => ids.includes(String(c._id))).reduce((s, c) => s + (c.recipe?.talentCodes ?? []).length, 0);
console.log(`대상 ${ids.length}컷 · 비전 호출 약 ${calls}회`);
if (DRY || !ids.length) process.exit(0);
let changed = 0, done = 0;
for (let i = 0; i < ids.length; i += 4) {
  const res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ids.slice(i, i + 4) }) });
  const json = await res.json();
  if (!json.ok) { console.error('실패:', json.error); process.exit(1); }
  for (const r of json.results ?? []) {
    if (!r) continue;
    done++;
    if (r.before !== r.after) { changed++; console.log(`  ${r.id}  ${r.before}  →  ${r.after}`); }
  }
}
console.log(`다시 검사 ${done}컷 · 판정이 바뀐 컷 ${changed}`);
