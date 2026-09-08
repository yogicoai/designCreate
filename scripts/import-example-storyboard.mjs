/**
 * 콘티 시트 이미지(storyboard_final8.png)를 컷별 START/END 프레임으로 잘라
 * cafe24 에 올리고, 예제 스토리보드 한 건으로 등록한다.
 *
 * 프레임 위치는 눈대중이 아니라 실측이다 — 배경색과 다른 픽셀로 행을 검출해 보니
 * 176px 등간격이었다 (첫 행 top=106, 높이 156, START x=203 / END x=503, 폭 86).
 *
 * 실행: node scripts/import-example-storyboard.mjs <원본png경로>
 */
import sharp from 'sharp';
import { Client } from 'basic-ftp';
import { MongoClient } from 'mongodb';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SRC = process.argv[2];
if (!SRC || !fs.existsSync(SRC)) { console.error('원본 png 경로를 넘겨주세요.'); process.exit(1); }

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

// 실측 격자
const GRID = { top: 106, pitch: 176, h: 156, w: 86, startX: 203, endX: 503 };
const UP = 4;                       // 4배 확대 — 콘티 셀에서 알아볼 수 있는 크기로
const SUB = 'storyboard';           // /web/design/storyboard/
const PUBLIC = (env.FTP_PUBLIC_BASE || '').replace(/\/$/, '');

/** 시트에 적힌 그대로 옮긴 컷 정보 */
const CUTS = [
  { seconds: 2, camera: '고정 (움직임 없음)', cameraNote: '측면 인티메이트 CU / SIDE INTIMATE CU',
    scene: '아침 침실 — 빈백에 기대 눈을 감고 있는 인물의 측면 클로즈업',
    action: '빈백에서 눈을 감고 있다 → 고개 살짝 듦 (로고 인트로)',
    narration: '"음… 잘 잤다"', sfx: '새소리 · 이불 부스럭' },
  { seconds: 2, camera: '천천히 들어가기 (푸시 인)', cameraNote: '와이드→타이트 CU (상체 리프레임)',
    scene: '침실 전경 — 빈백에 기대 폰을 보는 인물',
    action: '빈백에 기대 폰 확인 → 깜짝 놀람 (상체)',
    narration: '"헉, 지각!"', sfx: '알림음 "팅" · 놀라는 숨' },
  { seconds: 3, camera: '손에 든 듯 가볍게 흔들림', cameraNote: '핸드헬드 미디엄 / HANDHELD MED',
    scene: '옷장 앞 — 옷을 고르는 인물의 미디엄 샷',
    action: '정신없이 옷 갈아입기 · 줄무늬 잠옷 → 네이비 블레이저',
    narration: '"늦었다 늦었어"', sfx: '옷걸이 · 옷 스치는 소리' },
  { seconds: 2, camera: '손에 든 듯 가볍게 흔들림', cameraNote: '타이트 핸드헬드 · 당찬 걸음 / TIGHT HANDHELD WALK',
    scene: '출근길 — 환하게 웃으며 걷는 인물의 타이트 샷',
    action: '개운하게 출근 · 환한 미소 · 빠른 걸음',
    narration: '"근데 몸은 개운해"', sfx: '경쾌한 거리 · 발걸음' },
  { seconds: 2, camera: '고정 (움직임 없음)', cameraNote: '인물중심 미디엄 · 보케 / SUBJECT-FOCUSED BOKEH',
    scene: '사무실 복도 — 서류를 든 인물, 배경은 보케로 흐림',
    action: '서류 보며 바쁜 하루',
    narration: '', sfx: '키보드 · 전화 · 사무실 소음' },
  { seconds: 1, camera: '손에 든 듯 가볍게 흔들림', cameraNote: '미디엄 · 보케 · 핸드헬드 / MED BOKEH',
    scene: '사무실 — 동료(뒷모습)와 마주 선 인물',
    action: '동료와 짧은 회의 · 끄덕임',
    narration: '"이건 이틀게요"', sfx: '사무실 대화 · 잔향' },
  { seconds: 2, camera: '고정 (움직임 없음)', cameraNote: '인물중심 미디엄 · 보케 / SUBJECT BOKEH',
    scene: '저녁 사무실 데스크 — 모니터 앞에 앉은 인물',
    action: '퇴근 직전 · 관자놀이 짚고 지친 한숨 · 어깨 툭',
    narration: '"오늘도 길었다"', sfx: '사무실 잔향 · 긴 한숨' },
  { seconds: 1, camera: '천천히 들어가기 (푸시 인)', cameraNote: '로우앵글 · 다이브 → 얼굴 푸시인 / LOW DIVE→PUSH-IN',
    scene: '밤 침실 — 빈백으로 몸을 던지는 인물, 로우앵글',
    action: '빈백에 몸을 던져 안착 → 얼굴로 줌인',
    narration: '"역시 집이 최고"', sfx: '패브릭 쓸림 · 안도의 숨' },
  { seconds: 2, camera: '고정 (움직임 없음)', cameraNote: '얼굴 CU (디졸브로 받음) / FACE CU (DISSOLVE)',
    scene: '밤 침실 — 빈백에 안겨 잠든 얼굴 클로즈업, 따뜻한 룸톤',
    action: '잠든 얼굴 클로즈업 · 평온하게 마무리',
    narration: '"내 하루의 끝, 요기보"', sfx: '따뜻한 룸톤' },
  { seconds: 1, camera: '고정 (움직임 없음)', cameraNote: '그래픽 · 흰 배경 · 페이드인 / GRAPHIC WHITE FADE-IN',
    scene: '흰 배경 엔드카드 — yogibo 공식 로고',
    action: 'yogibo 공식 로고가 천천히 떠오르며 끝',
    narration: '', sfx: '무음 → 시그니처 사운드' },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
const files = [];
for (let i = 0; i < CUTS.length; i++) {
  for (const kind of ['start', 'end']) {
    const name = `cf_day_cut${String(i + 1).padStart(2, '0')}_${kind}.jpg`;
    const out = path.join(tmp, name);
    await sharp(SRC)
      .extract({
        left: kind === 'start' ? GRID.startX : GRID.endX,
        top: GRID.top + GRID.pitch * i,
        width: GRID.w,
        height: GRID.h,
      })
      .resize(GRID.w * UP, GRID.h * UP, { kernel: 'lanczos3' })
      .jpeg({ quality: 90 })
      .toFile(out);
    files.push({ i, kind, name, out });
  }
}
console.log(`잘라낸 프레임 ${files.length}장 (${GRID.w * UP}x${GRID.h * UP})`);

const c = new Client(60_000);
await c.access({
  host: (env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, '').replace(/\/$/, ''),
  port: Number(env.FTP_PORT) || 21, user: env.FTP_USER, password: env.FTP_PASS, secure: false,
});
await c.ensureDir(`/web/design/${SUB}`);
// cafe24 패시브 데이터 연결이 가끔 끊긴다 — 끊기면 다시 붙어서 이어 올린다
async function connect() {
  const cl = new Client(60_000);
  await cl.access({
    host: (env.FTP_HOST || '').replace(/^(https?|ftp):\/\//, '').replace(/\/$/, ''),
    port: Number(env.FTP_PORT) || 21, user: env.FTP_USER, password: env.FTP_PASS, secure: false,
  });
  await cl.ensureDir(`/web/design/${SUB}`);
  return cl;
}
let cl = c;
for (const f of files) {
  for (let tryN = 1; ; tryN++) {
    try { await cl.uploadFrom(f.out, f.name); process.stdout.write('.'); break; }
    catch (e) {
      if (tryN >= 3) throw e;
      process.stdout.write('!');
      try { cl.close(); } catch { /* 이미 닫힘 */ }
      cl = await connect();
    }
  }
}
cl.close();
console.log('\n업로드 완료');

const url = (n) => `${PUBLIC}/${SUB}/${n}`;
const shots = CUTS.map((cut, i) => ({
  no: i + 1,
  seconds: cut.seconds,
  scene: cut.scene,
  action: cut.action,
  camera: cut.camera,
  cameraNote: cut.cameraNote,
  narration: cut.narration,
  sfx: cut.sfx,
  image: url(`cf_day_cut${String(i + 1).padStart(2, '0')}_start.jpg`),
  imageTitle: `컷 ${i + 1} 시작`,
  endImage: url(`cf_day_cut${String(i + 1).padStart(2, '0')}_end.jpg`),
  endImageTitle: `컷 ${i + 1} 끝`,
  chain: i > 0,
}));

const mongo = new MongoClient(env.MONGODB_URI);
await mongo.connect();
const col = mongo.db('imgcreate').collection('storyboards');
const doc = {
  title: '하루의 끝, 요기보 — 18초 라이프스타일 CF (예제)',
  purpose: 'review',
  total: shots.reduce((a, s) => a + s.seconds, 0),
  aspect: '9:16',
  line: '', colorKey: '', model: '',
  status: '영상완료',
  note: '라이프스타일 실사 · 낮→밤 · 9:16 · NO BGM(예정) — 기상→폰 놀람→옷 갈아입기→당찬 출근→바쁜 하루→동료 회의→퇴근 전 지침→귀가 다이브→잠→로고. 제품 = Yogibo Pod(아보카도 그린), 모델 A 20대 초반 · 포니테일 유지, 톤 = 채도 낮은 자연 필름톤.',
  shots,
  updatedAt: new Date(), createdAt: new Date(), hidden: false,
};
await col.updateOne({ title: doc.title }, { $set: doc }, { upsert: true });
console.log(`등록: ${doc.title} · ${shots.length}컷 · ${doc.total}초`);
await mongo.close();
fs.rmSync(tmp, { recursive: true, force: true });
