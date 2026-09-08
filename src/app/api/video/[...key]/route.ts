import { siteOrigin } from '@/lib/ftp';

/**
 * GET /api/video/<사이트 경로>  — 예: /api/video/web/design/video/fam3_final.jpg
 *
 * cafe24 는 .mp4 업로드를 막는다. 그래서 영상은 .jpg 로 위장해 올리고,
 * 브라우저에는 여기서 video/mp4 로 바꿔 흘려보낸다 (youtube 프로젝트와 같은 방식).
 * Range 요청을 그대로 넘겨서 탐색(스크럽)도 동작한다.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key } = await params;
  const path = (Array.isArray(key) ? key.join('/') : String(key || '')).replace(/^\/+/, '');
  // 우리 사이트 안쪽만 — 임의 주소를 대신 받아오는 통로가 되면 안 된다
  if (!path || !/^web\//.test(path) || path.includes('..')) {
    return new Response('not found', { status: 404 });
  }

  const origin = siteOrigin();
  if (!origin) return new Response('ftp not configured', { status: 500 });

  const range = req.headers.get('range');
  const upstream = await fetch(`${origin}/${path}`, {
    headers: range ? { range } : {},
    cache: 'no-store',
  }).catch(() => null);
  if (!upstream || (!upstream.ok && upstream.status !== 206)) {
    return new Response('upstream error', { status: 502 });
  }

  const headers = new Headers();
  headers.set('Content-Type', 'video/mp4');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=86400');
  const len = upstream.headers.get('content-length');
  if (len) headers.set('Content-Length', len);
  const cr = upstream.headers.get('content-range');
  if (cr) headers.set('Content-Range', cr);

  return new Response(upstream.body, { status: upstream.status, headers });
}
