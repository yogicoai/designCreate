import { zipSync, strToU8 } from 'fflate';
import { colorSwatch, loadReference } from '@/lib/gemini';

/**
 * POST /api/test-kit — 수동 비교 테스트용 ZIP.
 *
 * 우리 파이프라인과 ChatGPT·Gemini 앱을 동등 비교하려면 "같은 프롬프트 + 같은 참조 이미지를
 * 같은 순서로" 넣어야 한다. 프롬프트가 FIRST/SECOND… 순번으로 참조를 가리키기 때문.
 *
 * 내용물:
 *   PROMPT.txt        — 프롬프트 전문 + 첨부 순서 + 생성 설정
 *   01_base.jpg …     — 참조 이미지 (순번 접두, ASCII 파일명)
 *   NN_swatch.png     — 컬러 스와치 (서버에서 hex 로 생성)
 */

export const runtime = 'nodejs';

interface RefIn { kind: string; title: string; url?: string; swatchHex?: string }
interface Body { prompt?: string; refs?: RefIn[]; aspect?: string; target?: { width: number; height: number }; label?: string }

const ORD = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH', 'NINTH', 'TENTH', 'ELEVENTH', 'TWELFTH', 'THIRTEENTH', 'FOURTEENTH'];

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const refs = body.refs ?? [];
    if (!body.prompt || !refs.length) {
      return new Response(JSON.stringify({ ok: false, error: '프롬프트와 참조 목록이 필요합니다.' }), { status: 400 });
    }

    const files: Record<string, Uint8Array> = {};
    const manifest: string[] = [];

    for (let i = 0; i < refs.length; i++) {
      const r = refs[i];
      const num = String(i + 1).padStart(2, '0');
      let data: Uint8Array | null = null;
      let name = '';
      if (r.swatchHex) {
        const sw = await colorSwatch(r.swatchHex);
        data = Buffer.from(sw.data, 'base64');
        name = `${num}_${r.kind}_${r.swatchHex.replace('#', '')}.png`;
      } else if (r.url) {
        // 수동 테스트는 원본 해상도가 유리 — 참조 축소 없이 받되, 너무 크면 2048 로
        const img = await loadReference(r.url, 2048);
        if (img) {
          data = Buffer.from(img.data, 'base64');
          name = `${num}_${r.kind}.jpg`;
        }
      }
      if (data) {
        files[name] = data;
        manifest.push(`${ORD[i] ?? i + 1}  →  ${name}   (${r.title})`);
      } else {
        manifest.push(`${ORD[i] ?? i + 1}  →  (다운로드 실패: ${r.title})`);
      }
    }

    const readme = [
      `# 수동 비교 테스트 키트${body.label ? ` — ${body.label}` : ''}`,
      '',
      '## 사용법',
      '1. ChatGPT 또는 Gemini 앱에 아래 이미지들을 **번호 순서대로** 첨부한다.',
      '2. 그 다음 아래 프롬프트를 그대로 붙여넣는다.',
      `3. 비율은 ${body.aspect ?? '?'} 로 지정한다${body.target ? ` (최종 목표 ${body.target.width}×${body.target.height} — 우리 파이프라인은 생성 후 이 크기로 크롭함)` : ''}.`,
      '',
      '## 첨부 순서',
      ...manifest,
      '',
      '## 프롬프트',
      body.prompt,
      '',
    ].join('\n');
    files['PROMPT.txt'] = strToU8(readme);

    const zipped = zipSync(files, { level: 6 });
    return new Response(Buffer.from(zipped), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="imgcreate-test-kit.zip"`,
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500 });
  }
}
