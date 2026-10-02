import { NextResponse } from 'next/server';
import { LOCAL_ONLY } from '@/lib/local-only';
import { headCrop } from '@/lib/series-check';

/**
 * GET /api/qc/head?id=<컷 id>&code=<모델 코드> — 그 컷에서 그 모델의 얼굴 조각(192px JPEG). 로컬 전용.
 * 「생성 품질」 화면의 시리즈 일관성 줄이 쓴다. 목록 썸네일(최대 384px)로는 얼굴이 뭉개져서 원본에서 직접 자른다.
 */
export const runtime = 'nodejs';

export async function GET(req: Request) {
  if (!LOCAL_ONLY) return new NextResponse(null, { status: 404 });
  const { searchParams } = new URL(req.url);
  try {
    const buf = await headCrop(searchParams.get('id') || '', searchParams.get('code') || '');
    if (!buf) return new NextResponse(null, { status: 404 });
    return new NextResponse(new Uint8Array(buf), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
