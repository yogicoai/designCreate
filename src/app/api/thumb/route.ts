import sharp from 'sharp';
import { THUMB_HOSTS, THUMB_WIDTHS } from '@/lib/thumb';

/**
 * 목록용 썸네일 — cafe24 원본을 받아 작게 줄여 돌려준다. src/lib/thumb.ts 의 thumbUrl() 이 이 주소를 만든다.
 *
 * 왜 Next 이미지 최적화(/_next/image)가 아닌가 (2026-09-22):
 *   배포 사이트(Vercel 무료 요금제)의 이미지 변환 월 한도를 다 써서 /_next/image 가
 *   402 OPTIMIZED_IMAGE_REQUEST_PAYMENT_REQUIRED 를 돌려줬다 — 한 번도 안 불린 사진이 보관함에서 전부 엑박.
 *   드롭박스 1만1천 장 + 레퍼런스 3천6백 장을 목록으로 훑으면 한도가 금방 찬다. 같은 일을 우리 함수가 sharp 로 한다.
 *
 * 캐시: 결과는 CDN 이 1년 둔다. cafe24 파일은 덮어쓰지 않고 늘 새 이름으로 올리므로(프로젝트 규칙) 주소가 같으면 내용도 같다.
 * 실패: 줄이기에 실패하면 원본 주소로 넘긴다 — 엑박보다 느린 게 낫다. 원본 자체가 없으면(404) 그대로 실패를 돌려준다.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 레퍼런스 원본은 장당 수 MB 라 첫 변환이 16초까지 걸렸다(로컬 실측) — 원본 대기 45초 + 여유
export const maxDuration = 60;

const CACHE = 'public, max-age=31536000, s-maxage=31536000, immutable';

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const w = Number(sp.get('w'));
  let src: URL;
  try {
    src = new URL(sp.get('url') || '');
  } catch {
    return new Response('url 이 올바르지 않습니다', { status: 400 });
  }
  // 아무 주소나 받아 주면 남의 서버를 대신 긁는 통로가 된다 — 우리 호스팅·허용 폭만
  if (src.protocol !== 'https:' || !THUMB_HOSTS.has(src.hostname) || !THUMB_WIDTHS.has(w)) {
    return new Response('허용되지 않은 주소 또는 폭입니다', { status: 400 });
  }

  let buf: Buffer;
  try {
    const up = await fetch(src, { signal: AbortSignal.timeout(45000) });
    if (!up.ok) return new Response(`원본 응답 ${up.status}`, { status: up.status === 404 ? 404 : 502, headers: { 'Cache-Control': 'no-store' } });
    buf = Buffer.from(await up.arrayBuffer());
  } catch {
    return new Response('원본을 가져오지 못했습니다', { status: 504, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const out = await sharp(buf, { failOn: 'none' })
      .rotate() // 폰 사진의 EXIF 회전을 반영
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();
    return new Response(new Uint8Array(out), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': CACHE } });
  } catch {
    return Response.redirect(src.toString(), 302);
  }
}
