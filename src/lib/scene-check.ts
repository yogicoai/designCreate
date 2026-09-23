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
      `2) SCALE — the people in this photo are: ${people}. Use the room's own furniture and architecture as the ruler ` +
      '(sofa seats 40-45cm, coffee tables 40-45cm, kitchen counters 85-95cm, dining chair seats ~45cm, door openings 200-210cm, ceilings 230-250cm). ' +
      'A Yogibo Max is 170cm long, a Pod is 95cm tall, a Support is 94cm tall, a Drop is 75cm tall. ' +
      'scale.ok is false when any bean bag or person clearly reads too large or too small against that furniture — for example a bean bag as tall as a door, ' +
      'a bean bag wider than a three-seat sofa, or a person whose head is oversized for their body. Say in the note which object and how far off it looks.\n\n' +
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
