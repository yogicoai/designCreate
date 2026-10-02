/**
 * 작업 규칙 추가 — 대화에서 실측으로 찾은 요령을 공통 규칙(house_rules, appliesTo='operator')으로 올린다 (점검 2026-10-02 5·10번).
 *
 * 이 규칙들은 메모와 코드 주석에만 있어서 MD 가 볼 수 없었다. 작업자용이라 이미지 프롬프트에는 들어가지 않고,
 * 이미지 생성 화면의 「생성 전 확인 › 작업 규칙」 에서 보인다. 여러 번 돌려도 같은 결과다(_id 로 덮어쓴다).
 *
 * 사용: node --env-file=.env.local scripts/seed-operator-rules.mjs [--dry]
 */
import { MongoClient } from 'mongodb';

const RULES = [
  { id: 'rule_op_twotone', critical: true, kr: '★ 겹치는 조합 컷은 두 제품 색을 다르게 — 같은 색이면 경계가 사라져 한 덩어리로 보인다.' },
  { id: 'rule_op_hero', critical: true, kr: '★ 가로로 넓은 구도는 제품이 주인공 — 모델은 인테리어에 녹는 조연이다. 인물을 키우는 지시를 넣지 않는다.' },
  { id: 'rule_op_product', critical: false, kr: '모델 컷에는 제품을 반드시 고른다(사진 편집이면 「사진 속 제품」) — 안 고르면 크기 기준이 맥스로 잡혀 사람·제품 비율이 어긋난다.' },
  { id: 'rule_op_face_wide', critical: false, kr: '얼굴이 중요한 컷은 가로로 긴 규격을 피한다 — 얼굴이 작으면 프롬프트로 변형을 못 막는다. 2~4장 뽑아 고른다.' },
  { id: 'rule_op_real_base', critical: false, kr: '제품 형태가 중요하면 실촬영 사진을 「이 사진을 편집」 으로 두고 인물만 바꾼다 — 형태가 가장 안정적이다.' },
  { id: 'rule_op_bg_clean', critical: false, kr: '배경 사진은 사람·빈백·촬영 장비·테두리·글자가 없는 것으로 — 있으면 결과에 그대로 남는다(올리면 자동으로 알려 준다).' },
];

const DRY = process.argv.includes('--dry');
const m = new MongoClient(process.env.MONGODB_URI); await m.connect();
const col = m.db(process.env.MONGODB_DB || undefined).collection('house_rules');
const maxOrder = (await col.find({ _id: { $not: /^rule_op_/ } }).sort({ order: -1 }).limit(1).toArray())[0]?.order ?? -1;
for (const [i, r] of RULES.entries()) {
  const doc = { order: maxOrder + 1 + i, kr: r.kr, en: '', critical: r.critical, appliesTo: 'operator', conditional: null, enabled: true };
  console.log(`${DRY ? '(dry) ' : ''}${r.id}  order ${doc.order}  ${r.kr.slice(0, 50)}`);
  if (!DRY) await col.updateOne({ _id: r.id }, { $set: doc }, { upsert: true });
}
console.log(`작업 규칙 ${await col.countDocuments({ appliesTo: 'operator', enabled: { $ne: false } })}개 · 이미지 규칙 ${await col.countDocuments({ appliesTo: 'image' })}개`);
await m.close();
