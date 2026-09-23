import 'server-only';
import sharp from 'sharp';
import { visionModel, type VisionUsage } from './logo-guard';

/**
 * 결과물의 얼굴이 등록된 전속 모델과 같은 사람인지 검사한다.
 *
 * 왜 필요한가 (사용자 지적 2026-09-16: "여자 모델에 대한 모델얼굴 변화가 있는게 많아",
 * "크게보니깐 조금 무섭게 나옴"):
 *   얼굴 참조를 크게 넣고 "최우선 참조" 라고 못박아도, 인물이 화면의 5~10% 뿐인 와이드 컷에서는
 *   모델이 얼굴을 "풀어야 할 문제" 로 보지 않고 자기가 아는 예쁜 얼굴로 대체한다.
 *   실측 2026-09-16: 얼굴 앵커(2536×2246 확대본)를 넣은 조합컷에서도 주근깨·볼의 점이 사라지고
 *   더 어리고 매끈한 얼굴로 바뀌었다.
 *
 * 그래서 막는 대신 **알린다**. 로고처럼 픽셀로 고칠 수 있는 문제가 아니다 —
 * 얼굴을 고치려면 다시 생성해야 하고, 그건 사람이 결정할 일이다.
 * 검사는 결과를 버리지 않는다: 실패하면 checked:false 로 조용히 넘어간다.
 *
 * 비용은 제미나이 비전 호출 1회(이미지 2장) — 이미지 생성보다 두 자리수 싸다.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * 얼굴이 이 비율보다 작으면 "판정 불가" 로 둔다.
 * 머리 높이가 화면 높이의 6% 미만이면 사람 눈으로도 동일인 판정이 안 되고,
 * 비전도 근거 없이 "닮았다" 로 기울어 경고가 무의미해진다.
 * (실측: 3:2 와이드 방 컷에서 머리는 화면 높이의 7~9%)
 */
const MIN_HEAD_FRAC = 0.06;

export interface FaceVerdict {
  /** 전속 모델 코드 */
  code: string;
  /** 0~100. 같은 사람일 가능성 */
  score: number;
  /** 'ok' | 'weak'(애매) | 'drift'(어긋남) | 'tooSmall'(얼굴이 작아 판정 불가) | 'noFace'(사람이 안 보임) */
  verdict: 'ok' | 'weak' | 'drift' | 'tooSmall' | 'noFace';
  /** 무엇이 다른지 — 한 줄. 사람이 읽고 재생성 여부를 정한다 */
  note: string;
  /** 머리 높이 / 이미지 높이 */
  headFrac: number;
}

export interface FaceCheck {
  verdicts: FaceVerdict[];
  usage?: VisionUsage;
  model: string;
  checked: boolean;
}

const PROMPT =
  'The FIRST image is a generated marketing photograph. The SECOND image is an identity sheet: the face of ONE specific ' +
  'person photographed from five angles in a row — front, three-quarter, profile, three-quarter, profile. ' +
  'It is five views of the SAME person, not five people. This is the person the photograph was supposed to depict.\n' +
  'Find the person in the FIRST image whose face is most visible, and compare that face with the SECOND image.\n' +
  'Judge IDENTITY only — the bone structure, the shape and spacing of the eyes, the eyebrow shape, the nose width and tip, ' +
  'the lip shape, the jaw and chin, the cheek width, and any freckles or moles. ' +
  'IGNORE expression, head angle, lighting, hair styling, make-up, clothing and image quality.\n' +
  'Be strict. A face that is merely the same age, ethnicity and hairstyle is NOT the same person. ' +
  'Generated faces typically drift by becoming younger, slimmer, smoother and more symmetrical than the real person, ' +
  'and by losing freckles and moles — if you see that, say so and judge it a different person.\n' +
  'Return JSON only, in this exact form: ' +
  '{"verdict":"same","head_box":[ymin,xmin,ymax,xmax],"face_visible":true,"difference":"..."} where\n' +
  '  verdict is EXACTLY ONE of these five words and nothing else: ' +
  '"same" (certainly the same person), "likely_same" (almost certainly, minor rendering differences only), ' +
  '"unsure" (could go either way), "likely_different" (probably a different person), "different" (clearly a different person);\n' +
  '  head_box is the head of that person in the FIRST image, normalised to 0-1000;\n' +
  '  face_visible is false if no face is discernible in the FIRST image (turned away, too small, cropped out);\n' +
  '  difference is ONE short sentence naming the most important way the two faces differ, or "same person" if they match.\n' +
  'Do NOT return a numeric score. The verdict word is the answer.';

/*
 * 점수 대신 단어를 받는다 — 0~100 으로 달라고 하면 비전이 때때로 0~10 으로 답한다.
 * 실측 2026-09-16: "주근깨까지 거의 완벽히 일치한다" 면서 7점을 돌려줘 멀집한 컷이 어긋남으로 찍혔다.
 * 단어는 척도가 흔들리지 않고, 점수는 화면 표시용으로 여기서 역산한다.
 */
const VERDICT_SCORE: Record<string, { score: number; verdict: FaceVerdict['verdict'] }> = {
  same: { score: 95, verdict: 'ok' },
  likely_same: { score: 80, verdict: 'ok' },
  unsure: { score: 65, verdict: 'weak' },
  likely_different: { score: 40, verdict: 'drift' },
  different: { score: 15, verdict: 'drift' },
};

async function fetchRef(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** 이미지 한 장을 비전에 넣기 좋은 크기로 (얼굴이 작아 1024 로 줄이면 이목구비가 사라진다) */
async function forVision(buf: Buffer, px: number): Promise<string> {
  const out = await sharp(buf).rotate().resize(px, px, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  return out.toString('base64');
}

/**
 * 결과물 한 장을 전속 모델 얼굴과 대조한다.
 * @param buf 생성 결과
 * @param talents 화면에 나와야 할 전속 모델 — code 와 얼굴 참조 URL
 */
export async function checkFaces(
  buf: Buffer,
  talents: { code: string; faceUrl: string }[],
): Promise<FaceCheck> {
  const key = process.env.GEMINI_API_KEY;
  const model = visionModel();
  const empty: FaceCheck = { verdicts: [], model, checked: false };
  if (!key || !talents.length) return empty;

  try {
    // 결과물은 1536 까지 남긴다 — 와이드 컷에서 얼굴이 100px 수준이라 1024 로 줄이면 판정이 무너진다
    const shot = await forVision(buf, 1536);
    const meta = await sharp(buf).rotate().metadata();
    const H = meta.height ?? 0;
    if (!H) return empty;

    const verdicts: FaceVerdict[] = [];
    let usage: VisionUsage | undefined;

    for (const t of talents) {
      const refRaw = await fetchRef(t.faceUrl);
      if (!refRaw) continue;
      const ref = await forVision(refRaw, 1024);

      const res = await fetch(`${API_BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: shot } },
              { inlineData: { mimeType: 'image/jpeg', data: ref } },
              { text: PROMPT },
            ],
          }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0 },
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) {
        console.warn('[face-guard] 비전 호출 실패', res.status);
        continue;
      }
      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
      };
      const raw = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as {
        verdict?: unknown; head_box?: unknown; face_visible?: unknown; difference?: unknown;
      };
      // 응답 모양 검사 — 아는 단어가 아니면 "검사 실패" 다. 낮은 점수로 받으면 멀쩡한 컷에 경고가 뜬다
      const word = String(parsed?.verdict ?? '').trim().toLowerCase();
      const mapped = VERDICT_SCORE[word];
      if (!mapped) throw new Error(`비전 응답 모양이 다릅니다: ${raw.slice(0, 120)}`);

      const box = Array.isArray(parsed.head_box) ? (parsed.head_box as number[]) : null;
      const headFrac = box && box.length === 4 && box.every((v) => Number.isFinite(v))
        ? Math.abs(Number(box[2]) - Number(box[0])) / 1000
        : 0;

      const s = mapped.score;
      const note = String(parsed.difference ?? '').slice(0, 200);
      /*
       * 판정 순서가 중요하다 — 얼굴이 안 보이거나 너무 작은 건 "틀렸다" 가 아니라 "못 본다" 다.
       * 뒷모습 컷에 "얼굴 어긋남" 을 띄우면 경고를 아무도 안 믿게 된다.
       */
      const verdict: FaceVerdict['verdict'] =
        parsed.face_visible === false ? 'noFace'
        : headFrac > 0 && headFrac < MIN_HEAD_FRAC ? 'tooSmall'
        : mapped.verdict;

      verdicts.push({ code: t.code, score: s, verdict, note, headFrac: Number(headFrac.toFixed(3)) });

      const um = json.usageMetadata;
      if (um) {
        usage = {
          promptTokens: (usage?.promptTokens ?? 0) + (um.promptTokenCount ?? 0),
          outputTokens: (usage?.outputTokens ?? 0) + (um.candidatesTokenCount ?? 0),
          thoughtTokens: (usage?.thoughtTokens ?? 0) + (um.thoughtsTokenCount ?? 0),
          totalTokens: (usage?.totalTokens ?? 0) + (um.totalTokenCount ?? 0),
        };
      }
    }

    if (!verdicts.length) return empty;
    return { verdicts, ...(usage ? { usage } : {}), model, checked: true };
  } catch (e) {
    // 얼굴 검사 실패로 생성물을 버리지 않는다
    console.warn('[face-guard] 얼굴 대조 실패 — 검사 없이 진행:', (e as Error).message);
    return empty;
  }
}

/** 화면에 한 줄로 띄울 문구 — 없으면 null */
export function faceNote(v: FaceVerdict): string | null {
  switch (v.verdict) {
    case 'drift':
      return `얼굴 어긋남 (${v.code} · ${v.score}점)${v.note ? ` — ${v.note}` : ''}`;
    case 'weak':
      return `얼굴 애매 (${v.code} · ${v.score}점)${v.note ? ` — ${v.note}` : ''}`;
    case 'tooSmall':
      return `얼굴이 너무 작아 판정 불가 (${v.code} · 머리가 화면 높이의 ${Math.round(v.headFrac * 100)}%)`;
    case 'noFace':
      return null; // 뒷모습·측면 컷은 정상이다
    default:
      return null;
  }
}
