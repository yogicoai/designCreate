import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 배너 렌더가 저장소에 담아둔 Pretendard 를 쓰게 만든다.
 *
 * 배너의 글자는 sharp(librsvg)가 그리는데, librsvg 는 fontconfig 로 폰트를 찾는다.
 * 로컬 Windows 는 맑은고딕이 있어서 그냥도 되지만 Vercel 리눅스에는 한글 폰트가
 * 하나도 없다 — 손보지 않고 배포하면 배너 글자가 전부 □ 로 나온다.
 *
 * instrumentation 이 아니라 **모듈 로드 시점의 부수효과**로 건다. dev 서버는
 * 라우트를 별도 워커 프로세스에서 돌리기도 해서, 서버 시작 프로세스에서 env 를
 * 세워봐야 렌더하는 프로세스에는 안 보인다 (실측: conf 는 만들어졌는데 렌더는
 * 시스템 폰트 그대로였다). 이 파일을 렌더하는 라우트가 첫 import 로 불러오면
 * 어느 프로세스에서 돌든 첫 글자 렌더 전에 걸린다.
 *
 * fonts.conf 의 <dir> 은 절대 경로여야 안전한데 배포 경로는 빌드 때 알 수 없다.
 * 그래서 로드 시점에 임시 폴더에 conf 를 만들어 물린다.
 */
const fontDir = join(process.cwd(), 'fonts');

if (!existsSync(join(fontDir, 'PretendardVariable.ttf'))) {
  console.warn('[fonts] fonts/PretendardVariable.ttf 가 없습니다 — 시스템 폰트로 그립니다 (배포에선 한글이 깨질 수 있음)');
} else if (!process.env.FONTCONFIG_FILE) {
  const confDir = join(tmpdir(), 'imgcreate-fontconfig');
  const cacheDir = join(confDir, 'cache');
  mkdirSync(cacheDir, { recursive: true });

  // fontconfig XML 은 윈도 경로도 슬래시로 적어야 한다
  const slash = (p: string) => p.split(String.fromCharCode(92)).join('/');   // 92 = 백슬래시 (리터럴로 쓰면 셸 경유 시 깨져서 코드로 만든다)
  const conf = join(confDir, 'fonts.conf');
  writeFileSync(conf, [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
    '<fontconfig>',
    `  <dir>${slash(fontDir)}</dir>`,
    `  <cachedir>${slash(cacheDir)}</cachedir>`,
    '</fontconfig>',
    '',
  ].join('\n'));

  process.env.FONTCONFIG_FILE = conf;
}

export {};
