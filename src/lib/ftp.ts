import 'server-only';
import { Client } from 'basic-ftp';
import { Readable } from 'node:stream';

/**
 * Cafe24 FTP 업로드 — 생성물과 사용자가 올린 레퍼런스를 영구 공개 URL 로 만든다.
 *
 * youtube/src/lib/ftp.js 의 패턴 + eventTemp/api/ftp 의 파일명 정제를 합친 것.
 *
 * ⚠️ cafe24 nginx 는 비-ASCII 파일명을 EUC-KR 로 디코드해서 매칭에 실패한다(403).
 *    한글이 섞인 이름은 반드시 ASCII 로 바꿔서 올려야 한다.
 * ⚠️ cafe24 는 .mp4 업로드를 막는다. 이미지만 다루므로 이 앱에선 문제가 없다.
 */

const HOST = (process.env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, '').replace(/\/$/, '');
const PORT = Number(process.env.FTP_PORT) || 21;
const USER = process.env.FTP_USER || '';
const PASS = process.env.FTP_PASS || '';
const ROOT = (process.env.FTP_REMOTE_DIR || '/web/img/imgc').replace(/^\/|\/$/g, '');
const PUBLIC_BASE = (process.env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');

const TIMEOUT_MS = 30_000;

export function ftpConfigured(): boolean {
  return !!(HOST && USER && PASS);
}

/** 한글·공백·특수문자를 ASCII 로 — cafe24 403 회피 */
export function sanitizeFilename(raw: string): string {
  const dot = raw.lastIndexOf('.');
  const base = dot > 0 ? raw.slice(0, dot) : raw;
  const ext = dot > 0 ? raw.slice(dot + 1) : '';
  const safeBase = base
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return (safeBase || `upload_${Date.now()}`) + (safeExt ? `.${safeExt}` : '');
}

function remoteDir(subpath?: string): string {
  const sub = (subpath || '').replace(/^\/|\/$/g, '');
  return sub ? `${ROOT}/${sub}` : ROOT;
}

/** 업로드 결과 공개 URL */
export function publicUrl(subpath: string | undefined, filename: string): string {
  const sub = (subpath || '').replace(/^\/|\/$/g, '');
  // FTP_PUBLIC_BASE 는 이미 ROOT 까지 포함한 주소다
  return sub ? `${PUBLIC_BASE}/${sub}/${filename}` : `${PUBLIC_BASE}/${filename}`;
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  if (!ftpConfigured()) {
    throw new Error('FTP 설정(FTP_HOST/USER/PASS)이 없습니다. .env.local 을 확인해주세요.');
  }
  const client = new Client(TIMEOUT_MS);
  try {
    await client.access({ host: HOST, port: PORT, user: USER, password: PASS, secure: false });
    return await fn(client);
  } finally {
    client.close();
  }
}

/**
 * 버퍼를 업로드하고 공개 URL 을 반환한다.
 * @param subpath ROOT 아래 하위 폴더 (예: 'ref' | 'gen/2026-08')
 */
export async function uploadBuffer(
  subpath: string | undefined,
  filename: string,
  buffer: Buffer,
): Promise<string> {
  const safe = sanitizeFilename(filename);
  await withClient(async (c) => {
    await c.ensureDir(remoteDir(subpath)); // 디렉토리 생성 + 이동
    await c.uploadFrom(Readable.from(buffer), safe);
  });
  return publicUrl(subpath, safe);
}

/** 업로드된 파일 삭제 (없으면 조용히 넘어간다) */
export async function deleteRemote(subpath: string | undefined, filename: string): Promise<void> {
  if (!filename) return;
  try {
    await withClient(async (c) => {
      await c.remove(`${remoteDir(subpath)}/${sanitizeFilename(filename)}`);
    });
  } catch {
    // 이미 없거나 권한 없음 — 무시
  }
}

/**
 * 생성물이 들어갈 그날 날짜 폴더. 루트(/web/design) 아래 `YYYY-MM-DD` 로 나뉜다.
 * 한 폴더에 수천 장이 쌓이면 FTP 목록 조회가 느려지고 사람이 못 찾는다.
 *
 * @param isoDate ISO 날짜 문자열. 호출부에서 넘긴다 — 서버 시간대에 의존하면
 *                자정 무렵에 어제 폴더로 들어가는 사고가 난다.
 */
export function dailySubpath(isoDate: string): string {
  return isoDate.slice(0, 10); // 예: '2026-08-31'
}

/**
 * 사용자가 올린 레퍼런스가 들어갈 폴더 — /web/design/update.
 * 생성물(날짜 폴더)과 섞이면 안 된다. 원본 소스와 결과물은 구분돼야 추적이 된다.
 */
export const REF_SUBPATH = 'update';
