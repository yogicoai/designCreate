import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * fonts/ 폴더의 글꼴 파일을 브라우저에 내준다.
 *
 * 서버 렌더는 fontconfig 가 fonts/ 를 직접 읽지만, 작업 화면(브라우저)은
 * 같은 파일을 @font-face 로 받아야 화면과 저장본의 글자가 일치한다.
 * fonts/ 는 public 이 아니라서 이 통로가 필요하다 — 유료 폰트를 public 에
 * 두면 아무나 긁어갈 수 있어서 일부러 밖에 두지 않는다.
 * (이 통로도 앱 사용자에게는 열려 있다 — 사내 도구라는 전제)
 */

export const runtime = 'nodejs';

const FONT_DIR = join(process.cwd(), 'fonts');

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ file: string }> },
) {
  const { file } = await ctx.params;
  // 경로 탈출 방지 — 파일 이름 글자만 허용한다
  if (!/^[A-Za-z0-9._ -]+[.](ttf|otf)$/i.test(file) || file.includes('..')) {
    return NextResponse.json({ ok: false, error: '잘못된 파일 이름' }, { status: 400 });
  }
  const full = join(FONT_DIR, file);
  if (!existsSync(full)) {
    return NextResponse.json({ ok: false, error: '없는 글꼴' }, { status: 404 });
  }
  const buf = readFileSync(full);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      'content-type': file.toLowerCase().endsWith('.otf') ? 'font/otf' : 'font/ttf',
      // 글꼴은 안 바뀌는 파일 — 브라우저가 오래 들고 있어도 된다
      'cache-control': 'public, max-age=86400, immutable',
    },
  });
}
