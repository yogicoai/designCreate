'use client';

/**
 * 업로드 전 브라우저에서 이미지를 줄인다.
 *
 * Vercel 은 요청 본문을 4.5MB 로 제한한다. 원본을 그대로 보내면 큰 사진(11MB+)이
 * 서버에 닿기도 전에 막힌다. 레퍼런스는 조명·색감·구도를 보는 용도라 2048px 면 충분하다.
 *
 * eventTemp/src/lib/image-upload.ts 의 shrinkToBudget 과 같은 접근 —
 * 해상도를 먼저 줄이고, 그래도 크면 품질을 단계적으로 낮춘다.
 */

/** multipart 오버헤드까지 감안한 목표치. 서버 라우트는 4MB 에서 거절한다. */
const TARGET_BYTES = 3 * 1024 * 1024;
const MAX_SIDE = 2048;

export interface ShrinkResult {
  file: File;
  originalBytes: number;
  bytes: number;
  width: number;
  height: number;
}

async function encode(bitmap: ImageBitmap, scale: number, quality: number): Promise<Blob | null> {
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // 투명 PNG 가 JPEG 로 갈 때 검게 되지 않도록 흰 배경을 먼저 깐다
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}

/**
 * 파일을 3MB 이하 JPEG 로 줄인다. 이미 작으면 그대로 돌려준다.
 * 디코드에 실패하면(특이 포맷) 원본을 그대로 반환 — 서버가 판단하게 둔다.
 */
export async function shrinkForUpload(file: File): Promise<ShrinkResult> {
  const originalBytes = file.size;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { file, originalBytes, bytes: originalBytes, width: 0, height: 0 };
  }

  const baseScale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (originalBytes < TARGET_BYTES && baseScale === 1) {
    bitmap.close?.();
    return { file, originalBytes, bytes: originalBytes, width: bitmap.width, height: bitmap.height };
  }

  const name = file.name.replace(/\.(png|jpe?g|webp|gif|avif|heic|heif)$/i, '') + '.jpg';
  const attempts: [number, number][] = [
    [baseScale, 0.88],
    [baseScale, 0.78],
    [baseScale * 0.8, 0.78],
    [baseScale * 0.65, 0.75],
    [baseScale * 0.5, 0.72],
    [baseScale * 0.4, 0.68],
    [baseScale * 0.3, 0.6],
  ];

  let smallest: Blob | null = null;
  for (const [scale, quality] of attempts) {
    const blob = await encode(bitmap, scale, quality);
    if (!blob) continue;
    if (!smallest || blob.size < smallest.size) smallest = blob;
    if (blob.size < TARGET_BYTES) {
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      bitmap.close?.();
      return { file: new File([blob], name, { type: 'image/jpeg' }), originalBytes, bytes: blob.size, width: w, height: h };
    }
  }

  bitmap.close?.();
  if (smallest) {
    return { file: new File([smallest], name, { type: 'image/jpeg' }), originalBytes, bytes: smallest.size, width: 0, height: 0 };
  }
  return { file, originalBytes, bytes: originalBytes, width: 0, height: 0 };
}

export function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;
}
