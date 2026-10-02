/**
 * 프롬프트 고정 테스트 — 프롬프트 규칙을 고치기 전후로 같은 12개 조합을 돌려 무엇이 바뀌었는지 본다 (점검 2026-10-02 2번).
 *
 * 왜 필요한가: 지금까지의 수정은 전부 "실측 1~2컷" 기준이라, 한 조합을 고치면 다른 조합이 깨져도 못 봤다.
 * "라운저는 170cm" 문장이 한 달간 맥스가 아닌 컷 96장에 들어간 게 그 결과다. 이 스크립트는
 *   ① 고정 조합(regress/cases.json)을 dryRun 으로 돌려 프롬프트를 받아 저장하고 (이미지 생성 없음 — 무과금 템플릿)
 *   ② 기준본(regress/snapshots)과 비교해 바뀐 줄 수를 알려 주고
 *   ③ 알려진 충돌(제품과 안 맞는 숫자·서로 부딪히는 문장·작업자용 지시 혼입 등)을 자동으로 찾는다.
 *
 * 사용: node scripts/prompt-regress.mjs            전체 실행 + 기준본과 비교
 *       node scripts/prompt-regress.mjs --update   지금 결과를 새 기준본으로 저장 (고친 내용이 의도대로일 때)
 *       node scripts/prompt-regress.mjs 05 09      이름에 05·09 가 들어간 케이스만
 *       node scripts/prompt-regress.mjs --show 05  그 케이스의 바뀐 줄을 전부 출력
 * 개발 서버(http://localhost:6100)가 떠 있어야 한다. 배경·원본 사진은 처음 한 번 비전으로 크기·시선을 읽는다(결과는 저장돼 다시 안 묻는다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'regress');
const SNAP = path.join(DIR, 'snapshots');
const OUT = path.join(DIR, 'out');
const API = process.env.GENERATE_API || 'http://localhost:6100/api/generate';

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const showIdx = args.indexOf('--show');
const SHOW = showIdx >= 0 ? args[showIdx + 1] : '';
const filters = args.filter((a, i) => !a.startsWith('--') && !(showIdx >= 0 && i === showIdx + 1));

const spec = JSON.parse(fs.readFileSync(path.join(DIR, 'cases.json'), 'utf8'));
/** "@이름" 을 refs·sheets 의 실제 값으로 */
function resolve(v) {
  if (typeof v === 'string' && v.startsWith('@')) return spec.refs[v.slice(1)] ?? spec.sheets[v.slice(1)] ?? v;
  if (Array.isArray(v)) return v.map(resolve);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
  return v;
}

/**
 * 알려진 충돌 검사 — 프롬프트 본문만 보고 판정한다. level: bad(틀린 문장) / warn(약해지는 요인).
 * 새 사고를 찾으면 여기에 한 줄 추가한다 — 그러면 다시는 조용히 못 들어온다.
 */
const NON_MAX_FAMILY = (lines) => lines.length > 0 && !lines.some((l) => ['Max', 'Double', 'Slim', 'Midi', 'Mini'].includes(l));
const LINTS = [
  { id: '170cm', level: 'bad', why: '맥스 계열이 아닌 제품 컷에 "요기보 라운저는 성인 키만 하다(170cm)" 문장',
    hit: (p, c) => /floor lounger is\s+roughly as long as an adult is tall/.test(p) && NON_MAX_FAMILY(c.expect.lines) },
  { id: 'max-zipper', level: 'bad', why: '맥스가 없는 컷에 "맥스에는 지퍼가 없다" 규칙',
    hit: (p, c) => /real Max has NO zipper/.test(p) && !c.expect.lines.includes('Max') },
  { id: 'same-floor', level: 'bad', why: '"두 제품은 같은 바닥에 선다" 와 "한 제품이 다른 제품 위에 얹힌다" 가 같이 있음',
    hit: (p) => /they stand on the same floor/.test(p) && /sits ON TOP of/.test(p) },
  { id: 'operator-rule', level: 'bad', why: '작업자용 지시(참조 크롭·숫자로 바꿔 쓰기)가 이미지 모델에 들어감',
    hit: (p) => /When attaching an outfit concept reference|Replace abstract instructions with numeric ones/.test(p) },
  { id: 'two-angles', level: 'bad', why: '한 제품에 카메라 각도 지시가 둘 (배치 각도 칸 + 연출 문장의 각도)',
    hit: (p) => /CAMERA ANGLE ON THIS PRODUCT/.test(p) && /USE: seen from/.test(p) },
  { id: 'no-people-conflict', level: 'bad', why: '인물이 있는데 "사람 없음" 문장',
    hit: (p, c) => c.expect.people > 0 && /There are NO people in this image/.test(p) },
  { id: 'people-missing', level: 'bad', why: '인물을 골랐는데 인물 블록이 없음',
    hit: (p, c) => c.expect.people > 0 && !/\b(MODEL|PERSON 1)\b/.test(p) },
  { id: 'broken-token', level: 'bad', why: 'undefined · null · [object Object] 같은 깨진 값',
    hit: (p) => /\bundefined\b|\[object Object\]|\bNaN\b|: null\b/.test(p) },
  { id: 'ordinal-overflow', level: 'bad', why: '참조 장수보다 큰 순번을 가리킴',
    hit: (p, c, r) => {
      const ORD = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH', 'NINTH', 'TENTH', 'ELEVENTH', 'TWELFTH', 'THIRTEENTH', 'FOURTEENTH'];
      return ORD.slice(r.refs.length).some((o) => new RegExp(`\\b${o} image\\b`).test(p));
    } },
  { id: 'korean-name', level: 'bad', why: '컬러·의상 이름이 한글 그대로 들어감 (영문 표기가 DB 에 없음)',
    hit: (p) => /COLOUR: [^\n(]*[가-힣]|OUTFIT: [^\n(]*[가-힣]|Yogibo [A-Za-z ]+ \([가-힣]+\)/.test(p) },
  { id: 'korean-for-other-engine', level: 'bad', why: '제미나이가 아닌 엔진인데 앱이 넣은 한국어 문장이 남음',
    hit: (p, c) => !!c.expect.englishOnly && /[가-힣]/.test(p) },
  { id: 'colour-vs-mute', level: 'warn', why: '스와치 "정확히 일치" 와 "장면에 맞춰 채도를 누그러뜨려라" 가 같이 있음',
    hit: (p) => /match this hue, saturation and darkness precisely/.test(p) && /mute its colours/.test(p) },
  { id: 'override-claims', level: 'warn', why: '"이게 이긴다/최우선" 선언이 5개 이상 — 서로 우선권을 주장',
    hit: (p) => (p.match(/\boverrides?\b|\bWINS\b|HIGHEST PRIORITY/g) || []).length >= 5,
    detail: (p) => `${(p.match(/\boverrides?\b|\bWINS\b|HIGHEST PRIORITY/g) || []).length}개` },
  { id: 'too-long', level: 'warn', why: '프롬프트가 14,000자를 넘음 — 뒤쪽 지시가 약해진다',
    hit: (p) => p.length > 14000, detail: (p) => `${p.length.toLocaleString()}자` },
];

/** 줄 단위 비교 — 순서가 바뀐 것까지는 보지 않고, 사라진 줄·새로 생긴 줄만 센다 (프롬프트는 블록 단위라 이걸로 충분하다) */
function diffLines(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
  const ca = count(A), cb = count(B);
  const removed = [], added = [];
  for (const [l, n] of ca) for (let i = 0; i < n - (cb.get(l) ?? 0); i++) removed.push(l);
  for (const [l, n] of cb) for (let i = 0; i < n - (ca.get(l) ?? 0); i++) added.push(l);
  return { removed: removed.filter((l) => l.trim()), added: added.filter((l) => l.trim()) };
}

fs.mkdirSync(SNAP, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const cases = spec.cases.filter((c) => !filters.length || filters.some((f) => c.name.includes(f)));
const report = [];
let bad = 0, warn = 0, changed = 0, failed = 0;

for (const c of cases) {
  const body = { ...resolve(c.body), dryRun: true, promptMode: 'local' };
  let json;
  try {
    const res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    json = await res.json();
  } catch (e) {
    console.log(`✗ ${c.name} — 서버에 닿지 못했습니다 (개발 서버가 떠 있나요?) ${e.message}`);
    failed++;
    continue;
  }
  if (!json.ok || !json.prompt) {
    console.log(`✗ ${c.name} — ${json.error || '프롬프트를 받지 못했습니다'}`);
    failed++;
    report.push({ name: c.name, error: json.error || 'no prompt' });
    continue;
  }
  const prompt = String(json.prompt);
  const refs = json.refs ?? [];
  // 머리말 — 참조 구성이 바뀌어도 비교에 잡히게 본문 앞에 같이 저장한다
  const head = [`# ${c.name} — ${c.what}`, `# 참조 ${refs.length}장: ${refs.map((r) => r.kind).join(' · ')}`, `# 생성 비율 ${json.aspect} → ${json.target?.width}x${json.target?.height}`, ''].join('\n');
  const full = head + prompt + '\n';
  fs.writeFileSync(path.join(OUT, `${c.name}.txt`), full);

  const snapPath = path.join(SNAP, `${c.name}.txt`);
  const base = fs.existsSync(snapPath) ? fs.readFileSync(snapPath, 'utf8') : null;
  const d = base == null ? null : diffLines(base, full);
  const isChanged = !!d && (d.removed.length > 0 || d.added.length > 0);
  if (isChanged) changed++;

  const findings = LINTS.filter((l) => l.hit(prompt, c, { refs })).map((l) => ({ id: l.id, level: l.level, why: l.why, ...(l.detail ? { detail: l.detail(prompt) } : {}) }));
  bad += findings.filter((f) => f.level === 'bad').length;
  warn += findings.filter((f) => f.level === 'warn').length;

  const status = base == null ? '새 기준' : isChanged ? `바뀜 +${d.added.length} −${d.removed.length}줄` : '같음';
  console.log(`${findings.some((f) => f.level === 'bad') ? '⚠' : '✓'} ${c.name}  [${status}]  ${prompt.length.toLocaleString()}자 · 참조 ${refs.length}장`);
  for (const f of findings) console.log(`     ${f.level === 'bad' ? '✗' : '·'} ${f.why}${f.detail ? ` (${f.detail})` : ''}`);
  if (isChanged && SHOW && c.name.includes(SHOW)) {
    for (const l of d.removed) console.log(`     − ${l.slice(0, 260)}`);
    for (const l of d.added) console.log(`     + ${l.slice(0, 260)}`);
  }
  if (base == null || UPDATE) fs.writeFileSync(snapPath, full);
  report.push({ name: c.name, what: c.what, chars: prompt.length, refs: refs.length, status, findings, ...(isChanged ? { added: d.added.length, removed: d.removed.length } : {}) });
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ at: new Date().toISOString(), report }, null, 1));
console.log(`\n${cases.length}개 중 실패 ${failed} · 기준본과 다름 ${changed} · 틀린 문장 ${bad} · 주의 ${warn}` + (UPDATE ? ' · 기준본을 지금 결과로 바꿨습니다' : ''));
if (changed && !UPDATE) console.log('바뀐 줄 보기: node scripts/prompt-regress.mjs --show <케이스 이름 일부>   |   의도한 변경이면: --update');
process.exitCode = failed || bad ? 1 : 0;
