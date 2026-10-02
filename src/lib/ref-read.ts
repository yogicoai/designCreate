import 'server-only';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { getDb } from './db';
import { visionModel } from './logo-guard';
import type { RefRead } from './ref-hygiene';

/**
 * 참조 사진에 무엇이 찍혀 있는지 한 번 읽는다 (점검 2026-10-02 6번 — 규칙은 ref-hygiene.ts).
 *
 * 사진마다 비전 호출 1회(가벼운 텍스트 응답). 결과는 ref_reads 에 남겨서 같은 사진은 다시 묻지 않는다.
 * 역할(배경·분위기·편집 원본)은 화면에서 바뀔 수 있으므로 여기서는 역할과 무관한 사실만 읽는다.
 * 읽기에 실패하면 기록하지 않고 null — "문제 없음" 으로 남기면 경고가 영영 안 뜬다.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const COLLECTION = 'ref_reads';
/** 질문을 바꾸면 올린다 — 예전 기록을 다시 읽게 된다 */
const VERSION = 'v1';

const PROMPT =
  'You are screening a reference photo before it is used to generate a commercial image of Yogibo bean bags. ' +
  'Report only what is visibly in the photo.\n' +
  '- people: how many real people are visible (0 if none; count partial bodies such as legs or hands as people).\n' +
  '- on_product: true if any person is sitting on, lying on or leaning against a bean bag.\n' +
  '- beanbags: how many bean bags (soft fabric bead-filled furniture, any brand) are visible.\n' +
  '- pressed: true if any bean bag is visibly dented, flattened, folded or wrapped around a body or object — i.e. NOT in its untouched resting shape.\n' +
  '- setting: "room" if a real interior with walls/floor/furniture is visible, "outdoor" if it is outside, ' +
  '"plain" if the subject sits on a seamless single-colour or studio backdrop with no room.\n' +
  '- gear: true if photography equipment is visible (light stands, softboxes, reflectors, tripods, backdrop rolls, cables).\n' +
  '- frame: true if this is NOT one clean photograph — a screenshot with app UI, a social-media frame or border, a collage of several photos, a mockup.\n' +
  '- text: true if there is clearly readable lettering — wall-art letters, signs, posters, neon, or an overlaid watermark, caption or logo. Ignore tiny product labels.\n' +
  '- note: one short sentence describing what the photo shows.\n' +
  'Return JSON only: {"people":0,"on_product":false,"beanbags":0,"pressed":false,"setting":"room","gear":false,"frame":false,"text":false,"note":"..."}';

const memo = new Map<string, Promise<RefRead | null>>();

export async function readReference(url: string): Promise<RefRead | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const id = `${createHash('sha1').update(url).digest('hex').slice(0, 20)}_${VERSION}`;
  if (!memo.has(id)) {
    memo.set(id, (async () => {
      const col = (await getDb()).collection(COLLECTION);
      const hit = await col.findOne({ _id: id as never });
      if (hit?.read) return hit.read as RefRead;

      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`참조를 받지 못했습니다 (${res.status})`);
      const raw = Buffer.from(await res.arrayBuffer());
      const upright = await sharp(raw).rotate().toBuffer();
      const meta = await sharp(upright).metadata();
      const small = await sharp(upright).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      const model = visionModel();
      const call = await fetch(`${API_BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ inlineData: { mimeType: 'image/jpeg', data: small.toString('base64') } }, { text: PROMPT }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0 },
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!call.ok) throw new Error(`비전 호출 실패 ${call.status}`);
      const json = (await call.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
      };
      const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      const j = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as Record<string, unknown>;
      // 응답 모양이 다르면 "깨끗함" 이 아니라 "읽기 실패" 다
      if (typeof j?.people !== 'number' || typeof j?.setting !== 'string') throw new Error(`응답 모양이 다릅니다: ${text.slice(0, 120)}`);
      const read: RefRead = {
        people: Math.max(0, Math.min(20, Math.round(j.people))),
        onProduct: j.on_product === true,
        beanbags: Math.max(0, Math.min(20, Math.round(Number(j.beanbags) || 0))),
        pressed: j.pressed === true,
        setting: j.setting === 'plain' ? 'plain' : j.setting === 'outdoor' ? 'outdoor' : 'room',
        gear: j.gear === true,
        frame: j.frame === true,
        text: j.text === true,
        longSide: Math.max(meta.width ?? 0, meta.height ?? 0),
        note: String(j.note ?? '').slice(0, 200),
      };
      const um = json.usageMetadata;
      await col.updateOne(
        { _id: id as never },
        {
          $set: {
            url, read, model, checkedAt: new Date(),
            ...(um ? { usage: { promptTokens: um.promptTokenCount ?? 0, outputTokens: um.candidatesTokenCount ?? 0, thoughtTokens: um.thoughtsTokenCount ?? 0, totalTokens: um.totalTokenCount ?? 0 } } : {}),
          },
        },
        { upsert: true },
      );
      return read;
    })());
  }
  try {
    return await memo.get(id)!;
  } catch (e) {
    memo.delete(id);
    console.warn('[ref-read] 참조 읽기 실패 — 경고 없이 진행:', url, (e as Error).message);
    return null;
  }
}
