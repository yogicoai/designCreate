/**
 * 브랜드 정리 85장을 "한 묶음 + 캠페인 이름은 파일명" 으로 바꾼다 (사용자 요청 2026-09-21).
 *
 * 처음에는 캠페인 폴더마다 칩을 나눠(시즌 4 + 월별 13 = 17개) 보여줬는데, 사용자가
 * "폴더로 각각 나눌 필요 없고 하나로 묶어놓고 파일명만 저런 식으로" 라고 했다.
 * 그래서:
 *   folderHint / sub = '브랜드 정리'            — 칩은 하나
 *   title            = '04월 (PASTEL LOVE) 01'   — 캠페인 이름 + 캠페인 안 번호
 *   campaign         = '04월 (PASTEL LOVE)'      — 캠페인은 구조화된 값으로도 남긴다(나중에 칩이 다시 필요할 때)
 *   originalTitle    = 원래 파일명               — 되돌릴 수 있게
 * 검색이 제목으로 걸리므로 「04월」「PASTEL」 로 캠페인을 찾을 수 있다.
 *
 * 사용: node scripts/migrate-brand-titles.mjs [--go]
 */
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';

const GO = process.argv.includes('--go');
for (const ln of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
export const BRAND_BUCKET = '브랜드 정리';

const mc = new MongoClient(process.env.MONGODB_URI);
await mc.connect();
const col = mc.db(process.env.MONGODB_DB || undefined).collection('dropbox_assets');

const docs = await col.find({ section: 'brand' }).sort({ sourcePath: 1 }).toArray();
// 캠페인은 이미 옮겼으면 campaign 필드, 아니면 지금의 sub(=맨 안쪽 폴더명)
const byCampaign = new Map();
for (const d of docs) {
  const c = d.campaign || d.sub || d.folderHint || '(분류없음)';
  if (!byCampaign.has(c)) byCampaign.set(c, []);
  byCampaign.get(c).push(d);
}

const plan = [];
for (const [campaign, rows] of byCampaign) {
  rows.forEach((d, i) => {
    plan.push({
      _id: d._id,
      campaign,
      title: `${campaign.replace(/\s+/g, ' ').trim()} ${String(i + 1).padStart(2, '0')}`,
      originalTitle: d.originalTitle || d.title,
    });
  });
}

console.log(`브랜드 ${docs.length}장 · 캠페인 ${byCampaign.size}개 → 칩 1개('${BRAND_BUCKET}')`);
for (const [c, rows] of byCampaign) console.log(`  ${c.padEnd(26)} ${rows.length}장  예) ${plan.find((p) => p.campaign === c).title}`);

if (!GO) { console.log('\n드라이런입니다. 적용하려면 --go'); await mc.close(); process.exit(0); }

for (const p of plan) {
  await col.updateOne({ _id: p._id }, {
    $set: { title: p.title, campaign: p.campaign, originalTitle: p.originalTitle, sub: BRAND_BUCKET, folderHint: BRAND_BUCKET, updatedAt: new Date() },
  });
}
const chips = await col.distinct('folderHint', { section: 'brand' });
console.log(`\n적용 ${plan.length}장 · 브랜드 칩: ${chips.join(', ')}`);
await mc.close();
