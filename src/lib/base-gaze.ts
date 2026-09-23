import 'server-only';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { getDb } from './db';
import { visionModel } from './logo-guard';

/**
 * 편집 원본 사진 속 인물의 머리 각도·시선을 읽어 둔다 (사용자 지적 2026-09-23: "왜 정면을 응시할까나").
 *
 * 왜 필요한가: 얼굴을 바꾸면 인물이 카메라를 쳐다보는 쪽으로 끌린다. 얼굴 시트·표정컷이 전부 정면
 * 스튜디오 포트레이트이고, "이 표정을 정확히 베껴라" 가 각도까지 끌고 오기 때문이다.
 * 프롬프트에는 이미 "원본의 머리 각도·시선을 지켜라" 가 있었지만 원본이 어디를 보는지는 말해주지 않는다 —
 * 모호한 지시는 안 지켜지고 구체적으로 적은 지시는 지켜진다는 게 이 프로젝트의 규칙이라, 실제로 읽어서 문장으로 넣는다.
 * (톤 맞춤에서 같은 방식이 통했다 — scene-tone.ts)
 *
 * 같은 사진을 여러 번 쓰므로 base_scans 에 기록해 두고 다시 묻지 않는다. 실패하면 문장 없이 진행한다.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const SCANS = 'base_scans';
/** 읽는 방식이 바뀌면 올린다 — 옛 기록을 다시 쓰지 않게 */
const VERSION = 'g1';

/** 사진 왼쪽부터 세어 사람마다 한 줄 (영문, 프롬프트에 그대로 들어간다) */
export async function readBaseGaze(buf: Buffer, url: string, expected: number): Promise<string[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key || expected < 1) return [];
  const id = `${createHash('sha1').update(url).digest('hex').slice(0, 20)}_${VERSION}_${expected}`;
  try {
    const col = (await getDb()).collection(SCANS);
    const hit = await col.findOne({ _id: id as never });
    if (hit) return Array.isArray(hit.people) ? (hit.people as string[]) : [];

    const small = await sharp(buf).rotate().resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    const text =
      `This photograph will be edited: its ${expected} people (counted from the LEFT of the frame) will be replaced by other models, ` +
      'keeping exactly how each of them is turned and where they look. Describe that for each person in ONE short sentence, in this order:\n' +
      '  (a) how the head is turned relative to the camera — "facing the camera", "three-quarter turned to their left", "profile to their right", "head tilted down" …\n' +
      '  (b) where the eyes look — "at the camera", "off-frame to the left", "at the other person", "down at what they hold", "into the middle distance" …\n' +
      '  (c) what they are doing with hands or body that fixes that direction, if anything.\n' +
      'Write it as an instruction to keep, for example: "PERSON 1: three-quarter turned to their left, smiling, eyes off-frame left toward the fireplace — not at the camera."\n' +
      `Return JSON only: {"people":["PERSON 1: …","PERSON 2: …"]} with exactly ${expected} entries in left-to-right order.`;
    const res = await fetch(`${API_BASE}/${visionModel()}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ inlineData: { mimeType: 'image/jpeg', data: small.toString('base64') } }, { text }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`시선 읽기 호출 실패 ${res.status}`);
    const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const raw = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as { people?: unknown };
    if (!Array.isArray(parsed?.people)) throw new Error(`응답 모양이 다릅니다: ${raw.slice(0, 120)}`);
    const people = parsed.people.map((x) => String(x).slice(0, 220)).slice(0, expected);
    await col.updateOne({ _id: id as never }, { $set: { url, people, at: new Date(), model: visionModel() } }, { upsert: true });
    return people;
  } catch (e) {
    console.warn('[base-gaze] 원본 시선 읽기 실패 — 문장 없이 진행:', (e as Error).message);
    return [];
  }
}
