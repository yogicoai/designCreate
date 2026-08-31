/**
 * FTP clothes 폴더에서 발견된 미등록 의상 9벌을 talents.outfits 에 추가한다.
 * (썸네일 페이지의 THUMB_MODELS 매핑에 없어서 첫 이관에서 빠졌던 것들 — 실물 확인 후 등록)
 *
 * 사용: node scripts/seed-outfits-extra.mjs
 */
import fs from 'node:fs';
import { MongoClient } from 'mongodb';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8')
    .split('\n').filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const C = 'https://yogibo.openhost.cafe24.com/web/img/none/clothes';

// code 는 크롭 파일명에 쓰이므로 ASCII 여야 한다 (한글 원본은 file 로만 가리킨다)
const EXTRA = [
  { talent: 'W_A', code: 'A_W_C_02', file: 'A_W_C_02.jpg', desc: '블랙 트위드 크롭자켓+미니스커트', descEn: 'a black tweed cropped jacket with a matching button-front mini skirt' },
  { talent: 'W_A', code: 'A_W_C_03', file: 'A_W_C_03.jpg', desc: '블랙 래시가드 스윔원피스', descEn: 'a black long-sleeve rash-guard swim dress' },
  { talent: 'W_B', code: 'B_W_C_03', file: 'B_W_C_03.jpg', desc: '그레이 오버블레이저+셔츠+스커트', descEn: 'an oversized grey blazer over a pale blue shirt with a grey mini skirt' },
  { talent: 'W_B', code: 'B_W_C_04', file: 'B_W_C_04.jpg', desc: '화이트 크롭탑+블랙 스윔하의', descEn: 'a white cropped top with black swim bottoms' },
  { talent: 'W_B', code: 'B_W_C_05', file: 'B_W_A_C.jpg', desc: '그레이 티+데님 버뮤다', descEn: 'a grey tee with light-wash denim bermuda shorts and white socks' },
  { talent: 'M_A', code: 'A_M_C_04', file: 'A_M_C_04.jpg', desc: '화이트 티+그레이 와이드슬랙스', descEn: 'a plain white tee with light grey wide-leg trousers' },
  { talent: 'M_A', code: 'A_M_C_05', file: 'A_M_C_05.jpg', desc: '블랙 수트+타이', descEn: 'a black suit with a white shirt and a slim black tie' },
  { talent: 'M_A', code: 'A_M_C_06', file: 'A_M_C_06.jpg', desc: '그래픽 탱크+네이비 보드쇼츠', descEn: 'a sleeveless graphic tank top with navy board shorts' },
  { talent: 'M_A', code: 'A_M_EX_01', file: encodeURIComponent('260812_남성A_의상_1.jpg'), desc: '라이트그레이 티+그레이 와이드팬츠', descEn: 'a light grey tee with grey wide-leg trousers' },
  // 수영복 컨셉 — 모델 C·D (2026-08-31 사용자 추가분)
  { talent: 'W_C', code: 'C_W_C_02', file: 'C_cloath.jpg', desc: '화이트·핑크 크롭 래시가드+핑크 스윔쇼츠', descEn: 'a white-and-pink cropped half-zip rash guard with black raglan sleeves and pink swim shorts, no brand logos' },
  { talent: 'W_D', code: 'D_W_C_03', file: 'D_cloath.jpg', desc: '블랙 하프집업 래시가드+블랙 스윔쇼츠', descEn: 'a black half-zip long-sleeve rash guard with white piping and matching black swim shorts, no brand logos' },
];

const client = new MongoClient(env.MONGODB_URI, { maxPoolSize: 3 });
await client.connect();
const db = client.db(env.MONGODB_DB || 'imgcreate');

let added = 0;
for (const e of EXTRA) {
  const t = await db.collection('talents').findOne({ _id: e.talent });
  if (!t) { console.log('⚠️ 모델 없음:', e.talent); continue; }
  if ((t.outfits || []).some((o) => o.code === e.code)) { console.log('  =', e.code, '(이미 있음)'); continue; }
  await db.collection('talents').updateOne(
    { _id: e.talent },
    { $push: { outfits: { code: e.code, desc: e.desc, descEn: e.descEn, imageUrl: `${C}/${e.file}` } } },
  );
  added++;
  console.log(`  + ${e.talent} ← ${e.code} (${e.desc})`);
}
console.log(`\n의상 ${added}벌 추가.`);
for (const t of await db.collection('talents').find({}).sort({ order: 1 }).toArray()) {
  console.log(`  ${String(t.code).padEnd(5)} 의상 ${t.outfits.length}벌: ${t.outfits.map((o) => o.code).join(', ')}`);
}
await client.close();
