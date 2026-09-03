import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * dev 서버를 폰트 설정을 물린 채로 띄운다.
 *
 * 왜 스크립트가 필요한가: 배너 글자를 그리는 fontconfig 는 C 런타임의 getenv 로
 * 환경변수를 읽는데, Windows 에서는 프로세스가 뜬 뒤 JS 로 바꾼 process.env 가
 * getenv 에 보이지 않는다 (CRT 가 시작 때 복사해둔 것만 본다). 그래서 로컬에서는
 * 서버를 **띄우기 전에** FONTCONFIG_FILE 을 걸어야 저장소의 Pretendard 가 쓰인다.
 *
 * 리눅스(Vercel)는 setenv→getenv 가 통해서 src/lib/fonts.ts 의 로드 시점 등록만으로
 * 충분하다 — 이 스크립트는 로컬 개발 전용이다.
 *
 * conf 내용은 src/lib/fonts.ts 와 같은 것을 만든다 (경로도 같아서 둘 중 누가
 * 먼저 써도 무방하다).
 */
const fontDir = join(process.cwd(), 'fonts').split(String.fromCharCode(92)).join('/');
const confDir = join(tmpdir(), 'imgcreate-fontconfig');
const cacheDir = join(confDir, 'cache');
mkdirSync(cacheDir, { recursive: true });
const conf = join(confDir, 'fonts.conf');
writeFileSync(conf, [
  '<?xml version="1.0"?>',
  '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
  '<fontconfig>',
  `  <dir>${fontDir}</dir>`,
  // PC 에 깔린 폰트도 배너 렌더에 쓴다 (포토샵 방식 편집기의 폰트 선택용, 로컬 전용)
  '  <dir>C:/Windows/Fonts</dir>',
  `  <cachedir>${cacheDir.split(String.fromCharCode(92)).join('/')}</cachedir>`,
  '</fontconfig>',
  '',
].join('\n'));

const child = spawn('npx', ['next', 'dev', '-p', '6100'], {
  stdio: 'inherit',
  shell: true,                                   // 윈도에서 npx 를 찾으려면 필요하다
  env: { ...process.env, FONTCONFIG_FILE: conf },
});
child.on('exit', (code) => process.exit(code ?? 0));
