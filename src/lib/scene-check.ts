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
  /** 방 가구를 자로 봤을 때 제품·사람 크기가 맞는가 */
  scale: { ok: boolean; note: string };
  /** 사람·제품이 그 방 조명으로 찍힌 것처럼 보이는가 (0~100, 낮을수록 합성 티) */
  light: { score: number; note: string };
  usage?: VisionUsage;
}

export interface SceneCheckInput {
  /** 이 컷에 있어야 하는 제품 — 이름 + 형태 서술 (프롬프트에 넣은 것과 같은 문장) */
  products: { line: string; shape: string }[];
  /** 등장 인물의 키 설명 (예: 'PERSON 1 165cm', 'the model 175cm') */
  people: string[];
  /** 배경 사진을 따로 넣었는가 — 조명 판정 문구를 그에 맞춘다 */
  hasBackground: boolean;
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
  if (!key) return EMPTY(model);
  try {
    const small = await sharp(buf).rotate().resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    const wanted = input.products.length
      ? input.products.map((p) => `- Yogibo ${p.line}: ${p.shape}`).join('\n')
      : '(no specific product list — judge only whether the bean bags look like real, undistorted furniture)';
    const people = input.people.length ? input.people.join('; ') : '(no people expected)';
    const text =
      'You are checking a finished commercial interior photo of Yogibo bean bags. Judge three things, strictly and independently.\n\n' +
      `1) PRODUCTS — the photo should show these products:\n${wanted}\n` +
      'For each one, decide whether a product matching that description is actually in the photo. List in "missing" the names that are absent or drawn as a clearly different piece of furniture ' +
      '(different silhouette, a rigid armchair/sofa instead of a soft bean bag, or a pattern/fabric that is not that product). product.ok is false when "missing" is not empty.\n\n' +
      /*
       * 크기 검사는 원래 "명백히 크거나 작으면" 이라는 눈대중이었고, 실측 2배짜리 컷을 통과시켰다
       * (2026-09-28: 앉은 성인이 화면 세로의 60%, 맥스가 3m 넘게 그려진 한옥 컷에 "scale ok").
       * 그래서 재게 시킨다 — 자를 하나 고르고, 그려진 치수를 cm 로 환산하고, 실물과 대조해 숫자를 남긴다.
       */
      `2) SCALE — MEASURE it, do not eyeball it. The people in this photo are: ${people}.
` +
      '  a) Pick ONE architectural element you can trust, use it as a ruler, and name it in the note: a door opening is about 200cm tall, ' +
      'a residential ceiling 230-260cm, a window sill sits 90cm off the floor, a kitchen counter 85-95cm, a dining chair seat 45cm, ' +
      'a sofa seat 40-45cm, a coffee table or low console top 35-45cm, a skirting board 8-12cm, a floorboard 12-20cm wide.\n' +
      '  b) Using that ruler, work out roughly how many centimetres tall or long each person and each bean bag is AS DRAWN here.\n' +
      '  c) Compare against their real sizes: a Yogibo Max is 170cm long and about 45cm thick lying flat, a Double is 170cm long and 140cm wide, ' +
      "a Pod is 95cm tall, a Support 94cm, a Drop 75cm, and each person is the height listed above. A seated adult's head sits about half their standing height off the floor.\n" +
      '  scale.ok is false when anything is more than about 25% away from its real size. The note must carry the numbers you measured — ' +
      '"the seated man reads about 200cm against a 200cm door, roughly twice his correct seated height" is the kind of note wanted.\n' +
      '  Watch for the usual failure: the picture was built from a close-up source photograph and kept that close-up size inside a wide room, ' +
      'so the people and the bean bag dwarf the space. Check that the room still reads as the large room its own architecture implies.\n\n' +
      `3) LIGHT — does every person and product look photographed in THIS room${input.hasBackground ? ' (the room itself came from a separate background photo)' : ''}? ` +
      'Judge the light ON THE SUBJECTS, not whether the colours look pleasant together. Look at each product and person on their own and ask: ' +
      'which side is lit, how hard are the shadows, how deep are they, does the room\'s own light colour sit on them, do they cast a shadow onto the floor where they touch it?\n' +
      'Use this scale strictly — most AI composites belong in 60-85, so do not give 90+ out of politeness:\n' +
      '  100-90 = you cannot tell it was assembled: same light direction, same shadow hardness, contact shadows present, the room\'s colour cast on the subject.\n' +
      '  89-75 = small tells: contact shadow weaker than the room\'s other objects, subject slightly cleaner or brighter than its surroundings.\n' +
      '  74-60 = clear tells: the subject is evenly, softly lit (studio-like) while the room has directional or coloured light; the subject\'s own shadows do not follow the room\'s light; fabric looks flat and untextured by the room\'s light.\n' +
      '  59-0 = light comes from the wrong side entirely, or the subject sits in a dim room while being brightly lit; it reads as pasted on.\n' +
      'In the note name the strongest cue in one short sentence.\n\n' +
      'Return JSON only: {"product":{"ok":true,"missing":[],"note":"..."},"scale":{"ok":true,"note":"..."},"light":{"score":0,"note":"..."}}';
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
      scale?: { ok?: unknown; note?: unknown };
      light?: { score?: unknown; note?: unknown };
    };
    // 응답 모양이 다르면 "이상 없음" 이 아니라 "검사 실패" 다 — 빈 응답을 합격으로 받으면 경고가 영영 안 뜬다
    if (!j?.product || !j?.scale || !j?.light) throw new Error(`응답 모양이 다릅니다: ${raw.slice(0, 120)}`);
    const missing = Array.isArray(j.product.missing) ? j.product.missing.map((x) => String(x).slice(0, 40)).slice(0, 6) : [];
    const um = json.usageMetadata;
    return {
      checked: true, model,
      product: { ok: j.product.ok !== false && !missing.length, missing, note: String(j.product.note ?? '').slice(0, 200) },
      scale: { ok: j.scale.ok !== false, note: String(j.scale.note ?? '').slice(0, 200) },
      light: { score: Math.max(0, Math.min(100, Math.round(Number(j.light.score) || 0))), note: String(j.light.note ?? '').slice(0, 200) },
      ...(um ? {
        usage: {
          promptTokens: um.promptTokenCount ?? 0, outputTokens: um.candidatesTokenCount ?? 0,
          thoughtTokens: um.thoughtsTokenCount ?? 0, totalTokens: um.totalTokenCount ?? 0,
        },
      } : {}),
    };
  } catch (e) {
    // 검사 실패로 생성물을 버리지 않는다 — 화면에는 "검사 안 됨" 으로 나간다
    console.warn('[scene-check] 결과 검사 실패:', (e as Error).message);
    return EMPTY(model);
  }
}
