import 'server-only';
import sharp from 'sharp';

/**
 * 나노바나나(Gemini Image) 클라이언트.
 *
 * Desktop/Dong/src/lib/gemini.ts 에서 실전 검증된 부분을 가져와 이 앱에 맞게 조정했다.
 * 그쪽에서 실제로 겪은 사고들이 여기 반영돼 있다:
 *
 *  ① Vercel 요청 본문 4.5MB 한도 — 참조 2장만으로 초과해 페이지가 통째로 실패한 적이 있다.
 *     우리는 참조를 3~5장 넣으므로 shrinkReference 는 선택이 아니라 필수다.
 *  ② 429 는 "지금 몰림(분당)"과 "오늘 다 씀(일일)"이 다르다. 후자는 기다려도 소용없다.
 *  ③ 이미지 없이 텍스트만 돌아오는 경우가 가끔 있다 — 같은 요청을 다시 하면 대개 나온다.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** 나노바나나가 네이티브로 받는 비율 */
export const GEN_ASPECTS = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'] as const;
export type GenAspect = (typeof GEN_ASPECTS)[number];

export type ImageSize = '1K' | '2K' | '4K';

export interface InlineImage {
  mimeType: string;
  /** base64 원문 */
  data: string;
}

export class GeminiError extends Error {
  status?: number;
  retryAfter?: string | null;
  /** 하루치 할당량 소진 — 재시도해도 소용없다 */
  quotaExhausted?: boolean;
  /** 안전필터 차단 사유 */
  blockReason?: string;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
  }
}

/**
 * 참조 이미지를 1024px JPEG 로 줄인다. **요청 본문 한도를 지키기 위한 필수 단계.**
 *
 * 참조는 "얼굴이 어떻게 생겼나 / 이 제품이 어떤 형태인가"를 보여주는 용도라 1024px 면 충분하다.
 * 실측: 아동B 표정 시트 원본 4.56MB → 82KB.
 */
export async function shrinkReference(raw: Buffer, maxSide = 1024, quality = 82): Promise<InlineImage> {
  try {
    const buf = await sharp(raw)
      .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    return { mimeType: 'image/jpeg', data: buf.toString('base64') };
  } catch {
    // 축소 실패해도 원본으로 시도는 해본다 (형식 미지원 등)
    return { mimeType: 'image/jpeg', data: raw.toString('base64') };
  }
}

/**
 * cafe24 등 공개 URL 의 이미지를 참조로 불러온다 (서버에서 받아오므로 CORS 무관).
 * @param maxSide 축소 상한. 모델 시트는 다패널 그리드라 1024 로 줄이면 얼굴이 판독 불가 —
 *                아이덴티티 앵커는 1600 으로 덜 줄인다 (요청 본문 예산은 충분히 남는다).
 */
export async function loadReference(url: string, maxSide = 1024): Promise<InlineImage | null> {
  const m = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (m) return { mimeType: m[1], data: m[2] };
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return await shrinkReference(buf, maxSide);
  } catch {
    return null;
  }
}

/** 공식 컬러칩 hex 를 단색 스와치 이미지로 — 컬러 정확도 보조 */
export async function colorSwatch(hex: string): Promise<InlineImage> {
  const buf = await sharp({ create: { width: 512, height: 512, channels: 3, background: hex } })
    .png()
    .toBuffer();
  return { mimeType: 'image/png', data: buf.toString('base64') };
}

/** 429 본문에서 재시도 대기시간과 일일 소진 여부를 읽는다 (구글은 헤더가 아니라 본문에 넣어준다) */
export function readQuotaHint(body: string): { retryDelay?: string; daily: boolean } {
  try {
    const parsed = JSON.parse(body) as { error?: { details?: Record<string, unknown>[] } };
    const details = parsed.error?.details ?? [];
    const typeOf = (d: Record<string, unknown>) => String(d['@type'] ?? '');
    const retryInfo = details.find((d) => typeOf(d).endsWith('RetryInfo'));
    const retryDelay = typeof retryInfo?.retryDelay === 'string' ? retryInfo.retryDelay : undefined;
    const quota = details.find((d) => typeOf(d).endsWith('QuotaFailure'));
    const violations = (quota?.violations ?? []) as Record<string, unknown>[];
    const daily = violations.some((v) => /per\s*day|perday/i.test(`${v.quotaId ?? ''} ${v.quotaMetric ?? ''}`));
    return { retryDelay, daily };
  } catch {
    return { daily: false };
  }
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600);
}

function retryDelayMs(attempt: number, retryAfter?: string | null, maxMs = 10_000): number {
  const told = parseFloat(String(retryAfter ?? ''));
  if (Number.isFinite(told) && told > 0) return Math.min(told * 1000, maxMs);
  const base = 800 * 2 ** Math.max(0, attempt - 1);
  return Math.round(base * (0.7 + Math.random() * 0.6)); // 동시 실패가 같은 순간에 다시 몰리지 않게
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface GenerateInput {
  prompt: string;
  /** 참조 이미지 — 순서가 프롬프트의 FIRST/SECOND/THIRD 와 일치해야 한다 */
  references: InlineImage[];
  aspect: GenAspect;
  size?: ImageSize;
  /** 기본은 Pro. 대량 탐색 시 draft 로 내린다. */
  tier?: 'pro' | 'draft';
}

export interface TokenUsage {
  /** 입력 (텍스트 + 참조 이미지) */
  promptTokens: number;
  /** 출력 이미지 토큰 */
  imageTokens: number;
  /** 내부 추론 토큰 — 출력 단가로 과금된다. 빼먹으면 원가가 60%% 과소 계상된다. */
  thoughtTokens: number;
  totalTokens: number;
}

export interface GenerateResult {
  buffer: Buffer;
  usage?: TokenUsage;
  mimeType: string;
  width: number;
  height: number;
  model: string;
  elapsedMs: number;
  /** 요청 본문 크기 — Vercel 한도 근접 여부 모니터링용 */
  requestBytes: number;
}

const ATTEMPTS = 4;
const RETRY_DEADLINE_MS = 90_000;
const RATE_LIMIT_MAX_WAIT_MS = 45_000;
const RATE_LIMIT_DEADLINE_MS = 150_000;

export async function generateImage(input: GenerateInput): Promise<GenerateResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new GeminiError('GEMINI_API_KEY 가 설정되지 않았습니다 (.env.local).', 503);

  const model =
    input.tier === 'draft'
      ? process.env.GEMINI_IMAGE_MODEL_DRAFT || 'gemini-3.1-flash-image'
      : process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image';
  const size = input.size || (process.env.GEMINI_IMAGE_SIZE as ImageSize) || '2K';

  const parts: unknown[] = [
    ...input.references.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.data } })),
    { text: input.prompt },
  ];
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: input.aspect, imageSize: size },
    },
  });
  const requestBytes = Buffer.byteLength(body);

  const once = async (): Promise<GenerateResult> => {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body,
      });
    } catch (e) {
      throw new GeminiError(`Gemini 에 연결하지 못했습니다: ${(e as Error).message}`, 503);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 429) {
        const hint = readQuotaHint(text);
        const err = new GeminiError(
          hint.daily
            ? '오늘 생성 가능한 이미지 수를 모두 사용했습니다. 내일 다시 시도하거나 결제 설정을 확인해주세요.'
            : '생성 요청이 한꺼번에 몰렸습니다. 잠시 뒤 다시 시도합니다.',
          429,
        );
        err.retryAfter = res.headers.get('retry-after') ?? hint.retryDelay ?? null;
        err.quotaExhausted = hint.daily;
        throw err;
      }
      const err = new GeminiError(`Gemini 호출 실패 (HTTP ${res.status}): ${text.slice(0, 300)}`, res.status);
      err.retryAfter = res.headers.get('retry-after');
      throw err;
    }

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: Record<string, unknown>[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        totalTokenCount?: number;
        candidatesTokensDetails?: { modality?: string; tokenCount?: number }[];
      };
    };

    const um = json.usageMetadata;
    const usage: TokenUsage | undefined = um
      ? {
          promptTokens: um.promptTokenCount ?? 0,
          imageTokens: um.candidatesTokensDetails?.find((d) => d.modality === 'IMAGE')?.tokenCount ?? um.candidatesTokenCount ?? 0,
          thoughtTokens: um.thoughtsTokenCount ?? 0,
          totalTokens: um.totalTokenCount ?? 0,
        }
      : undefined;

    if (json.promptFeedback?.blockReason) {
      // 안전필터. 같은 프롬프트로 다시 걸어도 결과가 같으므로 재시도 대상이 아니다.
      const err = new GeminiError(`안전필터에 차단되었습니다: ${json.promptFeedback.blockReason}`, 422);
      err.blockReason = json.promptFeedback.blockReason;
      throw err;
    }

    const cand = json.candidates?.[0];
    for (const p of cand?.content?.parts ?? []) {
      const inline = (p.inlineData ?? p.inline_data) as { data?: string; mimeType?: string; mime_type?: string } | undefined;
      if (inline?.data) {
        const buffer = Buffer.from(inline.data, 'base64');
        const meta = await sharp(buffer).metadata();
        return {
          buffer,
          ...(usage ? { usage } : {}),
          mimeType: inline.mimeType ?? inline.mime_type ?? 'image/png',
          width: meta.width ?? 0,
          height: meta.height ?? 0,
          model,
          elapsedMs: Date.now() - t0,
          requestBytes,
        };
      }
    }
    throw new GeminiError('응답에 이미지가 없습니다 (모델이 텍스트만 반환).', 502);
  };

  const startedAt = Date.now();
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await once();
    } catch (e) {
      last = e;
      const err = e instanceof GeminiError ? e : null;
      if (!err?.status) break;
      if (err.quotaExhausted) break; // 기다려도 소용없다
      if (!isRetryable(err.status) || attempt === ATTEMPTS) break;
      const crowded = err.status === 429;
      const delay = retryDelayMs(attempt, err.retryAfter, crowded ? RATE_LIMIT_MAX_WAIT_MS : 10_000);
      const deadline = crowded ? RATE_LIMIT_DEADLINE_MS : RETRY_DEADLINE_MS;
      if (Date.now() - startedAt + delay > deadline) break;
      await sleep(delay);
    }
  }
  throw last;
}
