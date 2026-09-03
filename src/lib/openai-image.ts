import 'server-only';
import type { InlineImage, GenAspect } from '@/lib/gemini';

/**
 * GPT 이미지 생성 (OpenAI gpt-image-1) — 나노바나나 옆의 두 번째 엔진.
 *
 * 한계를 알고 쓴다:
 *   - 최대 1536px (가로형 1536x1024 / 세로형 1024x1536 / 정사각 1024) — 4K 없음.
 *     그래서 화면에서 GPT 를 고르면 POP·인쇄용(4K) 선택지가 숨는다.
 *   - 참조 이미지는 edits 엔드포인트로 넣는다 (여러 장 지원).
 *
 * 비용은 OpenAI 계정에서 나간다 (장당 대략 $0.17~0.25 수준 — 참고치, 청구서 기준 확인).
 */

export function openaiConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

export class OpenAIImageError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** genAspect → gpt-image-1 이 받는 세 가지 크기 중 가장 가까운 것 */
function sizeFor(aspect: GenAspect | string): { size: string; w: number; h: number } {
  const [a, b] = String(aspect).split(':').map(Number);
  const r = a && b ? a / b : 1;
  if (r >= 1.15) return { size: '1536x1024', w: 1536, h: 1024 };
  if (r <= 0.87) return { size: '1024x1536', w: 1024, h: 1536 };
  return { size: '1024x1024', w: 1024, h: 1024 };
}

export interface GptGenerateInput {
  prompt: string;
  references: InlineImage[];
  aspect: GenAspect | string;
}

export interface GptGenerateResult {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  model: string;
  elapsedMs: number;
  requestBytes: number;
}

export async function generateImageGpt(input: GptGenerateInput): Promise<GptGenerateResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new OpenAIImageError('OPENAI_API_KEY 가 설정되지 않았습니다 (.env.local).', 503);

  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
  const { size, w, h } = sizeFor(input.aspect);
  const started = Date.now();

  let res: Response;
  let requestBytes = 0;

  if (input.references.length) {
    /*
     * 참조가 있으면 edits — 이미지들을 보고 프롬프트대로 다시 그린다.
     * (우리 파이프라인은 항상 참조 기반이라 사실상 이 경로가 기본이다)
     */
    const fd = new FormData();
    fd.append('model', model);
    fd.append('prompt', input.prompt.slice(0, 32000));
    fd.append('size', size);
    fd.append('quality', 'high');
    fd.append('n', '1');
    input.references.forEach((r, i) => {
      const buf = Buffer.from(r.data, 'base64');
      requestBytes += buf.length;
      const ext = r.mimeType.includes('png') ? 'png' : 'jpg';
      fd.append('image[]', new File([new Uint8Array(buf)], `ref${i + 1}.${ext}`, { type: r.mimeType }));
    });
    res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: fd,
    });
  } else {
    const body = JSON.stringify({ model, prompt: input.prompt.slice(0, 32000), size, quality: 'high', n: 1 });
    requestBytes = body.length;
    res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body,
    });
  }

  const text = await res.text();
  if (!res.ok) {
    let msg = `OpenAI ${res.status}`;
    try { msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message || msg; } catch { /* 원문 유지 */ }
    throw new OpenAIImageError(`GPT 이미지 생성 실패 — ${msg}`, res.status);
  }
  const json = JSON.parse(text) as { data?: { b64_json?: string }[] };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new OpenAIImageError('GPT 응답에 이미지가 없습니다.', 502);

  return {
    buffer: Buffer.from(b64, 'base64'),
    mimeType: 'image/png',
    width: w,
    height: h,
    model,
    elapsedMs: Date.now() - started,
    requestBytes,
  };
}
