// Gemini 연결 점검 — 키 유효성 + 사용 가능한 이미지 생성 모델 목록.
// 사용: node scripts/check-gemini.mjs
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const key = env.GEMINI_API_KEY;
if (!key) { console.error('GEMINI_API_KEY 없음'); process.exit(1); }

const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
  headers: { 'x-goog-api-key': key },
});
console.log('HTTP', res.status);
const json = await res.json();
if (json.error) { console.error('ERROR:', json.error.status, '-', json.error.message); process.exit(1); }

const models = (json.models || []).map((m) => m.name.replace('models/', ''));
console.log('총 모델:', models.length);
console.log('\n── 이미지 생성 계열 ──');
for (const n of models.filter((n) => /image|imagen|banana/i.test(n))) console.log('  ', n);

// .env 에 지정한 모델이 실제로 있는지
for (const k of ['GEMINI_IMAGE_MODEL', 'GEMINI_IMAGE_MODEL_PRO']) {
  const want = env[k];
  if (want) console.log(`\n${k}=${want} →`, models.includes(want) ? '✅ 사용 가능' : '❌ 목록에 없음');
}
