import 'server-only';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 배너에서 고를 수 있는 글꼴 목록 — fonts/ 폴더를 훑어서 만든다.
 *
 * 목록을 코드에 손으로 적지 않는 이유: 산돌고딕처럼 유료 폰트를 결제해서
 * 파일을 받으면, fonts/ 에 떨어뜨리는 것만으로 선택지에 떠야 한다.
 * 가족 이름은 추측하면 안 되고(파일마다 다르다 — Pretendard 파일의 실제
 * 이름은 'Pretendard Variable' 이었다) 파일 안의 name 테이블에서 읽는다.
 *
 * 서버 렌더(fontconfig)는 이 폴더를 통째로 스캔하므로 별도 등록이 필요 없고,
 * 브라우저 미리보기는 /api/font/<파일> 로 같은 파일을 받아 @font-face 를 건다.
 */

export interface BannerFont {
  /** 파일 안 name 테이블의 가족 이름 — 렌더와 미리보기가 이 이름으로 찾는다 */
  family: string;
  /** fonts/ 안의 파일 이름 — 브라우저가 /api/font/<file> 로 받는다 */
  file: string;
}

const FONT_DIR = join(process.cwd(), 'fonts');

/** sfnt(name) 테이블에서 가족 이름을 읽는다. 조판 가족(16)이 있으면 그걸 쓴다 */
function familyOf(buf: Buffer): string | null {
  try {
    const num = buf.readUInt16BE(4);
    let off = 12;
    let name = 0;
    for (let i = 0; i < num; i++) {
      if (buf.toString('ascii', off, off + 4) === 'name') name = buf.readUInt32BE(off + 8);
      off += 16;
    }
    if (!name) return null;
    const count = buf.readUInt16BE(name + 2);
    const strOff = name + buf.readUInt16BE(name + 4);
    const got: Record<number, string> = {};
    for (let i = 0; i < count; i++) {
      const rec = name + 6 + i * 12;
      const platform = buf.readUInt16BE(rec);
      const nameId = buf.readUInt16BE(rec + 6);
      if (platform !== 3 || (nameId !== 1 && nameId !== 16)) continue;
      const len = buf.readUInt16BE(rec + 8);
      const so = buf.readUInt16BE(rec + 10);
      let str = '';
      for (let j = 0; j + 1 < len; j += 2) str += String.fromCharCode(buf.readUInt16BE(strOff + so + j));
      // 한 이름이 여러 언어로 실려 있으면 아무거나 하나면 된다
      if (!got[nameId]) got[nameId] = str;
    }
    return got[16] ?? got[1] ?? null;
  } catch {
    return null;
  }
}

/** 개발 중 파일을 넣고 바로 보이도록 캐시는 두지 않는다 — 파일 몇 개라 스캔이 싸다 */
export function listBannerFonts(): BannerFont[] {
  if (!existsSync(FONT_DIR)) return [];
  const out: BannerFont[] = [];
  const seen = new Set<string>();
  for (const file of readdirSync(FONT_DIR)) {
    if (!/[.](ttf|otf)$/i.test(file)) continue;
    const family = familyOf(readFileSync(join(FONT_DIR, file)));
    if (!family || seen.has(family)) continue;   // 같은 가족의 굵기별 파일은 하나로 묶인다
    seen.add(family);
    out.push({ family, file });
  }
  return out.sort((a, b) => a.family.localeCompare(b.family));
}
