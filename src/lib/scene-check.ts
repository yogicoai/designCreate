import 'server-only';
import sharp from 'sharp';
import type { VisionUsage } from './logo-guard';
import { visionModel } from './logo-guard';

/**
 * 생성 결과 자동 검사 — "왜 실패했는지" 를 컷마다 숫자로 남긴다 (사용자 요청 2026-09-23).
 *
 * 어제 10장을 사람이 일일이 열어 본 결과 실패 원인이 세 갈래였다:
 *   ① 제품 불일치 — ③ 에서 맥스+서포트를 골랐는데 결과는 원본 사진의 무늬 의자였다 (로고 검사의 note 가 우연히 "맥스가 없다" 고 적었다).
 *   ② 크기 — 사용자 지적: "모델을 넣으면 배경 가구 대비 제품·사람이 과도하게 크게 나온다".
 *   ③ 조명 — 방은 어두운데 사람·제품만 밝고 고르게 붙어 있다(합성 티).
 * 셋을 한 번의 비전 호출(가벼운 텍스트 응답)로 묶어 본다 — 고치지는 않고 기록·표시만 한다.
 * 얼굴(face-guard)·태그(logo-guard)와 같은 원칙: 다시 생성할지는 사람이 정한다.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface SceneCheck {
  checked: boolean;
  model: string;
  /** 고른 제품이 실제로 그 제품으로 보이는가 */
  product: { ok: boolean; note: string; missing: string[] };
  /**
   * 방 가구·사람 몸을 자로 잰 크기가 실물과 맞는가 — 비전은 재기만 하고 판정은 judgeScale 이 한다.
   * fix = 다시 뽑을 때 프롬프트에 붙일 교정 문장(영문). 어긋났을 때만 있다.
   */
  scale: { ok: boolean; note: string; fix?: string };
  /** 사람·제품이 그 방 조명으로 찍힌 것처럼 보이는가 (0~100, 낮을수록 합성 티) */
  light: { score: number; note: string };
  /**
   * 고른 색으로 보이는가 — 방 조명으로 따뜻해지거나 어두워진 것은 정상, 색 계열이 바뀐 것만 false (2026-10-02).
   * 씬 컷의 ΔE(목표 hex 와의 거리)는 조명 때문에 늘 크게 나와 쓸모가 없어서 이 판정이 대신한다. 색을 안 골랐으면 없다.
   */
  colour?: { ok: boolean; note: string };
  usage?: VisionUsage;
  /** 검사하려 했는데 비전 호출이 실패했다 — 화면이 "검사 건너뜀" 을 알릴 근거 */
  failed?: boolean;
}

export interface SceneCheckInput {
  /** 이 컷에 있어야 하는 제품 — 이름 + 형태 서술 (프롬프트에 넣은 것과 같은 문장) + 실측 치수(cm) */
  products: { line: string; shape: string; dims?: { w?: number; d?: number; h?: number } }[];
  /** 등장 인물의 키 설명 (예: 'PERSON 1 165cm', 'the model 175cm') */
  people: string[];
  /** 등장 인물의 실제 키(cm), 왼쪽부터 — 크기 판정에 쓴다. 모르면 비운다 */
  heights?: number[];
  /** 배경 사진을 따로 넣었는가 — 조명 판정 문구를 그에 맞춘다 */
  hasBackground: boolean;
  /** 제품마다 고른 색 (영문 이름 + hex) — 있으면 색 계열 판정을 같이 한다 */
  colours?: { line: string; name: string; hex: string }[];
}

interface ScaleRaw { ruler?: unknown; people?: unknown; bags?: unknown }

/*
 * 크기는 "판정" 을 시키지 않고 "재기" 만 시킨다 — 판정은 judgeScale 이 숫자로 한다 (2026-10-02).
 * 예전엔 실물 치수(맥스 170cm)와 모델 키를 알려 주고 맞는지 물었는데, 비전이 그 숫자를 그대로 받아 적었다:
 * 맥스가 실물보다 폭 1.4~1.6배로 부풀려진 컷을 전부 "170cm, perfectly proportioned" 로 통과시켰다(사용자 지적, 여성 C 6컷).
 * 제품 이름·설명과 같은 호출에 넣어도 숫자가 실물 쪽으로 끌려간다(100·106cm 로 재던 폭이 93·85cm 가 됐다).
 * 그래서 이 호출은 제품이 무엇인지도, 사람 키도 모르는 채로 사람 몸을 자로 재기만 한다 — 정상 컷은 폭 1.19·1.27배, 부풀려진 컷은 1.36~1.57배로 갈렸다.
 */
const MEASURE_PROMPT =
  'You are measuring a finished interior photograph. MEASURE and report numbers only — do not decide whether anything is right or wrong, and do not assume any object has a standard catalogue size.\n' +
  'a) RULER: pick ONE element whose real size you can trust and name it: a door opening is about 200cm tall, a residential ceiling 230-260cm, ' +
  'a desk or dining table top 72-76cm high, a kitchen counter 85-95cm, a sideboard or console 70-80cm high, a dining chair seat 45cm, a sofa seat 40-45cm, ' +
  'a coffee table 35-45cm, a vinyl LP record 31cm, a paperback book 18-21cm tall, a skirting board 8-12cm, a floorboard 12-20cm wide.\n' +
  'b) PEOPLE: for each person, left to right, estimate how tall they would be standing up straight, in cm, measured against that ruler (not against the bean bag).\n' +
  'c) BEAN BAGS: for each bean bag, left to right, measure it against the body of the person using it, as plain ratios:\n' +
  "   length_ratio = the bean bag's longest dimension (end to end along its length, following its bend if it is bent) divided by that person's full body length from the top of the head to the heel;\n" +
  "   width_ratio = the bean bag's width (across it, perpendicular to its length, at its widest) divided by that person's shoulder width;\n" +
  "   height_ratio = how high its tallest part rises off the floor divided by that person's lower leg (knee to heel).\n" +
  '   Also give length_cm, width_cm, height_cm measured against the ruler from (a). If nobody is using it, give only the cm values and set the ratios to null.\n' +
  "Look carefully at how far the bean bag extends beyond the person's head, feet and both sides of the body before answering.\n" +
  'Return JSON only: {"ruler":"...","people":[{"cm":0}],"bags":[{"name":"...","length_ratio":0,"width_ratio":0,"height_ratio":0,"length_cm":0,"width_cm":0,"height_cm":0}],"note":"one short sentence"}';

/** 사람·빈백의 크기를 잰다 — 비전 호출 1회. 실패하면 null (던지면 호출한 쪽이 null 로 받는다) */
async function measureScale(small: Buffer, key: string, model: string): Promise<ScaleRaw | null> {
  const res = await fetch(`${API_BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ inlineData: { mimeType: 'image/jpeg', data: small.toString('base64') } }, { text: MEASURE_PROMPT }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const raw = (json.candidates?.[0]?.content?.parts ?? []).map((x) => x.text ?? '').join('');
  const j = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as ScaleRaw;
  return Array.isArray(j?.people) || Array.isArray(j?.bags) ? j : null;
}

/*
 * 크기 판정 기준 — 실물 대비 이만큼 벗어나면 어긋남.
 * 폭 1.33배: 2026-10-02 여성 C·맥스 6컷 실측에서 정상 컷은 1.19·1.27배, 부풀려진 컷은 1.36~1.57배였다(같은 컷을 두 번 재도 같은 값).
 * 사람이 누우면 빈백이 눌려 조금 넓어지는 건 정상이라 그 아래는 통과시킨다.
 */
const WIDE_LIMIT = 1.33;
const LONG_LIMIT = 1.3;
const SMALL_LIMIT = 0.65;
const PERSON_LIMIT = 0.22;
/** 어깨 폭 ≈ 키의 25% (어른·아이 공통으로 쓸 만하다) */
const SHOULDER = 0.25;

/** 비전이 잰 숫자를 실물 치수·실제 키와 대조한다 */
function judgeScale(raw: ScaleRaw, input: SceneCheckInput): SceneCheck['scale'] {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const people = (Array.isArray(raw.people) ? raw.people : []).map((x) => num((x as { cm?: unknown })?.cm));
  const heights = (input.heights ?? []).filter((h) => h > 0);
  const problems: string[] = [];
  const fixes: string[] = [];
  const facts: string[] = [];

  // 사람 — 가구를 자로 잰 키가 실제 키와 맞는가
  people.forEach((cm, i) => {
    const real = heights[i];
    if (!cm || !real) return;
    const who = people.length > 1 ? `사람 ${i + 1}` : '사람';
    facts.push(`${who} 약 ${Math.round(cm)}cm`);
    if (Math.abs(cm / real - 1) > PERSON_LIMIT) {
      problems.push(`${who}이 방 가구 대비 ${cm > real ? '크게' : '작게'} 그려짐 — 약 ${Math.round(cm)}cm로 읽힘(실제 ${real}cm)`);
      fixes.push(
        `${people.length > 1 ? `Person ${i + 1} (from the left)` : 'The person'} read as about ${Math.round(cm)}cm tall against the room's furniture ` +
        `but is really ${real}cm — draw them ${cm > real ? 'smaller' : 'larger'} relative to the furniture and architecture.`,
      );
    }
  });

  // 빈백 — 사람 몸을 자로 잰 길이·폭이 실물과 맞는가. 키가 고르면 그 키로, 어른·아이가 섞이면 가구 기준 cm 로 본다
  const spread = heights.length ? Math.max(...heights) / Math.min(...heights) : 1;
  const H = heights.length && spread < 1.15 ? heights.reduce((a, b) => a + b, 0) / heights.length : null;
  const withDims = input.products
    .map((pr) => ({ line: pr.line, sizes: [pr.dims?.w, pr.dims?.d, pr.dims?.h].filter((v): v is number => typeof v === 'number' && v > 0).sort((x, y) => y - x) }))
    .filter((pr) => pr.sizes.length >= 2 && pr.sizes[0] >= 50);
  const bags = (Array.isArray(raw.bags) ? raw.bags : []) as Record<string, unknown>[];
  bags.forEach((bag, i) => {
    const name = String(bag.name ?? '').toLowerCase();
    const prod = withDims.length === 1
      ? withDims[0]
      : withDims.find((pr) => name.includes(pr.line.toLowerCase())) ?? (bags.length === withDims.length ? withDims[i] : undefined);
    if (!prod) return;
    const [L, W] = prod.sizes;
    const lr = num(bag.length_ratio), wr = num(bag.width_ratio);
    const len = lr && H ? lr * H : num(bag.length_cm);
    const wid = wr && H ? wr * H * SHOULDER : num(bag.width_cm);
    if (len) facts.push(`${prod.line} 길이 약 ${Math.round(len)}cm`);
    if (wid) facts.push(`폭 약 ${Math.round(wid)}cm`);
    const tooLong = !!len && len / L > LONG_LIMIT;
    const tooWide = !!wid && wid / W > WIDE_LIMIT;
    // 작다는 판정은 두 번 잰 것 중 큰 쪽으로 — 둘 다 작아야 작은 것이다
    const lrMax = num(bag.length_ratio_max);
    const lenMax = (lrMax && H ? lrMax * H : num(bag.length_cm_max)) ?? len;
    const tooSmall = !!lenMax && lenMax / L < SMALL_LIMIT;
    if (tooLong || tooWide) {
      const parts = [
        tooWide ? `폭 약 ${Math.round(wid!)}cm(실물 ${W}cm의 ${(wid! / W).toFixed(1)}배)` : '',
        tooLong ? `길이 약 ${Math.round(len!)}cm(실물 ${L}cm의 ${(len! / L).toFixed(1)}배)` : '',
      ].filter(Boolean);
      problems.push(`${prod.line}가 실물보다 크게 그려짐 — ${parts.join(', ')}`);
      fixes.push(
        `The Yogibo ${prod.line} was drawn too big — about ${wid ? `${Math.round(wid)}cm wide` : ''}${wid && len ? ' and ' : ''}${len ? `${Math.round(len)}cm long` : ''}. ` +
        `Its real size is ${L}cm long and only ${W}cm wide: against the person using it, it is ${H ? `${(L / H).toFixed(2)}x their body length` : 'about as long as an adult is tall'} ` +
        `and about ${H ? (W / (H * SHOULDER)).toFixed(1) : '1.6'} shoulder-widths across. Draw it slimmer and smaller — it must not spread far beyond the person's body on either side.`,
      );
    } else if (tooSmall) {
      problems.push(`${prod.line}가 실물보다 작게 그려짐 — 길이 약 ${Math.round(len!)}cm(실물 ${L}cm)`);
      fixes.push(`The Yogibo ${prod.line} was drawn too small — about ${Math.round(len!)}cm long. Its real length is ${L}cm; draw it larger against the person.`);
    }
  });

  const ruler = String(raw.ruler ?? '').slice(0, 60);
  const measured = facts.length ? `${facts.join(' · ')}${ruler ? ` (자: ${ruler})` : ''}` : '크기를 재지 못했습니다';
  return problems.length
    ? { ok: false, note: `${problems.join(' / ')}${ruler ? ` (자: ${ruler})` : ''}`.slice(0, 300), fix: fixes.join(' ') }
    : { ok: true, note: measured.slice(0, 300) };
}

/**
 * 두 번 잰 값을 합친다 — 크다는 판정에는 작은 쪽을, 작다는 판정에는 큰 쪽을 쓴다(둘 다 넘어야 어긋남).
 * 왜: 한 번 잰 폭은 같은 컷에서도 83cm ↔ 95cm 로 흔들렸다(옆에서 본 컷은 폭이 잘 안 보인다). 어긋남은 자동 재생성(한 장 값)의 근거라
 * 헛 경고가 곧 헛돈이다. 뒤집은 그림은 왼쪽·오른쪽 순서가 반대라 목록을 뒤집어 맞춘다.
 */
function combineMeasures(a: ScaleRaw | null, bFlopped: ScaleRaw | null): ScaleRaw | null {
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const b: ScaleRaw | null = bFlopped ? { ...bFlopped, people: [...arr(bFlopped.people)].reverse(), bags: [...arr(bFlopped.bags)].reverse() } : null;
  if (!a || !b) return a ?? b;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const pick = (x: unknown, y: unknown, f: (p: number, q: number) => number) => { const p2 = n(x), q2 = n(y); return p2 && q2 ? f(p2, q2) : p2 ?? q2; };
  const pa = arr(a.people), pb = arr(b.people), ba = arr(a.bags), bb = arr(b.bags);
  return {
    ruler: a.ruler,
    people: pa.length === pb.length ? pa.map((x, i) => ({ cm: pick(x.cm, pb[i].cm, (p2, q2) => (p2 + q2) / 2) })) : pa,
    bags: ba.length === bb.length
      ? ba.map((x, i) => ({
          ...x,
          length_ratio: pick(x.length_ratio, bb[i].length_ratio, Math.min), width_ratio: pick(x.width_ratio, bb[i].width_ratio, Math.min),
          length_cm: pick(x.length_cm, bb[i].length_cm, Math.min), width_cm: pick(x.width_cm, bb[i].width_cm, Math.min),
          length_ratio_max: pick(x.length_ratio, bb[i].length_ratio, Math.max), length_cm_max: pick(x.length_cm, bb[i].length_cm, Math.max),
        }))
      : ba,
  };
}

const EMPTY = (model: string): SceneCheck => ({
  checked: false, model,
  product: { ok: true, note: '', missing: [] },
  scale: { ok: true, note: '' },
  light: { score: 0, note: '' },
});

export async function checkScene(buf: Buffer, input: SceneCheckInput): Promise<SceneCheck> {
  const key = process.env.GEMINI_API_KEY;
  const model = visionModel();
  if (!key) return { ...EMPTY(model), failed: true };
  try {
    const small = await sharp(buf).rotate().resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    const wanted = input.products.length
      ? input.products.map((p) => `- Yogibo ${p.line}: ${p.shape}`).join('\n')
      : '(no specific product list — judge only whether the bean bags look like real, undistorted furniture)';
    const colours = input.colours ?? [];
    const text =
      'You are checking a finished commercial interior photo of Yogibo bean bags. Judge the following, strictly and independently.\n\n' +
      `1) PRODUCTS — the photo should show these products:\n${wanted}\n` +
      'For each one, decide whether a product matching that description is actually in the photo. List in "missing" the names that are absent or drawn as a clearly different piece of furniture ' +
      '(different silhouette, a rigid armchair/sofa instead of a soft bean bag, or a pattern/fabric that is not that product). product.ok is false when "missing" is not empty.\n\n' +
      `2) LIGHT — does every person and product look photographed in THIS room${input.hasBackground ? ' (the room itself came from a separate background photo)' : ''}? ` +
      'Judge the light ON THE SUBJECTS, not whether the colours look pleasant together. Look at each product and person on their own and ask: ' +
      'which side is lit, how hard are the shadows, how deep are they, does the room\'s own light colour sit on them, do they cast a shadow onto the floor where they touch it?\n' +
      'Use this scale strictly — most AI composites belong in 60-85, so do not give 90+ out of politeness:\n' +
      '  100-90 = you cannot tell it was assembled: same light direction, same shadow hardness, contact shadows present, the room\'s colour cast on the subject.\n' +
      '  89-75 = small tells: contact shadow weaker than the room\'s other objects, subject slightly cleaner or brighter than its surroundings.\n' +
      '  74-60 = clear tells: the subject is evenly, softly lit (studio-like) while the room has directional or coloured light; the subject\'s own shadows do not follow the room\'s light; fabric looks flat and untextured by the room\'s light.\n' +
      '  59-0 = light comes from the wrong side entirely, or the subject sits in a dim room while being brightly lit; it reads as pasted on.\n' +
      'In the note name the strongest cue in one short sentence.\n\n' +
      (colours.length
        ? `3) COLOUR — each product was ordered in this fabric colour:\n${colours.map((c) => `- Yogibo ${c.line}: ${c.name} (${c.hex})`).join('\n')}\n` +
          "Allow for the room's light: under a warm lamp the fabric looks warmer, in a dim room darker, in shade less saturated — all of that is CORRECT and is not a fault. " +
          'colour.ok is false ONLY when a product reads as a different colour FAMILY from the one ordered — navy that has become purple, black or royal blue; ' +
          'olive green that has become khaki-brown, teal or lime; coral that has become pink or pure red; light grey that has become beige or white; and so on. ' +
          'In the note say which product and what colour it actually reads as.\n\n'
        : '') +
      `Return JSON only: {"product":{"ok":true,"missing":[],"note":"..."},"light":{"score":0,"note":"..."}${colours.length ? ',"colour":{"ok":true,"note":"..."}' : ''}}`;
    // 크기는 따로 잰다 — 같은 호출에 넣으면 위의 제품 설명에 끌려가 숫자가 무뎌진다 (아래 MEASURE_PROMPT 설명)
    // 두 번 잰다 — 원본과 좌우로 뒤집은 그림. 같은 그림을 두 번 물으면 같은 답이 나와서 뒤집어 묻는다 (combineMeasures 설명)
    const flopped = await sharp(small).flop().jpeg({ quality: 85 }).toBuffer();
    const measuring = Promise.all([
      measureScale(small, key, model).catch(() => null),
      measureScale(flopped, key, model).catch(() => null),
    ]);
    const res = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ inlineData: { mimeType: 'image/jpeg', data: small.toString('base64') } }, { text }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`검사 호출 실패 ${res.status}`);
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
    };
    const raw = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    const j = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as {
      product?: { ok?: unknown; missing?: unknown; note?: unknown };
      light?: { score?: unknown; note?: unknown };
      colour?: { ok?: unknown; note?: unknown };
    };
    // 응답 모양이 다르면 "이상 없음" 이 아니라 "검사 실패" 다 — 빈 응답을 합격으로 받으면 경고가 영영 안 뜬다
    if (!j?.product || !j?.light) throw new Error(`응답 모양이 다릅니다: ${raw.slice(0, 120)}`);
    const missing = Array.isArray(j.product.missing) ? j.product.missing.map((x) => String(x).slice(0, 40)).slice(0, 6) : [];
    const um = json.usageMetadata;
    const [m1, m2] = await measuring;
    const measured = combineMeasures(m1, m2);
    return {
      checked: true, model,
      product: { ok: j.product.ok !== false && !missing.length, missing, note: String(j.product.note ?? '').slice(0, 200) },
      // 재지 못했으면 합격도 불합격도 아니다 — 통과로 두되 메모에 남긴다
      scale: measured ? judgeScale(measured, input) : { ok: true, note: '크기를 재지 못했습니다' },
      light: { score: Math.max(0, Math.min(100, Math.round(Number(j.light.score) || 0))), note: String(j.light.note ?? '').slice(0, 200) },
      // 색을 물었는데 답이 없으면 판정하지 않은 것으로 둔다 (없는 답을 합격으로 받지 않는다)
      ...(colours.length && j.colour ? { colour: { ok: j.colour.ok !== false, note: String(j.colour.note ?? '').slice(0, 200) } } : {}),
      ...(um ? {
        usage: {
          promptTokens: um.promptTokenCount ?? 0, outputTokens: um.candidatesTokenCount ?? 0,
          thoughtTokens: um.thoughtsTokenCount ?? 0, totalTokens: um.totalTokenCount ?? 0,
        },
      } : {}),
    };
  } catch (e) {
    // 검사 실패로 생성물을 버리지 않는다 — failed 로 남겨 화면이 "검사 건너뜀" 을 알린다
    console.warn('[scene-check] 결과 검사 실패:', (e as Error).message);
    return { ...EMPTY(model), failed: true };
  }
}
