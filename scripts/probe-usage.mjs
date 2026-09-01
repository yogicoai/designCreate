/**
 * 실제 과금 근거 확인 — 생성 1장의 usageMetadata 를 그대로 찍는다.
 * 지금까지 화면에 뜬 ₩200 은 공식 단가 + 추정 토큰으로 계산한 값이라, 실제 응답과 대조한다.
 */
import fs from 'node:fs';
import sharp from 'sharp';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const KEY = env.GEMINI_API_KEY;
const MODEL = env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image';

// 실제 생성과 동일한 참조 8장 (dryRun 이 뽑아준 순서 그대로)
const REFS = [
  'https://yogibo.openhost.cafe24.com/web/img/api/modal/B_D_rep.jpg?v=smile2',
  'https://yogibo.openhost.cafe24.com/web/design/assets/expressions/W_D_soft_smile.jpg',
  'https://yogibo.openhost.cafe24.com/web/img/none/max/max_p_03.jpg',
  'https://yogibo.openhost.cafe24.com/web/img/none/max/max_p_none_03.png',
  'https://yogibo.openhost.cafe24.com/web/img/ai/views/a016d3e9_c0_a045.jpg',
  'https://yogibo.openhost.cafe24.com/web/img/ai/views/a016d3e9_c0_side.jpg',
  'https://yogibo.openhost.cafe24.com/web/design/assets/outfits/D_W_C_01_crop.jpg',
];

async function ref(url) {
  const r = await fetch(url);
  const buf = Buffer.from(await r.arrayBuffer());
  const out = await sharp(buf).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  return { inlineData: { mimeType: 'image/jpeg', data: out.toString('base64') } };
}

const swatch = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#1D395D' } }).png().toBuffer();
const parts = [...(await Promise.all(REFS.map(ref))), { inlineData: { mimeType: 'image/png', data: swatch.toString('base64') } }];

const prompt = fs.readFileSync(process.argv[2], 'utf8');
parts.push({ text: prompt });

const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
  body: JSON.stringify({
    contents: [{ parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1', imageSize: '2K' } },
  }),
});
const json = await res.json();
console.log('HTTP', res.status, '· 모델', MODEL);
console.log('\n=== usageMetadata (실제 과금 근거) ===');
console.log(JSON.stringify(json.usageMetadata, null, 2));
