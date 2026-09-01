/**
 * Phase 1 — youtube 프로젝트의 자산을 imgCreate Mongo 로 이관한다.
 *
 * 원본은 전부 cafe24 공개 URL 이므로 파일 재업로드는 없다. URL + 메타데이터만 옮긴다.
 *   data/legacy-assets.json     ← scripts/extract-legacy.mjs 가 뽑아낸 하드코딩 상수
 *   data/legacy-products.json   ← youtube/data/products.json (360뷰 · Element 토큰)
 *   data/legacy-colorchips.json ← youtube/data/colorchips.json
 *
 * 사용: node scripts/seed.mjs [--dry]
 */
import fs from 'node:fs';
import { MongoClient } from 'mongodb';

const DRY = process.argv.includes('--dry');

// ── env ──
const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8')
    .split('\n').filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);

const A = JSON.parse(fs.readFileSync('data/legacy-assets.json', 'utf8'));
const LEGACY_PRODUCTS = JSON.parse(fs.readFileSync('data/legacy-products.json', 'utf8'));
const CHIPS = JSON.parse(fs.readFileSync('data/legacy-colorchips.json', 'utf8'));

// ─────────────────────────────────────────────────────────────────
// 제품 기하 서술
//
// verified:true = youtube/src/lib/productPrompt.js 의 GEOMETRY 를 그대로 이식한 것.
//   12차 실측으로 확립된 값이라 손대면 안 된다.
// verified:false = 이 시드에서 새로 작성한 것. 실측으로 검증되지 않았으므로
//   Phase 3 생성 결과를 보고 다듬어야 한다. (관리 화면에서 수정 가능하게 둔다)
// ─────────────────────────────────────────────────────────────────
const PILL = {
  shape: 'a LONG SOFT PILL shape - like a giant body pillow or a long sausage cushion, rounded at both ends, NO armrests, NO backrest frame',
  negative: 'NOT a ball, NOT a round beanbag, NOT a bed, NOT a mattress, NOT a wedge',
  modes: 'four modes: stand it upright as a CHAIR, lean it back as a RECLINER, lay it FLAT on the floor as a BED, or use it lengthwise as a SOFA',
  verified: true,
};

const GEOMETRY = {
  Max: PILL,
  // Slim/Midi/Mini 는 thumbnails 페이지 스펙에 "Max 동일 형태 · 사이즈만 다름" 으로 명시돼 있어
  // 같은 기하를 쓰되, 치수(dims)와 스케일 앵커로만 구분한다.
  Slim: { ...PILL, modes: 'lean back against it as a narrow RECLINER, or stand it upright as a slim CHAIR' },
  Midi: { ...PILL, modes: 'lean back into it as a low RECLINER, or lay it flat as a compact lounger' },
  Mini: { ...PILL, modes: 'a child sits into it, or an adult leans against it while seated on the floor' },
  Double: {
    shape: 'an EXTRA-LARGE LONG SOFT PILL shape, wide enough for two people side by side, NO armrests',
    negative: 'NOT a ball, NOT a round beanbag, NOT a rigid sofa',
    modes: 'lies flat as a two-person lounger or stands upright as a wide backrest',
    verified: true,
  },
  Pod: {
    shape: 'a NEARLY SPHERICAL egg-shaped bean bag, width almost equal to height, softly rounded all over',
    negative: 'NOT a teardrop, NOT a rocket, NOT a cone, NOT tall and narrow',
    modes: 'one person sinks deeply into it as if hugged',
    verified: true,
  },
  Support: {
    shape: 'a U-SHAPED armrest cushion that wraps around a seated person lower back and sides',
    negative: 'NOT a ring, NOT a donut, NOT a neck pillow',
    modes: 'used alone as a floor backrest or paired with a bean bag sofa',
    verified: true,
  },
  Lounger: {
    shape: 'a LOW CHAIR-SHAPED bean bag with a built-in sloped backrest',
    negative: 'NOT a ball, NOT a flat cushion',
    modes: 'sit into it like a low armchair, legs stretched forward',
    verified: true,
  },
  // ↓ 아래 2종은 실측 미검증 — 생성 결과를 보고 다듬을 것
  Pyramid: {
    shape: 'a soft TRIANGULAR bean bag with a wide flat base and a tall soft crest that folds over, seen from the side it reads as a rounded triangle',
    negative: 'NOT a rigid pyramid, NOT a cone, NOT a ball, NOT a long pill',
    modes: 'lean back into the sloped face as a floor chair, or lay it down flat as a low lounger',
    verified: false,
  },
  Drop: {
    shape: 'a ROUNDED DROPLET shaped bean bag, wide and low with a soft domed top and a hollow seating well',
    negative: 'NOT a long pill, NOT a perfect sphere, NOT a wedge',
    modes: 'sit down into the hollow as a round floor armchair',
    verified: false,
  },
  Etc: {
    shape: 'a soft stretch-fabric cushion',
    negative: 'NOT rigid, NOT boxy',
    modes: 'used as a soft resting surface',
    verified: false,
  },
};

/** 제품 라인 → legacy-products.json 의 한글 제품명 앞머리 */
const LINE_KR = {
  Max: '맥스', Slim: '슬림', Midi: '미디', Mini: '미니', Drop: '드롭',
  Lounger: '라운저', Pyramid: '피라미드', Pod: '팟', Double: '더블', Support: '서포트',
};

/** 'h170 × w70 × d45 · 6.6kg' → { h:170, w:70, d:45, weight:6.6 } */
function parseDims(size) {
  if (!size) return {};
  const out = {};
  for (const [k, re] of [['h', /h\s*(\d+(?:\.\d+)?)/], ['w', /w\s*(\d+(?:\.\d+)?)/], ['d', /d\s*(\d+(?:\.\d+)?)/]]) {
    const m = size.match(re);
    if (m) out[k] = Number(m[1]);
  }
  const wt = size.match(/(\d+(?:\.\d+)?)\s*kg/);
  if (wt) out.weight = Number(wt[1]);
  return out;
}

// ── legacy-products.json 을 (라인, 컬러명) 으로 색인 ──
const legacyIndex = new Map();
for (const p of LEGACY_PRODUCTS) {
  const name = (p.name || '').trim();
  for (const [line, kr] of Object.entries(LINE_KR)) {
    if (!name.startsWith(kr)) continue;
    const c = (p.colors || [])[0] || {};
    const colorName = (c.color || name.slice(kr.length)).trim().replace(/^[_\s]+/, '');
    legacyIndex.set(`${line}|${colorName}`, { legacy: p, color: c });
    break;
  }
}

// ─────────────────────────────────────────────────────────────────
// 1) products — 제품 라인 11개 + 컬러 슬롯 57개
// ─────────────────────────────────────────────────────────────────
const products = A.thumbs.PRODUCTS.map((p, i) => {
  const colors = (p.colors || []).map((c) => {
    const hit = legacyIndex.get(`${p.product}|${c.name}`);
    const lc = hit?.color || {};
    return {
      key: c.key,
      name: c.name,
      hex: c.hex || lc.hex || '',
      isRep: !!c.rep,
      ...(lc.elementId ? { elementId: lc.elementId } : {}),
      ...(lc.sprite360 ? { sprite360: lc.sprite360 } : {}),
      ...(lc.views && Object.keys(lc.views).length ? { views: lc.views } : {}),
    };
  });
  // 같은 라인 안에 중복 컬러 키가 있으면(원본에 리빙코랄 중복) 뒤엣것이 이긴다
  const byKey = new Map();
  for (const c of colors) byKey.set(c.key, { ...(byKey.get(c.key) || {}), ...c });

  return {
    _id: p.product,
    line: p.product,
    emoji: p.emoji || '',
    spec: p.spec || '',
    dims: parseDims(p.size),
    sizeText: p.size || '',
    scalePrompt: p.scale || '',
    geometry: GEOMETRY[p.product] || GEOMETRY.Etc,
    ratio: p.ratio || '1:1',
    recommendedModels: p.models || '',
    ...(p.sameLine ? { sameShapeAs: p.sameLine } : {}),
    colors: [...byKey.values()],
    order: i,
    // Etc 는 제품 라인이 아니라 레퍼런스 이미지 슬롯(sumUp/zoola/매장 등)이라 제품 선택에서 제외.
    // 컷 28건이 line:'Etc' 로 붙어 있어 문서 자체는 지우지 않는다.
    active: p.product !== 'Etc',
  };
});

// ─────────────────────────────────────────────────────────────────
// 2) pose_refs — 실사 포즈 레퍼 52개
// ─────────────────────────────────────────────────────────────────
const POSE_SOURCES = [
  ['Max', 'PRESS_REFS'], ['Slim', 'SLIM_REFS'], ['Midi', 'MIDI_REFS'], ['Mini', 'MINI_REFS'],
  ['Lounger', 'LOUNGER_REFS'], ['Drop', 'DROP_REFS'], ['Pyramid', 'PYRAMID_REFS'],
  ['Pod', 'POD_REFS'], ['Double', 'DOUBLE_REFS'], ['Support', 'SUPPORT_REFS'],
];
const poseRefs = [];
for (const [line, key] of POSE_SOURCES) {
  for (const r of A.thumbs[key] || []) {
    poseRefs.push({
      _id: r.key,
      key: r.key,
      line,
      name: r.name,
      offUrl: r.url || '',   // 모델 제거본 = 형태·눌림
      onUrl: r.orig || '',   // 모델 포함본 = 포즈·각도·비례
      note: r.note || '',
      tag: r.tag || '실사',
      active: true,
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// 3) talents — 전속 모델 7명
//    models/page.js (아이덴티티·시트 4종) + thumbnails/page.js (의상·표정시트) 병합
// ─────────────────────────────────────────────────────────────────
const CAT_PREFIX = { 여성: 'W', 남성: 'M', 아동: 'K' };
/** MD 가 정해둔 의상 컨셉 레퍼 이미지 — 제품컷에서 모델에게 이 옷을 입힌다 */
const CLOTHES_BASE = 'https://yogibo.openhost.cafe24.com/web/img/none/clothes';

/** thumbnails 의 THUMB_MODELS 를 code 로 색인 — 아동은 이미 'K_A' 형태 */
const thumbModelIndex = new Map();
for (const cat of A.thumbs.THUMB_MODELS || []) {
  for (const m of cat.items || []) {
    const slot = m.code.startsWith('K_') ? m.code.slice(2) : m.code;
    thumbModelIndex.set(`${CAT_PREFIX[cat.cat]}_${slot}`, m);
  }
}

const talents = [];
let tOrder = 0;
for (const cat of A.models.CATEGORIES || []) {
  for (const m of cat.models || []) {
    const code = `${CAT_PREFIX[cat.cat]}_${m.code}`;
    const tm = thumbModelIndex.get(code);
    talents.push({
      _id: code,
      code,
      category: cat.cat,
      slot: m.code,
      name: m.name,
      identity: m.identity || '',
      size: m.size || '',
      // 썸네일 페이지 쪽 설명이 더 최신(헤어 업데이트 반영)이면 같이 보관
      thumbDesc: tm?.desc || '',
      rep: tm?.rep || m.ref || '',
      // ④ 제품 착석 연출 시트(pose)는 쓰지 않는다 — 착석 연출은 pose_refs(실사 레퍼)가 담당하고,
      //    모델 쪽은 얼굴·표정·체형 락만 맡는다. 역할이 겹치면 참조가 서로 싸운다.
      sheets: { face: m.sheets?.face || '', expr: m.sheets?.expr || '', body: m.sheets?.body || '' },
      // 표정 시트는 얼굴 드리프트 방지의 핵심 — 썸네일 쪽 최신 버전을 우선
      exprSheet: tm?.expr || m.sheets?.expr || '',
      // 의상 컨셉 — 코드뿐 아니라 실제 레퍼 이미지까지 (생성 시 참조로 투입 가능)
      outfits: (tm?.outfits || []).map((o) => ({
        code: o.f,
        desc: o.t,
        imageUrl: `${CLOTHES_BASE}/${o.f}.jpg`,
      })),
      status: m.status || '',
      order: tOrder++,
      active: true,
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// 4) cuts — 기존 생성 컷 151개. spec 문자열에서 레시피를 파싱한다.
// ─────────────────────────────────────────────────────────────────
const OUTFIT_RE = /\b([A-D]_[WM]_C_\d{2}|KID_[AB]_\d{2})\b/;
const EXPRESSIONS = ['은은한미소', '밝은미소', '곁눈질미소', '따뜻한미소', '자연스러운미소', '미소'];

function parseRecipe(spec, productHex) {
  const s = String(spec || '');
  const codes = new Set();

  for (const m of s.matchAll(/여성\s*([A-D])/g)) codes.add(`W_${m[1]}`);
  for (const m of s.matchAll(/남성\s*([A-D])|남([A-D])(?![a-z])/g)) codes.add(`M_${m[1] || m[2]}`);
  for (const m of s.matchAll(/아동\s*([AB])|\bK_([AB])\b/g)) codes.add(`K_${m[1] || m[2]}`);
  // 'B모델(172)' 같은 표기
  for (const m of s.matchAll(/([A-D])모델/g)) codes.add(`W_${m[1]}`);

  // 접두 없는 단독 문자(Max 계열 관행: 맨 앞 'B ·' = 여성B)
  if (codes.size === 0) {
    const head = s.match(/^\s*([A-D])\s*(?:\(|·|$)/);
    if (head) codes.add(`W_${head[1]}`);
  }

  const outfit = s.match(OUTFIT_RE)?.[1];

  // 최후 수단 — 의상 코드가 곧 모델 식별자다. 'B_W_C_02' = 여성B, 'KID_A_01' = 아동A.
  if (codes.size === 0 && outfit) {
    const om = outfit.match(/^([A-D])_([WM])_C_/);
    if (om) codes.add(`${om[2]}_${om[1]}`);
    const km = outfit.match(/^KID_([AB])_/);
    if (km) codes.add(`K_${km[1]}`);
  }

  // 포즈(조인 가능)와 생성 방식(포토에딧/jp레퍼)은 다른 축이다.
  // 섞어 넣으면 pose_refs 조인이 깨진다 (전수조사 비평에서 33건 실측).
  let pose;
  let method;
  const pn = s.match(/포즈\s*(\d+)/) || s.match(/\bp(\d+)\b/);
  if (pn) pose = `p${pn[1]}`;
  else if (/포즈레퍼|poseref/i.test(s)) pose = 'poseref';
  if (/\bjp(\d+)\b/i.test(s)) method = `jp${s.match(/\bjp(\d+)\b/i)[1]}`;
  else if (/레퍼\s*원본|포토\s*에딧/.test(s)) method = 'photoedit';

  const expression = EXPRESSIONS.find((e) => s.replace(/\s/g, '').includes(e));

  // 배경 hex — spec 관행상 제품색이 먼저, 배경(#f2f2f4)이 마지막에 온다.
  // 첫 매치를 잡으면 제품색이 배경으로 오염된다 (85건 실측). 마지막 hex 를 잡되
  // 그것이 제품색과 같으면(배경 언급 없는 spec) 배경 없음으로 둔다.
  const allHex = [...s.matchAll(/#([0-9a-fA-F]{6})/g)].map((m) => m[0]);
  const lastHex = allHex.length ? allHex[allHex.length - 1] : undefined;
  const background =
    lastHex && lastHex.toLowerCase() !== String(productHex || '').toLowerCase() ? lastHex : undefined;

  return {
    talentCodes: [...codes],
    ...(pose ? { pose } : {}),
    ...(method ? { method } : {}),
    ...(expression ? { expression } : {}),
    ...(outfit ? { outfit } : {}),
    ...(background ? { background } : {}),
  };
}

/** cuts.line → pose_refs.key 접두사. 조인에 반드시 필요한데 어디에도 없던 표. */
const POSE_PREFIX = {
  Max: 'max', Slim: 'slim', Midi: 'midi', Mini: 'mini', Drop: 'dr',
  Lounger: 'lg', Pyramid: 'py', Pod: 'pd', Double: 'db', Support: 'sp',
};

const now = new Date();
const cuts = [];
/*
 * 같은 URL 이 두 라인에 등록된 케이스가 있다 — Max 섹션의 리빙코랄 블록에 Support 컷
 * (cand_support_*_jp2) 이 섞여 들어갔다. 원본 thumbnails/page.js 의 리빙코랄 중복 선언 탓.
 * 파일명이 제품 라인을 말해주므로 이름이 맞는 라인에만 남긴다.
 */
const seenUrls = new Map();
function ownsUrl(line, url) {
  const file = url.split('/').pop() || '';
  const m = file.match(/^cand_([a-z]+)_/);
  const owner = m ? m[1] : null;
  const LINE_OF = { support: 'Support', max: 'Max', slim: 'Slim', midi: 'Midi', mini: 'Mini',
    drop: 'Drop', lounger: 'Lounger', pyramid: 'Pyramid', pod: 'Pod', double: 'Double' };
  const expected = owner ? LINE_OF[owner] : null;
  // 파일명이 라인을 특정하면 그 라인만 소유. 아니면 먼저 온 라인이 소유.
  if (expected) return expected === line;
  if (!seenUrls.has(url)) { seenUrls.set(url, line); return true; }
  return seenUrls.get(url) === line;
}
for (const p of A.thumbs.PRODUCTS) {
  for (const c of p.colors || []) {
    const entries = [];
    if (c.url) entries.push({ url: c.url, spec: c.spec || '' });
    for (const cu of c.cuts || []) entries.push({ url: cu.url, spec: cu.spec || '' });
    for (const e of entries) {
      if (!ownsUrl(p.product, e.url)) continue; // 다른 라인 소유 컷 — 건너뛴다
      const recipe = parseRecipe(e.spec, c.hex);
      // 조인 가능한 정규화 포즈 키 (예: Lounger + p5 -> lg_p5)
      if (recipe.pose && /^p\d+$/.test(recipe.pose) && POSE_PREFIX[p.product]) {
        recipe.poseKey = `${POSE_PREFIX[p.product]}_${recipe.pose}`;
      }
      cuts.push({
        line: p.product,
        colorKey: c.key,
        colorName: c.name,
        hex: c.hex || '',
        url: e.url,
        spec: e.spec,
        recipe,
        source: 'legacy',
        hidden: false,
        note: '',
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// 4.5) product_items — products.json 의 제품 문서 70건 원본.
//
// products(11 라인)는 "프롬프트 조립용 기하/치수" 단위이고,
// product_items 는 "실제 판매 제품 카탈로그" 단위다. 둘은 다르다:
//   - 11 라인에 안 잡히는 제품이 많다 (메이트 인형·스퀴지보·럭스·롤메이트·문필로우 등)
//   - 연출컷(usage)·notes·usedIn 은 제품 문서에만 있다
// 라인에 매칭되는 것은 line/colorKey 를 채워 서로 연결한다.
// ─────────────────────────────────────────────────────────────────

/** 라인 컬러 슬롯을 (라인, 컬러명) 으로 역색인 — 제품 문서에서 라인을 찾기 위해 */
const slotIndex = new Map();
for (const p of products) {
  for (const c of p.colors) slotIndex.set(`${p.line}|${c.name}`, c.key);
}

const productItems = LEGACY_PRODUCTS.map((p) => {
  const name = (p.name || '').trim();
  let line = null;
  let colorKey = null;
  for (const [ln, kr] of Object.entries(LINE_KR)) {
    if (!name.startsWith(kr)) continue;
    const cname = ((p.colors || [])[0]?.color || name.slice(kr.length)).trim().replace(/^[_\s]+/, '');
    if (slotIndex.has(`${ln}|${cname}`)) { line = ln; colorKey = slotIndex.get(`${ln}|${cname}`); }
    else line = ln; // 라인은 맞지만 썸네일 슬롯에 없는 색
    break;
  }
  return {
    _id: p.id,
    itemId: p.id,
    name,
    category: p.category || '',
    /** 매칭되는 제품 라인 (없으면 null — 11 라인 밖의 제품) */
    line,
    colorKey,
    colors: p.colors || [],
    spec: p.spec || {},
    scalePrompt: p.scalePrompt || '',
    notes: p.notes || '',
    usedIn: p.usedIn || [],
    usage: p.usage || {},
    active: true,
  };
});

// ─────────────────────────────────────────────────────────────────
// 4.6) usage_shots — 연출컷 116장을 개별 문서로.
//
// productPrompt.js 는 생성 시 "카메라 각도에 맞는 뷰 + 자세용 연출컷"을 함께 붙이라고 한다.
// 개별 문서로 쪼개야 생성 화면에서 픽커로 고를 수 있다.
// ─────────────────────────────────────────────────────────────────
const USAGE_META = {
  sitting_recliner: { kr: '리클라이너 착석', en: 'sitting in recliner mode', usableAsRef: true },
  sitting_on_top: { kr: '눕힌 위 착석', en: 'sitting on it laid flat', usableAsRef: true },
  modes4: { kr: '4가지 사용 모드', en: 'the four usage modes (chair / sofa / recliner / bed)', usableAsRef: true },
  sleeping: { kr: '누워 수면', en: 'lying down asleep on it', usableAsRef: true },
  on_max: { kr: '맥스 위에', en: 'placed on top of a Yogibo Max', usableAsRef: true },
  sitting: { kr: '착석', en: 'a person sitting on it', usableAsRef: true },
  // ↓ 아래 둘은 참조로 쓰면 안 된다. cover_gif 는 GIF(물성 설명), howto 는 텍스트가 박힌 가이드 시트다.
  cover_gif: { kr: '커버 신축 (GIF)', en: 'cover stretch physics', usableAsRef: false },
  howto: { kr: '사용 가이드 시트', en: 'usage guide sheet', usableAsRef: false },
};

const usageShots = [];
for (const item of productItems) {
  for (const [kind, url] of Object.entries(item.usage || {})) {
    if (!url) continue;
    const meta = USAGE_META[kind] || { kr: kind, en: kind, usableAsRef: true };
    usageShots.push({
      _id: `${item.itemId}:${kind}`,
      itemId: item.itemId,
      itemName: item.name,
      line: item.line,
      colorKey: item.colorKey,
      kind,
      kindKr: meta.kr,
      /** 프롬프트에 이 컷의 역할을 설명할 때 쓰는 영문 */
      kindEn: meta.en,
      /** 생성 참조로 투입해도 되는 컷인지 (텍스트 박힌 가이드·GIF 는 금지) */
      usableAsRef: meta.usableAsRef,
      url,
      active: true,
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// 5) house_rules — 구 CAUTIONS 10개. 한글 원문 + 프롬프트용 영문.
// ─────────────────────────────────────────────────────────────────
const RULE_EN = [
  'The model must wear a natural, gentle smile - never a blank expression.',
  'Always attach the model expression sheet (8 panels) together with the identity reference, and name which panel to use. A face turnaround plus the word "smile" alone lets the face drift.',
  'Do not describe the backrest crest shape in words - copy it from the base frame exactly. Describing it as domed or pointed breaks it.',
  'When the angle and seating composition matter, use the ORIGINAL pose frame (model included) as the base to lock the angle, then replace only face, outfit, colour and background.',
  'The real Max has NO zipper and NO visible seams - the cover fabric is smooth and continuous.',
  'Respect the real product proportions against the model body size. It must not read as short and wide.',
  'Use the outfit mapped to that specific model - never another model outfit.',
  'The studio background is flat light grey #f2f2f4, not pure white.',
  'Deliver at 2048px without downscaling.',
  'Confirm the full spec (colour + pose + model + outfit) and the credit cost before generating.',
];
const houseRules = (A.thumbs.CAUTIONS || []).map((kr, i) => ({
  _id: `rule_${String(i + 1).padStart(2, '0')}`,
  order: i,
  kr,
  en: RULE_EN[i] || '',
  critical: kr.startsWith('★'),
  enabled: true,
}));

// ─────────────────────────────────────────────────────────────────
// 6) color_chips
// ─────────────────────────────────────────────────────────────────
const colorChips = CHIPS.map((c) => ({ _id: c.id, ...c }));

// ─────────────────────────────────────────────────────────────────
// 적재
// ─────────────────────────────────────────────────────────────────
const SETS = [
  ['products', products],
  ['product_items', productItems],
  ['usage_shots', usageShots],
  ['pose_refs', poseRefs],
  ['talents', talents],
  ['cuts', cuts],
  ['house_rules', houseRules],
  ['color_chips', colorChips],
];

console.log('── 이관 대상 ──');
for (const [name, docs] of SETS) console.log(`  ${name.padEnd(12)} ${String(docs.length).padStart(4)}건`);

// 파싱 품질 리포트 — 조용히 비어버리면 나중에 원인을 못 찾는다
const noTalent = cuts.filter((c) => c.recipe.talentCodes.length === 0);
const noPose = cuts.filter((c) => !c.recipe.pose);
console.log('\n── cuts 레시피 파싱 ──');
console.log(`  모델 코드 추출  ${cuts.length - noTalent.length}/${cuts.length}`);
console.log(`  포즈 추출      ${cuts.length - noPose.length}/${cuts.length}`);
console.log(`  의상 추출      ${cuts.filter((c) => c.recipe.outfit).length}/${cuts.length}`);
console.log(`  표정 추출      ${cuts.filter((c) => c.recipe.expression).length}/${cuts.length}`);
if (noTalent.length) {
  console.log('\n  모델 코드 못 뽑은 컷 (상위 8):');
  for (const c of noTalent.slice(0, 8)) console.log(`    [${c.line}/${c.colorKey}] ${c.spec.slice(0, 90)}`);
}

const unverified = products.filter((p) => !p.geometry.verified).map((p) => p.line);
console.log(`\n⚠️ 기하 서술 미검증 라인: ${unverified.join(', ')} — 생성 결과 보고 다듬을 것`);

// 제품 카탈로그 / 연출컷 리포트
const orphans = productItems.filter((p) => !p.line);
console.log('\n── 제품 카탈로그 ──');
console.log(`  라인 매칭    ${productItems.length - orphans.length}/${productItems.length}`);
console.log(`  컬러슬롯까지 ${productItems.filter((p) => p.colorKey).length}건`);
console.log(`  라인 밖 제품 ${orphans.length}건: ${orphans.slice(0, 12).map((p) => p.name).join(' · ')}${orphans.length > 12 ? ' …' : ''}`);

const refShots = usageShots.filter((s) => s.usableAsRef);
console.log('\n── 연출컷 ──');
console.log(`  총 ${usageShots.length}장 · 생성 참조 가능 ${refShots.length}장 (가이드시트·GIF 제외)`);
const byKind = {};
for (const s of usageShots) byKind[s.kindKr] = (byKind[s.kindKr] || 0) + 1;
console.log(`  종류별: ${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
const hosts = {};
for (const s of usageShots) { try { const h = new URL(s.url).host; hosts[h] = (hosts[h] || 0) + 1; } catch { /* 무시 */ } }
console.log(`  호스트: ${Object.entries(hosts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);

if (DRY) { console.log('\n(--dry: DB 미기록)'); process.exit(0); }

const client = new MongoClient(env.MONGODB_URI, { maxPoolSize: 5 });
await client.connect();
const db = client.db(env.MONGODB_DB || 'imgcreate');

for (const [name, docs] of SETS) {
  const col = db.collection(name);
  if (name === 'cuts') {
    // cuts 는 _id 가 없다(같은 URL 이 여러 번 등장 가능). legacy 분만 갈아끼운다.
    await col.deleteMany({ source: 'legacy' });
    if (docs.length) await col.insertMany(docs);
  } else {
    const ops = docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } }));
    if (ops.length) await col.bulkWrite(ops);
  }
  console.log(`  ✅ ${name} ${docs.length}건`);
}

// 인덱스
await db.collection('cuts').createIndex({ line: 1, colorKey: 1, hidden: 1 });
await db.collection('cuts').createIndex({ source: 1, createdAt: -1 });
await db.collection('cuts').createIndex({ 'recipe.talentCodes': 1 });
await db.collection('pose_refs').createIndex({ line: 1, active: 1 });
await db.collection('talents').createIndex({ category: 1, order: 1 });
await db.collection('products').createIndex({ order: 1, active: 1 });
console.log('  ✅ 인덱스');

await client.close();
console.log('\n이관 완료.');
console.log('
⚠️ products/talents 를 통째로 교체했으므로 영문 표기(nameEn/identityEn/descEn)와');
console.log('   house_rules 분류가 초기화됩니다. 이어서 반드시 실행하세요:');
console.log('   node scripts/seed-english.mjs  &&  node scripts/make-outfit-crops.mjs');
console.log('   node scripts/make-expression-crops.mjs');
console.log('   node scripts/backfill-shape-views.mjs   # 6개 라인의 유일한 사진 형태 참조');
