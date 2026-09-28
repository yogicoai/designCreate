import 'server-only';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { getDb } from './db';
import { visionModel } from './logo-guard';

/**
 * 배경 사진의 "사람 크기" 를 미리 재 둔다 (사용자 지적 2026-09-28: "배경 안에 있는 가구 크기에 맞춰서
 * 인물들이 작게 중심으로 들어가야 하는데 합성 자체가 잘못되었어").
 *
 * 왜 필요한가: 배경 합성 컷은 원본 사진의 프레이밍을 그대로 끌고 온다. 원본이 인물 클로즈업이면
 * (실측 2026-09-28: 소년 둘이 화면 세로의 90% 를 채운 맥스 컷) 넓은 한옥 방에 넣어도 그 크기 그대로
 * 나와서 사람과 제품이 방을 압도한다 — 앉은 성인이 화면 세로의 27% 여야 할 자리에 60% 로 그려졌다.
 *
 * 프롬프트에는 이미 "방의 가구에서 미터 스케일을 잡고 실물 크기로 배치하라"(SCALE FROM THE ROOM)와
 * "제품을 프레임 채우게 키우지 말라"(INTERIOR SCENE)가 있었지만 안 먹혔다. 앞쪽의 "원본의 포즈·위치·
 * 제품 형태를 그대로" 가 더 쉽고 더 세기 때문이다. 이 프로젝트에서 모호한 지시는 늘 졌고 숫자는 이겼다
 * (톤 맞춤 scene-tone.ts, 원본 시선 base-gaze.ts). 그래서 실제로 재서 퍼센트로 박는다.
 *
 * 같은 배경을 여러 번 쓰므로 base_scans 에 기록해 두고 다시 묻지 않는다. 실패하면 숫자 없이 진행한다.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const SCANS = 'base_scans';
/** 캐시 키의 판정 버전 — 묻는 방식을 바꾸면 올린다 (안 올리면 옛 답이 그대로 나온다) */
const VERSION = 'rs1';
/** 기준 키 — 이 키의 사람이 화면에서 차지하는 비율을 묻는다 */
export const REF_HEIGHT_CM = 175;

export interface RoomScale {
  /** 기준 키(175cm) 성인이 방 한가운데 섰을 때 화면 세로에서 차지하는 비율 (%) */
  midPct: number;
  /** 카메라에 가장 가까운 자리에 섰을 때 (%) */
  frontPct: number;
  /** 방 안쪽 끝에 섰을 때 (%) */
  backPct: number;
  /** 무엇을 근거로 쟀는지 — 영문 한 줄, 사람이 검증할 수 있게 남긴다 */
  basis: string;
}

const PROMPT =
  'This photograph is a real room that will be used as the background of a product shot: people and furniture ' +
  'will be composited into it and must end up at TRUE physical scale inside it.\n' +
  "STEP 1 — work out the room's metric scale from its own architecture and furnishings. Usable anchors and their " +
  'real sizes: an interior door opening is about 200cm tall, a residential ceiling 230-260cm, a window sill about ' +
  '90cm off the floor, a kitchen counter 85-95cm, a dining chair seat 45cm, a sofa seat 40-45cm, a coffee table or ' +
  'low console top 35-45cm, a skirting board 8-12cm, a floorboard 12-20cm wide, a brick course 7.5cm. ' +
  'Use whichever of these you can actually see, and say which one you used.\n' +
  'STEP 2 — imagine a 175cm adult standing upright on that floor, feet on the ground, and measure how much of the ' +
  'WHOLE IMAGE HEIGHT they would span, from the top of their head down to the floor at their feet. Give it as a ' +
  'percentage of the image height (50 means they fill half the picture from top to bottom).\n' +
  'Answer for three depths: standing at the FRONT of the room nearest the camera, in the MIDDLE where furniture ' +
  'would naturally sit, and at the BACK wall.\n' +
  'Be honest about large rooms shot from far away — in a wide room photographed from the doorway a standing adult ' +
  'often spans only 25-45% of the frame height, not most of it. Do not inflate the numbers.\n' +
  'Return JSON only: {"frontPct": <number>, "midPct": <number>, "backPct": <number>, "basis": "<one short sentence ' +
  'naming the element you measured from and the size you assumed for it>"}';

/** 0 < n <= 100 인 숫자만 통과 */
function pct(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 100 ? Math.round(n * 10) / 10 : null;
}

/** 배경 사진에서 사람 크기를 읽는다. 못 읽으면 null — 프롬프트는 숫자 없이 나간다. */
export async function readRoomScale(url: string): Promise<RoomScale | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !url) return null;
  const id = `${createHash('sha1').update(url).digest('hex').slice(0, 20)}_${VERSION}`;
  try {
    const col = (await getDb()).collection(SCANS);
    const hit = await col.findOne({ _id: id as never });
    if (hit?.scale) return hit.scale as RoomScale;

    const got = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!got.ok) throw new Error(`배경 받기 실패 ${got.status}`);
    const small = await sharp(Buffer.from(await got.arrayBuffer()))
      .rotate()
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const res = await fetch(`${API_BASE}/${visionModel()}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ inlineData: { mimeType: 'image/jpeg', data: small.toString('base64') } }, { text: PROMPT }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`배경 크기 호출 실패 ${res.status}`);
    const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const raw = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as Record<string, unknown>;

    const midPct = pct(parsed.midPct);
    if (midPct === null) throw new Error(`midPct 가 이상합니다: ${raw.slice(0, 120)}`);
    const scale: RoomScale = {
      midPct,
      frontPct: pct(parsed.frontPct) ?? midPct,
      backPct: pct(parsed.backPct) ?? midPct,
      basis: String(parsed.basis ?? '').slice(0, 200),
    };
    await col.updateOne({ _id: id as never }, { $set: { url, scale, at: new Date(), model: visionModel() } }, { upsert: true });
    return scale;
  } catch (e) {
    console.warn('[room-scale] 배경 크기 읽기 실패 — 숫자 없이 진행:', (e as Error).message);
    return null;
  }
}
