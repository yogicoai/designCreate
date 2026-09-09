import { NextResponse } from 'next/server';
import sharp from 'sharp';

/**
 * 생성물 내려받기 — 원하는 확장자로 바꿔서 준다.
 *
 * 서버에는 JPEG 로 올라가 있지만, 쓰는 곳마다 요구가 다르다:
 *   webp — 웹 게시용. 같은 화질에 파일이 가장 작다
 *   png  — 편집·인쇄 전달용. 손실이 없다
 *   jpg  — 그대로
 *
 * GET /api/download?url=<우리 서버 이미지>&format=webp|png|jpg&name=파일이름
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TYPES: Record<string, string> = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg' };

export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams;
    const src = q.get('url') ?? '';
    const format = (q.get('format') ?? 'jpg').toLowerCase();
    if (!TYPES[format]) {
      return NextResponse.json({ ok: false, error: '지원하지 않는 형식입니다.' }, { status: 400 });
    }

    // 우리 자산만 — 임의 주소를 대신 받아오는 통로가 되면 안 된다
    let host = '';
    try { host = new URL(src).hostname; } catch { /* 아래에서 걸린다 */ }
    if (!host || !(host.endsWith('cafe24.com') || host.endsWith('yogibo.kr'))) {
      return NextResponse.json({ ok: false, error: '우리 서버의 이미지만 내려받을 수 있습니다.' }, { status: 400 });
    }

    const up = await fetch(src, { cache: 'no-store' });
    if (!up.ok) return NextResponse.json({ ok: false, error: `원본을 못 받았습니다 (${up.status})` }, { status: 502 });
    const raw = Buffer.from(await up.arrayBuffer());

    /*
     * 형식만 바꾼다 — 크기·화질은 건드리지 않는다. 인쇄용(A1·A3)으로 뽑은 것을
     * 내려받으면서 줄어들면 인쇄가 깨진다.
     */
    const img = sharp(raw);
    const out = format === 'webp' ? await img.webp({ quality: 92 }).toBuffer()
      : format === 'png' ? await img.png({ compressionLevel: 9 }).toBuffer()
        : await img.jpeg({ quality: 95 }).toBuffer();

    const base = (q.get('name') || src.split('/').pop() || 'image').replace(/\.[a-z0-9]+$/i, '');
    // 파일명에 한글이 있어도 깨지지 않게 RFC 5987 로 같이 준다
    const ascii = base.replace(/[^\w.-]/g, '_') || 'image';
    return new NextResponse(new Uint8Array(out), {
      headers: {
        'Content-Type': TYPES[format],
        'Content-Length': String(out.length),
        'Content-Disposition':
          `attachment; filename="${ascii}.${format}"; filename*=UTF-8''${encodeURIComponent(base)}.${format}`,
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
