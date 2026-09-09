import { NextResponse } from 'next/server';
import { generateImage, loadReference } from '@/lib/gemini';
import { uploadBuffer, dailySubpath, ftpConfigured } from '@/lib/ftp';
import { sliceSheet } from '@/lib/sheet-slice';
import { CAMERA_MOVES, type Shot } from '@/lib/video-storyboard';

/**
 * 콘티 시트 한 장 만들기 — 전체 컷을 한 화면에 늘어놓고, 칸별로 잘라 각 컷에 붙인다.
 *
 * 왜 통 이미지를 먼저 만드는가: 컷을 하나씩 뽑으면 서로 다른 방·다른 조명·다른 사람이
 * 되기 쉽다. 한 장 안에 같이 그리게 하면 모델이 스스로 톤과 인물을 맞춘다 — 얼굴
 * 턴어라운드 시트를 한 장으로 뽑는 것과 같은 이유다.
 *
 * ⚠️ 이 시트는 '확인용' 이다. 4K 한 장을 5칸으로 나누면 칸당 800px 남짓이라
 *    영상 시작 프레임으로 쓰기엔 작다. 승인 뒤 컷별로 다시 크게 뽑는 게 맞다.
 *
 * POST { shots, aspect, productLabel?, modelLabel?, styleRef? }
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** 시트 한 장에 몇 칸까지 — 그 이상은 칸이 너무 좁아 알아볼 수 없다 */
const MAX_PANELS = 6;

const CAMERA_EN: Record<string, string> = {
  '고정 (움직임 없음)': 'locked-off static framing',
  '천천히 들어가기 (푸시 인)': 'framed for a slow push-in',
  '천천히 물러나기 (풀 백)': 'wide, framed for a pull-back',
  '왼쪽에서 오른쪽으로 (팬)': 'framed for a left-to-right pan',
  '아래에서 위로 (틸트 업)': 'low framing for a tilt-up',
  '제품 주위를 도는 궤도 (오빗)': 'framed for an orbit around the product',
  '손에 든 듯 가볍게 흔들림': 'handheld framing',
};

export async function POST(req: Request) {
  try {
    if (!ftpConfigured()) {
      return NextResponse.json({ ok: false, error: 'FTP 설정이 없습니다 (.env.local).' }, { status: 500 });
    }
    const b = (await req.json()) as {
      shots?: Shot[]; aspect?: string; productLabel?: string; modelLabel?: string; styleRef?: string;
    };
    const all = Array.isArray(b.shots) ? b.shots.filter((s) => s?.scene?.trim()) : [];
    if (!all.length) {
      return NextResponse.json({ ok: false, error: '컷이 없습니다. 먼저 시나리오로 컷을 나눠주세요.' }, { status: 400 });
    }
    // 칸이 많아지면 하나하나가 알아볼 수 없게 작아진다 — 앞에서부터 자른다
    const shots = all.slice(0, MAX_PANELS);
    const dropped = all.length - shots.length;
    const n = shots.length;

    const product = String(b.productLabel ?? '').trim();
    const model = String(b.modelLabel ?? '').trim();

    const panelLines = shots.map((s, i) => {
      const cam = CAMERA_EN[s.camera] ?? CAMERA_MOVES[0];
      return `PANEL ${i + 1} (${s.seconds}s) — ${s.scene}${s.action ? ` / 이 컷에서 일어나는 일: ${s.action}` : ''} · ${cam}`;
    });

    const prompt = [
      `STORYBOARD SHEET — ${n} panels side by side in ONE image, evenly divided, separated by thin white gutters.`,
      `Each panel is one shot of the same short film, in order left to right. Vertical ${b.aspect ?? '9:16'} framing inside each panel.`,
      '',
      'PANELS (in Korean, translate faithfully into the image):',
      ...panelLines,
      '',
      'CONSISTENCY ACROSS ALL PANELS — this is the point of drawing them together:',
      model
        ? `- The SAME person (${model}) appears wherever a person is described. Same face, same hair, same outfit in every panel.`
        : '- If a person appears, it is the same person in every panel — same face, same hair, same outfit.',
      product
        ? `- The Yogibo ${product} keeps its exact real shape and colour in every panel. It never deflates, flattens or deforms; a person sinking into it compresses it naturally without it losing volume.`
        : '- Any furniture keeps a consistent shape and colour across panels.',
      '- Same apartment/space, same time of day, same colour grade and grain across all panels.',
      '- Photorealistic. Real room, real light. Not illustration, not sketch, not comic art.',
      '',
      'ABSOLUTELY NO TEXT: no panel numbers, no captions, no timecodes, no logos, no watermarks anywhere in the image.',
      'Leave clean white gutters between panels so the sheet can be cut apart afterwards.',
    ].join('\n');

    // 스타일 레퍼런스가 있으면 톤을 그쪽에 맞춘다 (실촬영 베이스가 품질이 제일 좋다)
    const references = [];
    if (b.styleRef) {
      const img = await loadReference(b.styleRef, 1024);
      if (img) references.push(img);
    }

    const gen = await generateImage({
      prompt,
      references,
      // 가로로 긴 시트라야 칸이 세로로 선다
      aspect: '21:9',
      size: '4K',
    });

    const iso = new Date().toISOString();
    const stamp = iso.replace(/[-:T]/g, '').slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 7);
    const sub = dailySubpath(iso);

    const sheetUrl = await uploadBuffer(sub, `sheet_${stamp}_${rand}.jpg`, gen.buffer);

    // 칸별로 잘라 각 컷의 시작 프레임 후보로 올린다
    const panels = await sliceSheet(gen.buffer, n);
    const panelUrls: string[] = [];
    for (let i = 0; i < panels.length; i++) {
      panelUrls.push(await uploadBuffer(sub, `sheet_${stamp}_${rand}_p${i + 1}.jpg`, panels[i].buffer));
    }

    return NextResponse.json({
      ok: true,
      sheetUrl,
      panels: panelUrls,
      panelCount: panels.length,
      dropped,
      note: dropped > 0
        ? `칸이 좁아지지 않게 앞 ${n}컷만 시트에 담았습니다 (나머지 ${dropped}컷은 따로 뽑아주세요).`
        : '',
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
