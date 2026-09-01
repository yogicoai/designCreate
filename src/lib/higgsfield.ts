import 'server-only';

/**
 * Higgsfield 이미지 생성 엔진 (Soul).
 *
 * 강점은 **Element 토큰** — 제품별로 학습해둔 레퍼런스를 프롬프트에 `<<<element_id>>>` 로
 * 심으면 그 제품의 형태·색을 정확히 재현한다. 실측(Max 네이비, 동일 브리프):
 * 컬러 ΔE 나노바나나 8.4 → 힉스필드 4.4. Element 보유 컬러는 소수(Max 아쿠아·네이비)라
 * 그 밖에서는 이점이 크지 않다.
 *
 * ⚠️ 플랫폼 REST 는 MCP 와 카탈로그가 다르다. 실측 확인:
 *   - 경로는 `/v1/text2image/{model}`, 유효 모델은 `soul` (nano_banana_pro 는 404)
 *   - `width_and_height` 는 고정 프리셋 문자열만 받는다 (임의 픽셀 불가)
 *   - 잔액 조회 엔드포인트는 없다 → 크레딧은 앱에서 추정 추적
 *
 * 인증: Authorization: Key <KEY_ID>:<KEY_SECRET>  (youtube/src/lib/higgsfield.js 와 동일)
 */

const BASE = 'https://platform.higgsfield.ai';

export class HiggsfieldError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HiggsfieldError';
    this.status = status;
  }
}

export function higgsfieldConfigured(): boolean {
  return !!(process.env.HIGGSFIELD_KEY_ID && process.env.HIGGSFIELD_KEY_SECRET);
}

function authHeader(): string {
  const id = process.env.HIGGSFIELD_KEY_ID;
  const secret = process.env.HIGGSFIELD_KEY_SECRET;
  if (!id || !secret) throw new HiggsfieldError('HIGGSFIELD_KEY_ID/SECRET 가 설정되지 않았습니다 (.env.local).', 503);
  return `Key ${id}:${secret}`;
}

async function hf<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: authHeader(), 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HiggsfieldError(`Higgsfield 호출 실패 (HTTP ${res.status}): ${body.slice(0, 300)}`, res.status);
  }
  return (await res.json()) as T;
}

/**
 * 1장당 크레딧 소모량.
 *
 * 운영자 실사용 기준 Soul 1장 = 약 2크레딧. 모델·해상도에 따라 달라지므로 env 로 조정한다.
 * 플랫폼 REST 에는 잔액 조회 엔드포인트가 없어(생성 API 만 노출) 앱은 로컬 카운터로
 * 추적하고, 실제 값은 화면의 '동기화' 로 맞춘다.
 */
export const CREDITS_PER_IMAGE = Number(process.env.HIGGSFIELD_CREDITS_PER_IMAGE) || 2;

/** Soul 이 받는 고정 해상도 프리셋 (API 가 이 문자열만 허용) */
const WH_PRESETS: string[] = [
  '2048x2048', '1536x1536',
  '2048x1152', '1152x2048',
  '2048x1536', '1536x2048',
  '2016x1344', '1344x2016',
  '1696x960', '960x1696',
  '1536x1152', '1152x1536',
  '1632x1088', '1088x1632',
  '1680x1120', '1120x1680',
];

/** 목표 비율에 가장 가까운 프리셋 — 비율은 곱셈 스케일이라 로그 거리로 고른다 */
export function pickWidthAndHeight(aspect: string): string {
  const [aw, ah] = aspect.split(':').map(Number);
  const target = aw && ah ? aw / ah : 1;
  let best = WH_PRESETS[0];
  let bestDiff = Infinity;
  for (const wh of WH_PRESETS) {
    const [w, h] = wh.split('x').map(Number);
    const diff = Math.abs(Math.log(w / h / target));
    if (diff < bestDiff) { bestDiff = diff; best = wh; }
  }
  return best;
}

/** 공개 URL 을 Higgsfield 스토리지로 가져와 media_id 를 받는다 */
export async function importMedia(url: string): Promise<string | null> {
  try {
    const j = await hf<{ media_id?: string; id?: string }>('/v1/media/import', {
      method: 'POST',
      body: JSON.stringify({ url, type: 'image' }),
    });
    return j.media_id ?? j.id ?? null;
  } catch {
    return null;
  }
}

export interface HfGenerateInput {
  prompt: string;
  /** 참조 이미지 공개 URL — 순서가 프롬프트의 FIRST/SECOND 와 일치해야 한다 */
  referenceUrls: string[];
  aspect: string;
  /** 제품 Element 토큰 — 있으면 프롬프트에 <<<id>>> 로 심어 제품 정확도를 높인다 */
  elementId?: string;
}

export interface HfGenerateResult {
  buffer: Buffer;
  mimeType: string;
  model: string;
  jobId: string;
  elapsedMs: number;
  usedElement: boolean;
}

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 180_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function generateImage(input: HfGenerateInput): Promise<HfGenerateResult> {
  const model = process.env.HIGGSFIELD_IMAGE_MODEL || 'soul';
  const t0 = Date.now();

  // 참조 등록 — 실패한 건 건너뛰되, 순번이 어긋나므로 호출부가 프롬프트를 다시 쓰게 알린다
  const mediaIds: string[] = [];
  for (const url of input.referenceUrls) {
    const id = await importMedia(url);
    if (id) mediaIds.push(id);
  }

  // Element 토큰은 프롬프트 본문에 심는다 (백엔드가 이미지로 치환)
  const prompt = input.elementId
    ? input.prompt.replace(/^PRODUCT — /m, `PRODUCT — <<<${input.elementId}>>> `)
    : input.prompt;

  const job = await hf<{ id?: string; job_id?: string }>(`/v1/text2image/${model}`, {
    method: 'POST',
    body: JSON.stringify({
      params: {
        prompt,
        width_and_height: pickWidthAndHeight(input.aspect),
        ...(mediaIds.length ? { input_images: mediaIds.map((id) => ({ type: 'media_input', id })) } : {}),
      },
    }),
  });
  const jobId = job.id ?? job.job_id;
  if (!jobId) throw new HiggsfieldError('생성 잡 ID 를 받지 못했습니다.', 502);

  // 폴링 — 이미지는 보통 10~30초
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const st = await hf<{ status?: string; results?: { rawUrl?: string; raw_url?: string }; error?: string }>(`/v1/jobs/${jobId}`);
    const status = String(st.status ?? '');
    if (status === 'nsfw') throw new HiggsfieldError('콘텐츠가 안전필터(NSFW)로 차단됐습니다.', 422);
    if (status === 'failed' || status === 'canceled') {
      throw new HiggsfieldError(`생성 실패 (${status})${st.error ? `: ${st.error}` : ''}`, 502);
    }
    if (status === 'completed') {
      const url = st.results?.rawUrl ?? st.results?.raw_url;
      if (!url) throw new HiggsfieldError('완료됐지만 결과 URL 이 없습니다.', 502);
      const img = await fetch(url);
      if (!img.ok) throw new HiggsfieldError(`결과 다운로드 실패 (${img.status})`, 502);
      return {
        buffer: Buffer.from(await img.arrayBuffer()),
        mimeType: img.headers.get('content-type') || 'image/png',
        model,
        jobId,
        elapsedMs: Date.now() - t0,
        usedElement: !!input.elementId,
      };
    }
  }
  throw new HiggsfieldError('생성 대기 시간이 초과됐습니다.', 504);
}
