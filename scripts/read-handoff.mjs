/**
 * 화면에서 '힉스필드용으로 남기기'로 저장한 조립 결과를 읽는다.
 *
 * 왜 필요한가:
 *   /create 의 선택(모델·표정·의상·규격·레퍼런스)은 브라우저 상태라 대화 쪽에서 볼 수 없다.
 *   그래서 매번 말로 다시 설명해야 했다. 이 기록이 그 왕복을 없앤다.
 *
 * 사용:
 *   node --env-file=.env.local scripts/read-handoff.mjs           # 가장 최근 1건
 *   node --env-file=.env.local scripts/read-handoff.mjs --list     # 최근 10건 목록
 *   node --env-file=.env.local scripts/read-handoff.mjs <id>       # 특정 건
 *   node --env-file=.env.local scripts/read-handoff.mjs --used <id> # 처리 완료 표시
 */
import { MongoClient, ObjectId } from 'mongodb';

const arg = process.argv[2];
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const col = client.db(process.env.MONGODB_DB || undefined).collection('handoffs');

if (arg === '--list') {
  const docs = await col.find({}).sort({ createdAt: -1 }).limit(10).toArray();
  if (!docs.length) console.log('남긴 기록이 없습니다.');
  for (const d of docs) {
    const t = new Date(d.createdAt).toISOString().slice(0, 19).replace('T', ' ');
    const codes = (d.selection?.talents ?? []).map((x) => x.code || '자유').join(', ');
    console.log(`${d.used ? '·' : '★'} ${String(d._id)}  ${t}  참조${d.refs?.length ?? 0}  [${codes}]  ${d.sizeLabel || ''}`);
  }
  await client.close();
  process.exit(0);
}

if (arg === '--used') {
  await col.updateOne({ _id: new ObjectId(process.argv[3]) }, { $set: { used: true, usedAt: new Date() } });
  console.log('처리 완료로 표시했습니다.');
  await client.close();
  process.exit(0);
}

const doc = arg
  ? await col.findOne({ _id: new ObjectId(arg) })
  : (await col.find({}).sort({ createdAt: -1 }).limit(1).toArray())[0];

if (!doc) {
  console.log('남긴 기록이 없습니다. /create 에서 "힉스필드용으로 남기기"를 눌러주세요.');
  await client.close();
  process.exit(1);
}

const s = doc.selection ?? {};
console.log('═══ HANDOFF ' + String(doc._id) + ' ═══');
console.log('남긴 시각 : ' + new Date(doc.createdAt).toISOString().slice(0, 19).replace('T', ' ') + (doc.used ? '  (처리됨)' : ''));
console.log('규격      : ' + (doc.sizeLabel || s.sizeValue || '?') + '  ' + (doc.target ? `${doc.target.width}x${doc.target.height}` : '') + '  aspect=' + (doc.aspect || '?'));
console.log('프롬프트  : ' + (doc.promptMode || '?'));
console.log('편집 타깃 : ' + ((s.editTargets ?? []).join(', ') || '(없음)'));
console.log('보존 모드 : ' + (s.preservation || '(없음)'));

console.log('\n── 인물 (왼쪽부터) ──');
for (const [i, t] of (s.talents ?? []).entries()) {
  if (t.freeform) console.log(`  ${i + 1}. [자유서술] ${t.freeform.identityEn}${t.freeform.outfitFree ? ' / ' + t.freeform.outfitFree : ''}`);
  else console.log(`  ${i + 1}. ${t.code}  표정=${t.expression || '(미지정)'}  의상=${t.outfitCode || '(미지정)'}${t.placement ? '  위치=' + t.placement : ''}`);
}
if (!(s.talents ?? []).length) console.log('  (없음)');

if ((s.products ?? []).length) {
  console.log('\n── 제품 ──');
  for (const p of s.products) console.log(`  ${p.line}  ${p.colorKey || ''}  ${p.placement || ''}`);
}

if ((s.uploadedRefs ?? []).length) {
  console.log('\n── 업로드 레퍼런스 ──');
  for (const r of s.uploadedRefs) console.log(`  [${r.role}] ${r.title || ''}\n      ${r.url}`);
}

if (s.direction) console.log('\n── 방향 지시 ──\n  ' + s.direction);

console.log('\n── 참조 순서 (프롬프트의 FIRST/SECOND/…) ──');
for (const [i, r] of (doc.refs ?? []).entries()) {
  console.log(`  ${i + 1}. [${r.kind}] ${r.title}`);
  console.log(`      ${r.url || 'SWATCH ' + r.swatchHex}`);
}

console.log('\n── 프롬프트 ──\n');
console.log(doc.prompt);
await client.close();
