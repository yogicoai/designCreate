import fs from 'node:fs';
import { MongoClient, ObjectId } from 'mongodb';

/**
 * AI 1차 제품 라벨을 dropbox_assets 에 넣는다 (2026-09-22, 촬영 2018~2021 폴더).
 *
 * 입력: 분류 워크플로 journal.jsonl(에이전트별 결과) + 준비 단계 manifest.json(sid → 문서 id · 확인 코드)
 *
 * 확인 코드: 준비 단계에서 사진마다 3글자를 찍었다. 에이전트가 읽어 온 코드가 다르면 그 사진을
 * 실제로 보지 않았을 수 있다(테스트에서 없는 파일에 결과를 지어낸 적이 있다) — 넣지 않고 다시 돌릴 목록에 둔다.
 *
 * 등급 (블라인드 테스트 2026-09-22: 확신도 ≥0.7 → 96% 정확, 큰 무리 기준 93%):
 *   확신도 ≥ 0.7        → 제품명 그대로 (+ 함께 나온 제품)
 *   0.5 ≤ 확신도 < 0.7  → 맥스·미디·미니·슬림·더블은 「맥스 계열」, 팟·드롭은 「물방울 계열」, 나머지 모양은 그대로
 *   그 밖 · Unknown      → 라벨 없음(= 미분류)
 *   NoYogibo            → 「제품 없음」
 * 사람이 정리 모드에서 고친 것(productsSource 'human')은 절대 덮지 않는다.
 *
 * 사용: node --env-file=.env.local scripts/apply-dropbox-ai-labels.mjs <journal.jsonl> <manifest.json> [--dry]
 */

const [journalPath, manifestPath] = process.argv.slice(2);
const DRY = process.argv.includes('--dry');
if (!journalPath || !manifestPath) { console.error('journal.jsonl 과 manifest.json 경로가 필요합니다'); process.exit(1); }

const KR = {
  Max: '맥스', Midi: '미디', Mini: '미니', Slim: '슬림', Double: '더블', Lounger: '라운저', Support: '서포트',
  Pyramid: '피라미드', Pod: '팟', Drop: '드롭', Hugibo: '허기보', Bubble: '버블', Roll: '바디필로우', Mate: '메이트',
  OtherYogibo: '기타 요기보', NoYogibo: '제품 없음',
};
const MAX_FAMILY = new Set(['Max', 'Midi', 'Mini', 'Slim', 'Double']);
const TEAR_FAMILY = new Set(['Pod', 'Drop']);

function labelsFor(r) {
  if (r.primary === 'NoYogibo') return ['제품 없음'];
  const conf = Number(r.confidence) || 0;
  if (r.primary === 'Unknown' || conf < 0.5) return [];
  const exact = conf >= 0.7;
  const map = (p) => {
    if (p === 'Unknown' || p === 'NoYogibo' || !KR[p]) return null;
    if (exact) return KR[p];
    if (MAX_FAMILY.has(p)) return '맥스 계열';
    if (TEAR_FAMILY.has(p)) return '물방울 계열';
    return KR[p];
  };
  return [...new Set([r.primary, ...(r.others || [])].map(map).filter(Boolean))];
}

const manifest = new Map(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).map((m) => [m.sid, m]));
const lines = fs.readFileSync(journalPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const results = new Map();
for (const l of lines) {
  if (l.type !== 'result') continue;
  const v = typeof l.result === 'string' ? JSON.parse(l.result) : l.result;
  for (const r of v?.results ?? []) results.set(r.sid, r);
}

const rerun = [];
const updates = [];
const tiers = { exact: 0, family: 0, unsorted: 0, none: 0 };
for (const [sid, m] of manifest) {
  const r = results.get(sid);
  if (!r) { rerun.push({ sid, why: 'missing' }); continue; }
  if (String(r.code || '').trim().toUpperCase() !== m.code) { rerun.push({ sid, why: `code ${r.code} ≠ ${m.code}` }); continue; }
  const products = labelsFor(r);
  const conf = Number(r.confidence) || 0;
  if (products[0] === '제품 없음') tiers.none++;
  else if (!products.length) tiers.unsorted++;
  else if (conf >= 0.7) tiers.exact++;
  else tiers.family++;
  updates.push({ id: m.id, products, ai: { primary: r.primary, others: r.others || [], confidence: conf, at: new Date(), run: '2026-09-22-shoot' } });
}

console.log(`결과 ${results.size} · 넣을 것 ${updates.length} · 다시 돌릴 것 ${rerun.length}`);
console.log(`등급 — 제품명 ${tiers.exact} · 큰 무리 ${tiers.family} · 미분류 ${tiers.unsorted} · 제품 없음 ${tiers.none}`);
fs.writeFileSync(manifestPath.replace(/manifest\.json$/, 'rerun.json'), JSON.stringify(rerun));

if (!DRY && updates.length) {
  const mc = new MongoClient(process.env.MONGODB_URI);
  await mc.connect();
  const col = mc.db(process.env.MONGODB_DB || undefined).collection('dropbox_assets');
  let written = 0, keptHuman = 0;
  for (let i = 0; i < updates.length; i += 500) {
    const chunk = updates.slice(i, i + 500);
    const r = await col.bulkWrite(chunk.map((u) => ({
      updateOne: {
        filter: { _id: new ObjectId(u.id), productsSource: { $ne: 'human' } },
        update: { $set: { products: u.products, productsSource: 'ai', ai: u.ai, updatedAt: new Date() } },
      },
    })));
    written += r.modifiedCount;
    keptHuman += chunk.length - r.matchedCount;
  }
  console.log(`DB 반영 ${written} · 사람이 고친 것이라 건너뜀 ${keptHuman}`);
  await mc.close();
}
