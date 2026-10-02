/**
 * 참조 사진이 쓰임에 맞는지 미리 본다 (점검 2026-10-02 6번) — 대화에서 힉스필드로 뽑기 전에 쓴다.
 * 앱 화면은 올릴 때 자동으로 보지만, 대화에서 고른 참조는 아무도 안 봤다
 * ("눌린 실사는 형태 참조 금지", "참조 속 방이 배경으로 따라온다" 를 기억에 의존했다).
 *
 * 사용: node scripts/check-ref.mjs <역할> <URL> [URL…]
 *   역할: shape(형태) · pose(포즈) · background(배경) · style(분위기) · base(편집 원본)
 * 사진마다 처음 한 번만 비전을 부르고 기록해 둔다. 개발 서버(http://localhost:6100)가 떠 있어야 한다.
 */
const [role, ...urls] = process.argv.slice(2);
const ROLES = ['shape', 'pose', 'background', 'style', 'base'];
if (!ROLES.includes(role) || !urls.length) { console.error('사용: node scripts/check-ref.mjs <shape|pose|background|style|base> <URL> [URL…]'); process.exit(1); }
const API = process.env.REF_CHECK_API || 'http://localhost:6100/api/ref-check';
let json;
try {
  const res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ urls, role }) });
  json = await res.json();
} catch (e) { console.error('개발 서버에 닿지 못했습니다 (npm run dev 가 떠 있나요?)', e.message); process.exit(1); }
if (!json.ok) { console.error('실패:', json.error); process.exit(1); }
let bad = 0;
for (const u of urls) {
  const r = json.reads[u];
  console.log('\n' + u);
  if (!r) { console.log('  읽지 못했습니다 (다시 시도해 보세요)'); continue; }
  console.log(`  사람 ${r.people}${r.onProduct ? '(빈백 위)' : ''} · 빈백 ${r.beanbags}${r.pressed ? '(눌림)' : ''} · ${{ room: '방', plain: '단색 배경', outdoor: '야외' }[r.setting]} · ${r.longSide}px${r.gear ? ' · 촬영 장비' : ''}${r.frame ? ' · 테두리/캡처' : ''}${r.text ? ' · 글자' : ''}`);
  console.log(`  ${r.note}`);
  const ws = json.warnings?.[u] ?? [];
  if (!ws.length) console.log('  → 이 쓰임에 걸리는 것 없음');
  for (const w of ws) { console.log(`  ${w.level === 'warn' ? '⚠' : '·'} ${w.text}`); if (w.level === 'warn') bad++; }
}
process.exitCode = bad ? 2 : 0;
