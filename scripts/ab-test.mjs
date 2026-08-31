/**
 * Phase 0.5 — 나노바나나 A/B 실측.
 * 기존 승인 컷과 동일한 작업을 gemini-3-pro-image 로 재현해 품질을 눈으로 판정한다.
 *
 * 사용: node scripts/ab-test.mjs [케이스키...]   (생략 시 전부)
 * 결과: out/abtest/<케이스>_<n>.png
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

// ── env ──
const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8')
    .split('\n').filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const KEY = env.GEMINI_API_KEY;
const MODEL = env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image';
const SIZE = env.GEMINI_IMAGE_SIZE || '2K';
const API = 'https://generativelanguage.googleapis.com/v1beta/models';

const OUT = 'out/abtest';
fs.mkdirSync(OUT, { recursive: true });

const M = 'https://yogibo.openhost.cafe24.com/web/img/api/modal';
const NONE = 'https://yogibo.openhost.cafe24.com/web/img/none';

// ── 참조 로딩: URL → 1024px JPEG base64 (Vercel 4.5MB 한도 대비 필수) ──
async function loadRef(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`참조 로딩 실패 ${res.status}: ${url}`);
  const raw = Buffer.from(await res.arrayBuffer());
  const buf = await sharp(raw)
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  console.log(`   참조 [${label}] ${(raw.length / 1024 / 1024).toFixed(2)}MB → ${(buf.length / 1024).toFixed(0)}KB`);
  return { mimeType: 'image/jpeg', data: buf.toString('base64') };
}

/** 컬러 스와치 — 공식 hex 를 참조 이미지로 동반 투입 (컬러 정확도 대응) */
async function swatch(hex) {
  const buf = await sharp({
    create: { width: 512, height: 512, channels: 3, background: hex },
  }).png().toBuffer();
  return { mimeType: 'image/png', data: buf.toString('base64') };
}

// ── 전 컷 공통 규칙 (youtube/thumbnails 의 CAUTIONS 를 상수화) ──
const HOUSE_RULES = [
  'The model must wear a natural, gentle smile - never a blank expression.',
  'The Yogibo cover fabric is smooth and continuous: NO zippers, NO visible seams, NO piping.',
  'Studio background is a flat light grey #f2f2f4 - not pure white.',
  'The fabric visibly compresses and dents under body weight; edges rise around the body as the person sinks in.',
  'Photorealistic commercial product photography. No text, no logo overlay, no watermark, no badges.',
].join(' ');

const CASES = {
  // T1 — 가장 자주 쓰는 패턴: 승인 컷 베이스로 컬러 리컬러 + 모델 교체
  t1_recolor_swap: {
    title: 'T1 · 컬러 리컬러 + 모델 교체 (승인컷 베이스)',
    aspect: '1:1',
    refs: [
      { url: `${M}/cand_max_navy_c_pose1.png?v=2`, label: '베이스컷: Max 네이비 · 모델C · 포즈1' },
      { url: `${M}/B_D_expr.png?v=hair`, label: '모델D 표정 시트 (8표정)' },
      { swatch: '#790619', label: '체리레드 컬러 스와치' },
    ],
    prompt: `The FIRST image is the base photograph. Reproduce it EXACTLY - same camera angle, same pose, same body position, same limb placement, same bean bag shape and compression, same lighting, same background, same framing and crop. Change ONLY the two things below.

CHANGE 1 - PRODUCT COLOUR: recolour the Yogibo Max bean bag from navy to CHERRY RED. The THIRD image is the exact official colour swatch (#790619) - match that hue, saturation and darkness precisely. Do not drift toward orange, pink or brown. Keep the fabric existing shading, folds and highlights; only the hue changes.

CHANGE 2 - MODEL IDENTITY: replace the woman face and hair with the woman in the SECOND image (a reference sheet of one model in 8 expressions). Use the gentle-smile panel. Keep her exact face construction, features, skin tone and hairstyle (long black straight hair, centre part). She is East Asian, early-to-mid 20s, 173cm slim. Her outfit becomes a grey tee with light baggy jeans, barefoot.

Everything else - pose, product geometry, scale, lighting, background - must be pixel-faithful to the FIRST image. ${HOUSE_RULES}`,
  },

  // T2 — Element 토큰 없이 형태 레퍼만으로 제품 정확도가 나오나 (0-from-scratch)
  t2_from_shape_ref: {
    title: 'T2 · 형태레퍼 기반 신규 생성 (Element 토큰 없이)',
    aspect: '1:1',
    refs: [
      { url: `${NONE}/max/max_p_none_03.png`, label: '형태 레퍼(off): Max 리클라이너 눌림' },
      { url: `${M}/B_B_expr.png?v=v2`, label: '모델B 표정 시트' },
      { swatch: '#668B01', label: '올리브그린 컬러 스와치' },
    ],
    prompt: `Create a square e-commerce product thumbnail of a Yogibo Max bean bag with a woman reclining on it.

PRODUCT - Yogibo Max (olive green). The FIRST image shows the EXACT product shape and compression to reproduce: a bean bag that has been sat on, already dented and shaped by a body. Match that silhouette.
SHAPE: a LONG SOFT PILL shape - like a giant body pillow or a long sausage cushion, rounded at both ends, NO armrests, NO backrest frame.
EXACT SIZE: 70cm wide x 45cm deep x 170cm tall/long, 6.6kg.
SCALE ANCHOR: a large bean bag sofa as long as an adult is tall (170cm) - long enough for a grown-up to lie down on fully.
NEGATIVE: NOT a ball, NOT a round beanbag, NOT a bed, NOT a mattress, NOT a wedge.
COLOUR: olive green - the THIRD image is the exact official swatch (#668B01). Match it precisely.
USE: leaned back as a RECLINER, the woman lying back into it with legs extended forward.

MODEL - the SECOND image is a reference sheet of one model in 8 expressions. Use her exact face, features, skin and hairstyle (long chestnut-brown waves, light freckles). European, early 20s, 172cm slim. Use the gentle-smile panel. Outfit: grey tee and denim shorts, barefoot.

${HOUSE_RULES}`,
  },

  // T3 — 아동 컷 안전필터 확인 (Higgsfield 에서 nsfw 거부 이력 있음)
  t3_child_filter: {
    title: 'T3 · 아동 컷 안전필터 확인',
    aspect: '1:1',
    refs: [
      { url: `${NONE}/pyramid/pyramid_off_01.png`, label: '형태 레퍼(off): Pyramid' },
      { url: `${M}/K_B_expr.png?v=straight`, label: '아동B 표정 시트' },
      { swatch: '#790619', label: '체리레드 컬러 스와치' },
    ],
    prompt: `Create a warm, wholesome square e-commerce product thumbnail for a family furniture catalogue: a child sitting on a Yogibo Pyramid bean bag, reading a picture book.

PRODUCT - Yogibo Pyramid (cherry red). The FIRST image shows the exact product shape to reproduce - a soft teardrop/pyramid bean bag. The THIRD image is the exact official colour swatch (#790619).

CHILD - the SECOND image is a reference sheet of one child model in 8 expressions. Use her exact face and hairstyle (reddish-brown long straight hair, centre part, light freckles). She is about 10-12 years old, roughly 150cm. Use the gentle-smile panel. Outfit: ivory ringer tee and grey shorts. She is fully and modestly dressed, seated upright, calmly reading - a wholesome family catalogue photograph.

${HOUSE_RULES}`,
  },
};

async function generate(caseKey, c, n) {
  const parts = [];
  for (const r of c.refs) {
    parts.push({ inlineData: r.swatch ? await swatch(r.swatch) : await loadRef(r.url, r.label) });
  }
  parts.push({ text: c.prompt });

  const bodyStr = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: c.aspect, imageSize: SIZE },
    },
  });
  console.log(`   요청 본문 ${(Buffer.byteLength(bodyStr) / 1024 / 1024).toFixed(2)}MB (Vercel 한도 4.5MB)`);

  const t0 = Date.now();
  const res = await fetch(`${API}/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
    body: bodyStr,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.log(`   ❌ HTTP ${res.status} (${secs}s): ${t.slice(0, 400)}`);
    return null;
  }
  const json = await res.json();
  if (json.promptFeedback?.blockReason) {
    console.log(`   🚫 안전필터 차단: ${json.promptFeedback.blockReason}`);
    return null;
  }
  const cand = json.candidates?.[0];
  if (cand?.finishReason && cand.finishReason !== 'STOP') {
    console.log(`   ⚠️ finishReason=${cand.finishReason}`);
  }
  for (const p of cand?.content?.parts ?? []) {
    const inline = p.inlineData ?? p.inline_data;
    if (inline?.data) {
      const buf = Buffer.from(inline.data, 'base64');
      const file = path.join(OUT, `${caseKey}_${n}.png`);
      fs.writeFileSync(file, buf);
      const meta = await sharp(buf).metadata();
      console.log(`   ✅ ${file}  ${meta.width}x${meta.height}  ${(buf.length / 1024).toFixed(0)}KB  ${secs}s`);
      return file;
    }
  }
  const txt = (cand?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join(' ');
  console.log(`   ⚠️ 이미지 없음 (${secs}s). 텍스트 응답: ${txt.slice(0, 300)}`);
  return null;
}

const want = process.argv.slice(2);
const keys = want.length ? want : Object.keys(CASES);
const SAMPLES = Number(process.env.SAMPLES || 2);

console.log(`모델 ${MODEL} · ${SIZE} · 케이스 ${keys.length}개 × ${SAMPLES}샘플\n`);
for (const k of keys) {
  const c = CASES[k];
  if (!c) { console.log(`(알 수 없는 케이스: ${k})`); continue; }
  console.log(`\n■ ${c.title}`);
  for (let n = 1; n <= SAMPLES; n++) {
    console.log(`  샘플 ${n}/${SAMPLES}`);
    try { await generate(k, c, n); }
    catch (e) { console.log(`   ❌ ${e.message}`); }
  }
}
console.log(`\n완료 → ${OUT}/`);
