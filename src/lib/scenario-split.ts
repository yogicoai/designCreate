import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { CAMERA_MOVES, type Shot } from './video-storyboard';

/**
 * 시나리오 한 덩어리를 컷으로 나눈다 — 영화 연출부가 콘티를 끊는 일.
 *
 * 지금까지의 `draftShots()` 는 용도(제품·후기·이벤트)마다 정해진 뼈대를 뱉었다.
 * 그건 "무엇을 찍을지" 를 사람이 이미 정해둔 경우에나 쓸모가 있고, 글로 쓴 시나리오를
 * 주고 "알아서 나눠줘" 라고 하면 못 한다. 그건 판단이라 모델이 해야 한다.
 *
 * 컷마다 필요한 것:
 *   scene  — 시작 프레임에 무엇이 보이는가 (스틸 생성 지시가 된다)
 *   action — 그 컷 안에서 무엇이 바뀌는가 (끝 프레임 파생 지시가 된다)
 *   camera — 우리가 쓰는 7가지 중 하나 (엔진에 넣을 영어로 이미 매핑돼 있다)
 *   seconds — 합이 총 길이와 맞아야 한다
 */

export interface SplitInput {
  /** 사람이 쓴 시나리오 — 형식 자유 */
  scenario: string;
  /** 총 길이(초) */
  total: number;
  aspect: string;
  /** 있으면 컷 서술에 자연스럽게 녹인다 */
  productLabel?: string;
  modelLabel?: string;
}

export interface SplitResult {
  shots: Shot[];
  /** 연출 의도 한 줄 — 콘티 맨 아래 메모로 들어간다 */
  intent: string;
}

const SYSTEM = `You are a commercial film director breaking a client's scenario into a shot list for a short vertical ad.

You work for Yogibo Korea (bean bag furniture). The shots you write are turned into still frames by an image model, then animated between a START and an END frame by a video model. So each shot must be describable as two moments: what the frame shows at the start, and what has changed by the end.

RULES
- Return ONLY valid JSON. No markdown fence, no commentary.
- Shot durations must sum to exactly the requested total.
- Default to 3-5 second shots. A 2-second shot barely registers on its own.
- BUT the scenario wins. If it asks for a fast cut rhythm, many quick beats, a montage, or names a number of shots, follow it — short beats are the point there, and 1.5-2s cuts are correct. Read what the scenario is trying to do before deciding the pace.
- A 15-second spot is usually 4-6 shots at a calm pace, or 7-10 when the scenario asks for rhythm.
- Each shot's "scene" describes the START frame as a photograph: who is where, what is visible, the light. Written in Korean.
- Each shot's "action" describes only what CHANGES from start to end, in Korean. Use "→" between the two states.
- "camera" MUST be copied verbatim from the provided list. Do not invent camera moves.
- Never put text, captions, logos or watermarks in a shot description.
- The product must never be crushed, deflated or deformed. If the product appears, it holds its real shape.
- Write for a real room with real light. No studio backdrops unless the scenario asks for one.

JSON SHAPE
{"intent":"<연출 의도 한 줄, 한국어>","shots":[{"no":1,"seconds":4,"scene":"...","action":"... → ...","camera":"<list 에서 그대로>"}]}`;

/** 모델이 헛디딜 때를 대비한 보정 — 카메라·초는 우리가 쓰는 값이어야 한다 */
function normalize(raw: unknown, total: number): Shot[] {
  const arr = Array.isArray(raw) ? raw : [];
  const shots: Shot[] = arr.slice(0, 12).map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const cam = String(o.camera ?? '');
    return {
      no: i + 1,
      seconds: Math.max(1, Math.min(30, Number(o.seconds) || 3)),
      scene: String(o.scene ?? '').slice(0, 400),
      action: String(o.action ?? '').slice(0, 400),
      // 목록에 없는 카메라가 오면 가장 무난한 '고정' 으로 되돌린다
      camera: CAMERA_MOVES.includes(cam) ? cam : CAMERA_MOVES[0],
      chain: i > 0,
    };
  }).filter((s) => s.scene);

  if (!shots.length) return shots;

  /*
   * 길이 합을 총 길이에 맞춘다. 모델이 대체로 맞춰 오지만 1~2초씩 어긋날 때가 있고,
   * 그대로 두면 콘티의 시간 표기가 실제 영상과 안 맞는다.
   */
  const sum = shots.reduce((a, s) => a + s.seconds, 0);
  if (sum > 0 && Math.abs(sum - total) > 0.05) {
    const k = total / sum;
    let acc = 0;
    shots.forEach((s, i) => {
      if (i === shots.length - 1) {
        s.seconds = Math.max(1, Math.round((total - acc) * 10) / 10);
      } else {
        s.seconds = Math.max(1, Math.round(s.seconds * k * 10) / 10);
        acc += s.seconds;
      }
    });
  }
  return shots;
}

export async function splitScenario(i: SplitInput): Promise<SplitResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('컷 나누기는 ANTHROPIC_API_KEY 가 있어야 합니다.');
  }
  const client = new Anthropic();

  const brief = [
    `SCENARIO (한국어, 클라이언트가 쓴 그대로):`,
    i.scenario.trim(),
    '',
    `TOTAL LENGTH: ${i.total} seconds`,
    `ASPECT: ${i.aspect}`,
    i.productLabel ? `PRODUCT IN FRAME: Yogibo ${i.productLabel}` : 'PRODUCT: none specified',
    i.modelLabel ? `PERSON: our contracted model ${i.modelLabel} — same person throughout` : 'PERSON: none unless the scenario asks for one',
    '',
    'ALLOWED CAMERA VALUES (copy verbatim):',
    ...CAMERA_MOVES.map((c) => `- ${c}`),
  ].join('\n');

  const res = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
    max_tokens: 3000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: brief }] }],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  // 혹시 코드펜스를 씌워 오면 벗긴다
  const json = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed: { intent?: string; shots?: unknown };
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('컷 나누기 응답을 읽지 못했습니다. 시나리오를 조금 더 구체적으로 적어보세요.');
  }

  const shots = normalize(parsed.shots, i.total);
  if (!shots.length) throw new Error('컷을 만들지 못했습니다. 시나리오를 조금 더 구체적으로 적어보세요.');

  return { shots, intent: String(parsed.intent ?? '').slice(0, 300) };
}
