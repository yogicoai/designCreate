import 'server-only';
import sharp from 'sharp';
import { ObjectId } from 'mongodb';
import { getDb, COLLECTIONS } from './db';
import { checkFaces } from './face-guard';
import { visionModel } from './logo-guard';

/**
 * 시리즈 일관성 (점검 2026-10-02 8번) — 같은 전속 모델이 나온 컷끼리 서로 같은 사람으로 보이는가.
 *
 * 왜 필요한가: 얼굴 검사(face-guard)는 컷마다 시트와 대조한다. 그런데 상품 페이지에는 그 모델의 컷 5장이 나란히 걸리고,
 * 시트와는 각각 "닮았다" 로 통과한 컷들이 서로는 다른 사람으로 보이는 일이 생긴다 — 그건 아무도 안 봤다.
 * 여기서는 얼굴 검사가 남긴 머리 위치(headBox)로 얼굴만 잘라 나란히 놓고, 한 번의 비전 호출로 "무리에서 튀는 컷" 을 찾는다.
 * 고치지는 않는다 — 어느 컷을 다시 뽑을지는 사람이 정한다. 로컬 전용 화면(「생성 품질」)에서만 부른다.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const SERIES = 'series_checks';
/** 한 번에 나란히 놓는 컷 수 — 많으면 비전이 뭉뚱그린다 */
export const SERIES_MAX = 8;

type Box = [number, number, number, number];

export interface SeriesTile {
  id: string;
  url: string;
  width: number;
  height: number;
  /** [ymin, xmin, ymax, xmax] 0~1000 */
  box: Box;
  verdict: string;
  createdAt: string;
}

export interface SeriesResult {
  talent: string;
  cutIds: string[];
  /** 튀는 컷의 id (무리와 다른 사람으로 보임) */
  outliers: string[];
  note: string;
  checkedAt: string;
}

/** 그 모델의 최근 컷 중 얼굴 위치를 아는 것 — 숨긴 컷과 판정 불가(작음·안 보임)는 뺀다 */
export async function seriesTiles(talent: string, limit = SERIES_MAX): Promise<SeriesTile[]> {
  const db = await getDb();
  const docs = await db
    .collection(COLLECTIONS.cuts)
    .find({ source: 'imgcreate', hidden: { $ne: true }, 'recipe.talentCodes': talent, 'qc.face.verdicts': { $elemMatch: { code: talent, headBox: { $exists: true } } } })
    .project({ url: 1, width: 1, height: 1, createdAt: 1, 'qc.face.verdicts': 1 })
    .sort({ createdAt: -1 })
    .limit(limit * 2)
    .toArray();
  const out: SeriesTile[] = [];
  for (const c of docs) {
    const v = (c.qc?.face?.verdicts ?? []).find((x: { code: string }) => x.code === talent);
    if (!v?.headBox || !['ok', 'weak', 'drift'].includes(v.verdict)) continue;
    out.push({
      id: String(c._id), url: String(c.url), width: Number(c.width) || 0, height: Number(c.height) || 0,
      box: v.headBox as Box, verdict: String(v.verdict), createdAt: new Date(c.createdAt).toISOString(),
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchBuf(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`그림을 받지 못했습니다 (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** 머리 상자를 조금 넓혀 정사각으로 자른다 (머리카락·턱선이 잘리지 않게) */
async function cropHead(buf: Buffer, box: Box, px = 384): Promise<Buffer> {
  const img = sharp(buf).rotate();
  const meta = await img.metadata();
  const W = meta.width ?? 0, H = meta.height ?? 0;
  const [y0, x0, y1, x1] = box;
  const cx = ((x0 + x1) / 2000) * W, cy = ((y0 + y1) / 2000) * H;
  const side = Math.max(((x1 - x0) / 1000) * W, ((y1 - y0) / 1000) * H) * 1.35;
  const left = Math.max(0, Math.round(cx - side / 2)), top = Math.max(0, Math.round(cy - side / 2));
  const w = Math.max(8, Math.min(W - left, Math.round(side))), h = Math.max(8, Math.min(H - top, Math.round(side)));
  return img.extract({ left, top, width: w, height: h }).resize(px, px, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer();
}

/** 컷 한 장에서 그 모델의 얼굴 조각 — 「생성 품질」 화면의 시리즈 줄이 쓴다 */
export async function headCrop(cutId: string, talent: string, px = 192): Promise<Buffer | null> {
  if (!ObjectId.isValid(cutId)) return null;
  const cut = await (await getDb()).collection(COLLECTIONS.cuts).findOne({ _id: new ObjectId(cutId) }, { projection: { url: 1, 'qc.face.verdicts': 1 } });
  const v = (cut?.qc?.face?.verdicts ?? []).find((x: { code: string }) => x.code === talent);
  if (!cut?.url || !v?.headBox) return null;
  return cropHead(await fetchBuf(String(cut.url)), v.headBox as Box, px);
}

/** 저장된 최근 판정 — 같은 컷 묶음이면 다시 묻지 않는다 */
export async function lastSeries(talent: string): Promise<SeriesResult | null> {
  const hit = await (await getDb()).collection(SERIES).findOne({ _id: talent as never });
  return hit ? { talent, cutIds: hit.cutIds ?? [], outliers: hit.outliers ?? [], note: hit.note ?? '', checkedAt: new Date(hit.checkedAt).toISOString() } : null;
}

/** 그 모델의 최근 컷 얼굴을 나란히 놓고 튀는 컷을 찾는다 — 비전 호출 1회 */
export async function checkSeries(talent: string): Promise<SeriesResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY 가 없습니다.');
  const tiles = await seriesTiles(talent);
  if (tiles.length < 2) throw new Error('얼굴 위치를 아는 컷이 2장 이상 있어야 합니다.');

  const prev = await lastSeries(talent);
  const ids = tiles.map((t) => t.id);
  if (prev && prev.cutIds.join(',') === ids.join(',')) return prev;

  const db = await getDb();
  const t = await db.collection(COLLECTIONS.talents).findOne({ code: talent });
  const sheetUrl = String(t?.sheets?.face || t?.rep || '');
  const sheet = sheetUrl ? await fetchBuf(sheetUrl).then((b) => sharp(b).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer()).catch(() => null) : null;
  const heads = await Promise.all(tiles.map(async (x) => cropHead(await fetchBuf(x.url), x.box)));

  const text =
    `${sheet ? 'The FIRST image is the identity sheet of one real person (several views of the SAME person). The following ' : 'The '}` +
    `${heads.length} images are head crops taken from ${heads.length} different generated photographs, numbered 1 to ${heads.length} in the order given. ` +
    'All of them are supposed to depict that one person, and they will be published side by side on the same product page.\n' +
    'Judge whether the crops look like ONE consistent person to a shopper glancing across them. Compare bone structure, eye shape and spacing, ' +
    'nose, lips, jaw and chin, apparent age, and freckles or moles. IGNORE expression, head angle, lighting, hair styling and image quality.\n' +
    'List in "outliers" the numbers of the crops that look like a DIFFERENT person from the majority (or from the sheet). ' +
    'Be strict but fair: a crop that is merely lit differently or turned away is not an outlier.\n' +
    'Return JSON only: {"outliers":[],"note":"one short sentence naming what differs in the outliers, or \'consistent\'"}';

  const model = visionModel();
  const res = await fetch(`${API_BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{
        parts: [
          ...(sheet ? [{ inlineData: { mimeType: 'image/jpeg', data: sheet.toString('base64') } }] : []),
          ...heads.map((h) => ({ inlineData: { mimeType: 'image/jpeg', data: h.toString('base64') } })),
          { text },
        ],
      }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`비전 호출 실패 ${res.status}`);
  const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const raw = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  const j = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as { outliers?: unknown; note?: unknown };
  if (!Array.isArray(j?.outliers)) throw new Error(`응답 모양이 다릅니다: ${raw.slice(0, 120)}`);
  const outliers = (j.outliers as unknown[])
    .map((n) => Math.round(Number(n)))
    .filter((n) => n >= 1 && n <= tiles.length)
    .map((n) => tiles[n - 1].id);
  const result: SeriesResult = { talent, cutIds: ids, outliers: [...new Set(outliers)], note: String(j.note ?? '').slice(0, 240), checkedAt: new Date().toISOString() };
  await db.collection(SERIES).updateOne(
    { _id: talent as never },
    { $set: { cutIds: result.cutIds, outliers: result.outliers, note: result.note, model, checkedAt: new Date() } },
    { upsert: true },
  );
  return result;
}

/**
 * 컷 한 장의 얼굴 검사를 다시 돌린다 — 검사 방식을 고친 뒤 예전 판정을 바로잡을 때 쓴다.
 * (2026-10-02: 여러 명 컷에서 모든 모델을 같은 얼굴과 비교하던 것을 고쳤고, 머리 위치를 남기기 시작했다.)
 * 예전 판정은 qc.facePrev 에 한 번만 남긴다.
 */
export async function recheckFaces(cutId: string): Promise<{ id: string; before: string; after: string } | null> {
  if (!ObjectId.isValid(cutId)) return null;
  const db = await getDb();
  const cuts = db.collection(COLLECTIONS.cuts);
  const cut = await cuts.findOne({ _id: new ObjectId(cutId) });
  const codes: string[] = (cut?.recipe?.talentCodes ?? []).map(String);
  if (!cut || !codes.length) return null;
  const docs = await db.collection(COLLECTIONS.talents).find({ code: { $in: codes } }).toArray();
  const refs = codes
    .map((code) => {
      const d = docs.find((x) => String(x.code) === code);
      const url = String(d?.sheets?.face || d?.rep || '');
      return url ? { code, faceUrl: url, who: String(d?.identityEn || d?.thumbDesc || d?.identity || '').slice(0, 220) } : null;
    })
    .filter((x): x is { code: string; faceUrl: string; who: string } => !!x);
  if (!refs.length) return null;
  const people = codes.length + ((cut.recipe?.freeformTalents ?? []) as unknown[]).length;
  const check = await checkFaces(await fetchBuf(String(cut.url)), refs, people);
  if (!check.checked) return null;
  const show = (vs: { code: string; verdict: string }[] | undefined) => (vs ?? []).map((v) => `${v.code}:${v.verdict}`).join(' ') || '-';
  const before = show(cut.qc?.face?.verdicts);
  await cuts.updateOne(
    { _id: cut._id },
    {
      $set: {
        'qc.face': { checked: true, verdicts: check.verdicts, ...(check.usage ? { usage: check.usage } : {}), recheckedAt: new Date() },
        ...(cut.qc?.face && !cut.qc?.facePrev ? { 'qc.facePrev': cut.qc.face } : {}),
      },
    },
  );
  return { id: cutId, before, after: show(check.verdicts) };
}
