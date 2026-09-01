/*
 * 라인 단위 형태 참조(shapeViews) 백필.
 *
 * 왜 필요한가:
 *   seed 는 legacy-products.json 의 뷰를 (라인 + 한글 컬러명) 완전일치로만 붙인다.
 *   그런데 legacy 에 남은 컬러와 지금 판매 중인 컬러 슬롯이 서로 다른 라인이 많다.
 *   예) legacy 팟 = 아쿠아블루·올리브그린 / DB 팟 = 프레시민트·다크그레이·파스텔블루 → 한 장도 안 붙는다.
 *   그 결과 6개 라인(팟·드롭·피라미드·슬림·미니·서포트)이 사진 없이 텍스트로만 형태를 지시받는다.
 *   "레퍼런스가 엔진보다 중요하다"가 이 프로젝트에서 확인된 가장 큰 품질 요인이라, 이건 그냥 손해다.
 *
 * 무엇을 하는가:
 *   컬러가 안 맞아도 같은 라인이면 뷰를 product.shapeViews 로 올려둔다.
 *   색은 못 쓰고 형태만 쓰는 참조이므로 프롬프트에서 "colour is specified in the text" 로 나간다.
 *
 * 안전성: products 의 shapeViews 필드만 $set 한다. 컬러 슬롯·영문명·표정 크롭은 건드리지 않는다.
 *   (seed.mjs 는 products 를 통째로 갈아엎으므로 이 스크립트는 seed 이후에 다시 돌려야 한다)
 */
import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';

const LINE_KR = {
  Max: '맥스', Slim: '슬림', Midi: '미디', Mini: '미니', Drop: '드롭',
  Lounger: '라운저', Pyramid: '피라미드', Pod: '팟', Double: '더블', Support: '서포트',
};

const raw = JSON.parse(readFileSync(new URL('../data/legacy-products.json', import.meta.url), 'utf8'));
const legacy = Array.isArray(raw) ? raw : raw.products || [];

const c = new MongoClient(process.env.MONGODB_URI);
await c.connect();
const db = c.db(process.env.MONGODB_DB || undefined);
const col = db.collection('products');

let touched = 0;
for (const p of await col.find({}).toArray()) {
  const kr = LINE_KR[p.line];
  if (!kr) continue;

  // 이 라인의 legacy 항목 중 뷰를 가진 것들
  const cands = legacy
    .filter((x) => (x.name || '').trim().startsWith(kr))
    .flatMap((x) => (x.colors || []).map((cc) => ({ colorName: (cc.color || '').trim(), views: cc.views })))
    .filter((x) => x.views && Object.keys(x.views).length);
  if (!cands.length) continue;

  // 이미 컬러 슬롯에 뷰가 붙어 있으면 그게 우선이다 — shapeViews 는 어디까지나 빈자리 메우기
  const slotHasViews = (p.colors || []).some((x) => x.views && Object.keys(x.views).length);

  // 후보 중 각도가 가장 많은 것 하나
  const best = cands.sort((a, b) => Object.keys(b.views).length - Object.keys(a.views).length)[0];

  await col.updateOne(
    { _id: p._id },
    { $set: { shapeViews: { colorName: best.colorName, views: best.views } } },
  );
  touched++;
  console.log(
    `${p.line.padEnd(9)} shapeViews ← ${best.colorName} (${Object.keys(best.views).join(',')})` +
      (slotHasViews ? '  [컬러 슬롯 뷰가 있어 보조용]' : '  [이 라인의 유일한 사진 참조]'),
  );
}
console.log(`\n${touched}개 라인에 형태 참조를 붙였습니다.`);
await c.close();
