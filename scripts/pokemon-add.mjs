/**
 * 포켓몬 작업 폴더에 이미지를 넣는다 — 대화(Claude)에서 만든 결과(힉스필드 생성물·스티커 등)를 올릴 때 쓴다.
 * 개발 서버(`next dev`, 기본 http://localhost:6100)가 떠 있어야 한다 — 축소본·투명 여부 계산을 API 가 한다.
 *
 * 사용: node scripts/pokemon-add.mjs <이미지 파일 | https://…> [옵션]
 *   --kind result|reference          넣을 곳(기본 result = 결과물)
 *   --source "#ab12,#cd34"           결과물이 나온 레퍼런스(화면의 #코드 4자리 또는 전체 id) — 카테고리도 여기서 따라간다
 *   --category c1                    카테고리(레퍼런스를 넣을 때나 --source 가 없을 때 필수)
 *   --name 이름  --note 설명
 *   힉스필드 생성 정보(결과 카드에 보인다):
 *   --model nano_banana_pro  --credits 2  --job <job id>  --prompt "…" | --prompt-file 경로  [--tool higgsfield]
 *
 * curl 대신 이 스크립트를 쓰는 이유: Windows 의 curl 은 한글 인자를 cp949 로 보내 이름·메모가 깨진다.
 * Node 는 인자를 유니코드로 받아 UTF-8 로 보낸다.
 */
import fs from 'node:fs';
import path from 'node:path';

const API = process.env.POKEMON_API || 'http://localhost:6100/api/pokemon';
const VALUE_OPTS = ['--source', '--name', '--note', '--kind', '--category', '--model', '--credits', '--job', '--prompt', '--prompt-file', '--tool'];
const args = process.argv.slice(2);
const input = args.find((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_OPTS.includes(args[i - 1])));
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] ?? '' : ''; };
const isUrl = /^https?:\/\//i.test(input || '');
if (!input || (!isUrl && !fs.existsSync(input))) {
  console.error('사용: node scripts/pokemon-add.mjs <이미지 | URL> [--kind result|reference] [--source #ab12] [--category c1] [--name 이름] [--note 설명] [--model … --credits … --prompt …]');
  process.exit(1);
}

// 이미지 — 파일이면 읽고, 힉스필드 결과 주소면 받아 온다
let bytes, fileName;
if (isUrl) {
  const res = await fetch(input);
  if (!res.ok) { console.error('내려받기 실패:', res.status); process.exit(1); }
  bytes = Buffer.from(await res.arrayBuffer());
  fileName = decodeURIComponent(new URL(input).pathname.split('/').pop() || 'image.png');
} else {
  bytes = fs.readFileSync(input);
  fileName = path.basename(input);
}

// #코드(끝 4자리)를 전체 id 로
let sources = opt('--source').split(/[\s,]+/).map((s) => s.replace(/^#/, '')).filter(Boolean);
if (sources.some((s) => !s.startsWith('pk_'))) {
  const list = await (await fetch(API)).json();
  sources = sources.map((s) => (s.startsWith('pk_') ? s : list.items.find((it) => it.id.endsWith(`_${s}`))?.id ?? s));
  const bad = sources.filter((s) => !s.startsWith('pk_'));
  if (bad.length) { console.error('레퍼런스를 찾지 못했습니다:', bad.join(', ')); process.exit(1); }
}

const fd = new FormData();
fd.append('file', new Blob([bytes]), fileName);
const kind = ['upload', 'reference', 'result'].includes(opt('--kind')) ? opt('--kind') : 'result';
fd.append('kind', kind);
if (opt('--category')) fd.append('category', opt('--category'));
if (opt('--name')) fd.append('name', opt('--name'));
if (opt('--note')) fd.append('note', opt('--note'));
if (sources.length) fd.append('sourceIds', sources.join(','));

const gen = {};
if (opt('--model')) gen.model = opt('--model');
if (opt('--credits')) gen.credits = Number(opt('--credits'));
if (opt('--job')) gen.jobId = opt('--job');
if (opt('--prompt')) gen.prompt = opt('--prompt');
if (opt('--prompt-file')) gen.prompt = fs.readFileSync(opt('--prompt-file'), 'utf8').trim();
if (Object.keys(gen).length || opt('--tool')) {
  gen.tool = opt('--tool') || 'higgsfield';
  fd.append('gen', JSON.stringify(gen));
}

const r = await fetch(API, { method: 'POST', body: fd }).catch((e) => ({ ok: false, json: async () => ({ error: `서버에 닿지 못했습니다(개발 서버가 떠 있나요?) — ${e.message}` }) }));
const j = await r.json();
if (!j.ok) { console.error('실패:', j.error); process.exit(1); }
const it = j.item;
const KIND_KR = { upload: '사용 이미지', reference: '컨셉 레퍼런스', result: '결과물' };
console.log(`넣음: #${it.id.slice(-4)} (${it.id}) · ${it.category} ${KIND_KR[it.kind]} · ${it.name} · ${it.width}x${it.height}`
  + `${it.transparent ? ' · 투명 배경' : ''}`
  + `${it.sourceIds.length ? ` · 출처 ${it.sourceIds.map((s) => `#${s.slice(-4)}`).join(' ')}` : ''}`
  + `${it.gen ? ` · ${it.gen.tool}${it.gen.model ? `/${it.gen.model}` : ''}${it.gen.credits !== undefined ? ` ${it.gen.credits}크레딧` : ''}` : ''}`);
