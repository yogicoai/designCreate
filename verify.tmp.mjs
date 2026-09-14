const post = async (b) => { for (let t = 0; t < 6; t++) { try { return await (await fetch('http://localhost:6100/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'thumbnail', dryRun: true, promptMode: 'local', sizeValue: '1000x1000', engine: 'gemini', ...b }) })).json(); } catch { await new Promise((r) => setTimeout(r, 5000)); } } };
const MAX = '6aa7580c5d156efb2272c9fe', MINI = '6aa7827e3ba58ae3b55e8daf', POD = '6aa787a73dc9883930a00b02', LOUNGER = '6aa76e8029f9cc7c5600c15b';
const BG = { url: 'https://yogibo.openhost.cafe24.com/web/design/update/ref_20260911060034_yx8a7g.jpg', title: 'bg', role: 'background' };
const has = (p, s) => p.includes(s);
const cases = [
  ['1 모델+실사포즈+칸 → 칸은 형태만, 각도 줄 없음', { composition: 'model', talents: [{ code: 'K_B' }], poseRefKey: 'max_p2', shapeRefKey: 'max_p2', products: [{ line: 'Max', colorKey: 'navy', sheetPanel: { sheetId: MAX, key: 'd45' } }] },
    (j) => ({ shapeOnly: has(j.prompt, 'come from the pose reference'), noPlaceRole: !has(j.prompt, 'THE EXACT PRODUCT TO PLACE'), noCamLine: !has(j.prompt, 'CAMERA ANGLE ON THIS PRODUCT') })],
  ['2 편집 베이스+제품 → 칸·각도·빈상태 줄 없음', { composition: 'model', uploadedRefs: [{ url: 'https://yogibo.openhost.cafe24.com/web/design/ai-products/drop_coral_usage_20260914_sit-34.jpg', title: 'b', role: 'base' }], editTargets: ['product-color'], products: [{ line: 'Max', colorKey: 'darkgrey', sheetPanel: { sheetId: MAX, key: 'd45' } }] },
    (j) => ({ noSheetRef: !j.refs.some((r) => r.kind === 'sheet'), noCam: !has(j.prompt, 'CAMERA ANGLE ON THIS PRODUCT'), noState: !has(j.prompt, 'STATE: EMPTY'), noPlacementRefWord: !has(j.prompt, 'placement reference image') })],
  ['3 배너 1920x1000 배치 왼쪽 → 카피 오른쪽', { mode: 'banner', sizeValue: 'custom', customSize: { width: 1920, height: 1000 }, composition: 'product', products: [{ line: 'Max', colorKey: 'navy', placement: 'left', sheetPanel: { sheetId: MAX, key: 'd45' } }] },
    (j) => ({ copyRight: has(j.prompt, 'the RIGHT 45% stays clean'), prodLeft: has(j.prompt, 'occupies the LEFT side') })],
  ['4 세운 모습 칸 → 자세 문구', { composition: 'product', products: [{ line: 'Max', colorKey: 'navy', sheetPanel: { sheetId: MAX, key: 'upright' } }] },
    (j) => ({ posture: has(j.prompt, 'POSTURE: standing upright'), noSeenFromStanding: !has(j.prompt, 'seen from the standing'), noStandItUp: !has(j.prompt, 'stand it up') })],
  ['5 팟 측면2 → 사선 문구', { composition: 'product', products: [{ line: 'Pod', colorKey: 'navy', sheetPanel: { sheetId: POD, key: 'side2' } }] },
    (j) => ({ diagonal: has(j.prompt, 'diagonal three-quarter view') })],
  ['6 미니 초코 → 밝은 색(라이트그레이 #E5DED3 류) 보정 불가 시 원본+형태만', { composition: 'product', products: [{ line: 'Mini', colorKey: 'lightgrey', sheetPanel: { sheetId: MINI, key: 'd45' } }] },
    (j) => ({ refs: j.refs.filter((r) => r.kind === 'sheet').map((r) => r.title + ' ' + r.url.split('/').pop()) , wording: has(j.prompt, 'already shown in the requested colour') ? 'recolored' : has(j.prompt, 'different colour') ? 'shape-only' : 'same' })],
  ['7 스토리보드 배경 → 가구 치우기 규칙 없음', { origin: 'storyboard', uploadedRefs: [BG], line: 'Max', colorKey: 'navy' }, (j) => ({ noClear: !has(j.prompt, 'CLEAR THE PLACEMENT AREA') })],
  ['8 라운저+배경 → 러그는 두기 문구', { composition: 'product', uploadedRefs: [BG], products: [{ line: 'Lounger', colorKey: 'chocobrown', sheetPanel: { sheetId: LOUNGER, key: 'fl34' } }] },
    (j) => ({ clear: has(j.prompt, 'CLEAR THE PLACEMENT AREA'), rugStays: has(j.prompt, 'a rug may simply stay'), tone: has(j.prompt, 'SCENE TONE') })],
];
for (const [name, body, check] of cases) {
  const j = await post(body);
  if (!j?.ok) { console.log('✗', name, j?.error); continue; }
  console.log((Object.values(check(j)).every((v) => v === true || typeof v !== 'boolean') ? '✓' : '✗'), name, JSON.stringify(check(j)));
}
