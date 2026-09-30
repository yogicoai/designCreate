#!/usr/bin/env node
/**
 * Yogibo 이미지 자산 MCP 서버 — 읽기 전용.
 *
 * 왜 있나: imgCreate 앱이 들고 있는 자산(제품 치수·형태, 전속 모델 시트, 촬영본 11,000장,
 * AI 인테리어 배경)을 앱 밖에서도 쓰고 싶다는 요청. Codex 등 다른 도구가 이 서버를 붙이면
 * "드롭박스 속 저 컷을 베이스로, 모델 B 로" 같은 작업을 할 때 실제 URL 과 치수를 바로 집어온다.
 *
 * 읽기 전용이다. 이 파일에는 insert/update/delete 가 없고 앞으로도 넣지 않는다 —
 * 외부 도구가 우리 자산을 고치는 길을 열지 않기 위해서다. FTP 도 붙이지 않는다.
 *
 * 실행: node --env-file=.env.local mcp/server.mjs
 *   (MONGODB_URI, MONGODB_DB 만 쓴다. 제미나이·힉스필드·FTP 키는 읽지 않는다.)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('MONGODB_URI 가 없습니다. node --env-file=.env.local mcp/server.mjs 로 실행하세요.'); process.exit(1); }
const client = new MongoClient(uri, { maxPoolSize: 4 });
await client.connect();
const db = client.db(process.env.MONGODB_DB || undefined);

/** 한글 제품명 — 화면에 보이는 이름이 영문 line 과 다르다 */
const LINE_KR = {
  Max: '맥스', Slim: '슬림', Midi: '미디', Mini: '미니', Double: '더블', Drop: '드롭',
  Pod: '팟', Lounger: '라운저', Pyramid: '피라미드', Support: '서포트', Etc: '기타',
};
const kr = (l) => LINE_KR[l] ?? l;

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 1) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

const TOOLS = [
  {
    name: 'list_products',
    description:
      '요기보 제품 전체 목록과 실측 치수. 이미지 생성 프롬프트에 크기를 적을 때 여기 숫자를 그대로 쓴다. '
      + '치수는 cm 이고 h=세워 놨을 때 높이, w=폭, d=깊이(눕히면 이게 높이가 된다).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_product',
    description:
      '제품 하나의 상세 — 치수, 형태 서술(영문, 프롬프트에 그대로 넣는 문장), 그 제품이 아닌 것(부정문), '
      + '실제 사용법, 판매 색상 목록, 형태 기준 뷰(정면·측면·후면 사진 URL).',
    inputSchema: {
      type: 'object',
      properties: { line: { type: 'string', description: "영문 제품명 'Max' 'Double' 'Drop' 'Pod' 'Lounger' 'Support' 등, 또는 한글 '맥스' '더블'" } },
      required: ['line'], additionalProperties: false,
    },
  },
  {
    name: 'list_talents',
    description:
      '등록된 전속 모델 전체(20명). 각 모델의 코드, 한 줄 설명, 영문 아이덴티티(프롬프트에 그대로 들어가는 문장), 키·체형.',
    inputSchema: {
      type: 'object',
      properties: { category: { type: 'string', description: "'여성' '남성' '아동' 중 하나로 좁히기 (생략하면 전부)" } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_talent',
    description:
      '전속 모델 한 명의 모든 참조 이미지 URL — 대표컷, 얼굴 턴어라운드 시트, 표정 시트, 바디 시트, '
      + '표정 8종 조각, 얼굴 각도 5종 조각(정면/3-4좌/옆좌/3-4우/옆우), 등록된 의상. '
      + '이미지 생성에 이 URL 들을 참조로 넣으면 같은 인물을 유지할 수 있다.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: "모델 코드 'W_A' 'W_B' 'M_A' 'K_C' 등" } },
      required: ['code'], additionalProperties: false,
    },
  },
  {
    name: 'search_photos',
    description:
      '실제 촬영본 아카이브 검색(약 11,000장, 2017~2022). 제품별로 라벨이 붙어 있다. '
      + '이미지 생성의 베이스(원본)로 쓸 컷을 찾을 때 사용한다 — 실촬영을 베이스로 쓰면 제품 형태가 안정적이다.',
    inputSchema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: "제품 한글 라벨로 거르기 — '맥스' '더블' '드롭' '팟' '라운저' '서포트' '미니' '미디' '슬림' '럭스' '파스텔' 등" },
        keyword: { type: 'string', description: '파일명·폴더명에 들어간 말로 검색 (예: 2022, 더블 배경, 가족)' },
        limit: { type: 'number', description: '가져올 장수 (기본 30, 최대 100)' },
        skip: { type: 'number', description: '건너뛸 장수 — 다음 페이지를 볼 때' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_backgrounds',
    description:
      '배경으로 쓸 수 있는 AI 인테리어 레퍼런스 검색. 합성 컷에서 이 이미지를 새 환경으로 쓴다.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '제목으로 검색 (예: 크리스마스, 한옥, 거실, 침실, 저녁)' },
        limit: { type: 'number', description: '가져올 건수 (기본 30, 최대 100)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'size_pairing',
    description:
      '제품과 사람 키를 넣으면 둘의 실제 비례를 문장으로 돌려준다. 이미지 생성에서 제품이 사람 대비 '
      + '너무 크거나 작게 나오는 것을 막는 용도 — 배율만 주면 모델이 잘 못 읽어서 "몸의 어디에 오는지"까지 적어 준다.',
    inputSchema: {
      type: 'object',
      properties: {
        line: { type: 'string', description: "제품명 'Max' 'Double' 등" },
        heightCm: { type: 'number', description: '사람 키 (cm)' },
        lying: { type: 'boolean', description: '제품을 바닥에 눕혀 쓰는가 (기본 false = 세워 둠). 눕히면 높이가 d 가 된다.' },
      },
      required: ['line', 'heightCm'], additionalProperties: false,
    },
  },
];

/** 세워 놨을 때 제품 높이가 몸의 어디에 오는가 — 배율 숫자만으로는 잘 안 읽힌다 */
const landmark = (r) =>
  r < 0.20 ? '정강이 중간' : r < 0.26 ? '무릎 바로 아래' : r < 0.31 ? '무릎'
    : r < 0.36 ? '무릎 위' : r < 0.41 ? '허벅지 중간' : r < 0.47 ? '허벅지 위쪽'
      : r < 0.53 ? '엉덩이' : r < 0.60 ? '허리' : r < 0.68 ? '갈비뼈 아래'
        : r < 0.78 ? '가슴' : r < 0.88 ? '어깨' : r < 0.97 ? '턱'
          : r < 1.06 ? '머리 꼭대기' : '머리 위로 훌쩍';

async function findProduct(line) {
  const want = String(line || '').trim();
  const enFromKr = Object.entries(LINE_KR).find(([, k]) => k === want)?.[0];
  return db.collection('products').findOne({
    $or: [{ line: want }, { line: enFromKr ?? '__none__' }, { line: new RegExp(`^${want}$`, 'i') }],
  });
}

const handlers = {
  async list_products() {
    const ps = await db.collection('products').find({ active: { $ne: false } }).sort({ order: 1 }).toArray();
    return ok(ps.filter((p) => p.dims?.h || p.dims?.w).map((p) => ({
      line: p.line, 한글: kr(p.line), 치수: p.sizeText || '',
      w: p.dims?.w ?? null, d: p.dims?.d ?? null, h: p.dims?.h ?? null, kg: p.dims?.weight ?? null,
      한줄: p.spec || '',
    })));
  },

  async get_product({ line }) {
    const p = await findProduct(line);
    if (!p) return fail(`'${line}' 제품을 찾지 못했습니다. list_products 로 이름을 확인하세요.`);
    return ok({
      line: p.line, 한글: kr(p.line), 치수: p.sizeText, 한줄: p.spec,
      dims: p.dims,
      형태_영문: p.geometry?.shape || '',
      아닌것_영문: p.geometry?.negative || '',
      실제사용법_영문: p.geometry?.modes || '',
      크기앵커_영문: p.scalePrompt || '',
      색상: (p.colors || []).map((c) => ({ key: c.key, 이름: c.name, hex: c.hex })),
      // shapeViews 는 제품마다 배열이기도 하고 객체 하나이기도 하다 — 둘 다 받는다
      형태기준뷰: (Array.isArray(p.shapeViews) ? p.shapeViews : p.shapeViews ? [p.shapeViews] : [])
        .map((v) => ({ 색: v.colorName ?? null, views: v.views ?? null, 대표: !!v.canonical })),
    });
  },

  async list_talents({ category }) {
    const q = category ? { category } : {};
    const ts = await db.collection('talents').find(q).sort({ order: 1 }).toArray();
    return ok(ts.map((t) => ({
      code: t.code, 이름: t.name, 분류: t.category,
      설명: t.thumbDesc || t.identity || '',
      영문_아이덴티티: t.identityEn || '',
      키_체형: t.sizeEn || t.size || '',
      시트있음: { 얼굴: !!t.sheets?.face, 표정: !!(t.exprSheet || t.sheets?.expr), 바디: !!t.sheets?.body,
        표정조각: Object.keys(t.expressionCrops || {}).length, 얼굴각도조각: Object.keys(t.faceCrops || {}).length },
    })));
  },

  async get_talent({ code }) {
    const t = await db.collection('talents').findOne({ code: String(code).toUpperCase() });
    if (!t) return fail(`'${code}' 모델을 찾지 못했습니다. list_talents 로 코드를 확인하세요.`);
    return ok({
      code: t.code, 이름: t.name, 분류: t.category, 설명: t.thumbDesc,
      영문_아이덴티티: t.identityEn, 키_체형: t.sizeEn,
      대표컷: t.rep || null,
      시트: { 얼굴_5칸: t.sheets?.face || null, 표정_8칸: t.exprSheet || t.sheets?.expr || null, 바디_5칸: t.sheets?.body || null },
      표정조각: t.expressionCrops || {},
      얼굴각도조각: t.faceCrops || {},
      의상: (t.outfits || []).map((o) => ({ code: o.code, 설명: o.desc, 영문: o.descEn, 크롭: o.cropUrl || null })),
      안내: '생성 참조로는 대표컷 + 요청 표정 조각 + (고개를 돌리는 컷이면) 그 방향의 얼굴 각도 조각을 쓴다. '
        + '얼굴 각도 조각의 _l 은 얼굴이 화면 왼쪽을 향한 칸, _r 은 오른쪽이다.',
    });
  },

  async search_photos({ product, keyword, limit, skip }) {
    const n = Math.min(Math.max(Number(limit) || 30, 1), 100);
    const q = { active: true };
    if (product) q.products = String(product);
    if (keyword) q.$or = [{ sourcePath: new RegExp(String(keyword), 'i') }, { title: new RegExp(String(keyword), 'i') }];
    const col = db.collection('dropbox_assets');
    const [total, rows] = await Promise.all([
      col.countDocuments(q),
      col.find(q).sort({ srcUploaded: -1, srcMtime: -1, sourcePath: 1 })
        .skip(Math.max(Number(skip) || 0, 0)).limit(n)
        .project({ url: 1, title: 1, products: 1, width: 1, height: 1, sourcePath: 1 }).toArray(),
    ]);
    return ok({
      전체: total, 보여준수: rows.length,
      결과: rows.map((r) => ({
        url: r.url, 제목: r.title || '', 제품: r.products || [],
        크기: r.width && r.height ? `${r.width}x${r.height}` : '',
        폴더: String(r.sourcePath || '').split('/').slice(0, -1).join('/'),
      })),
    });
  },

  async list_backgrounds({ keyword, limit }) {
    const n = Math.min(Math.max(Number(limit) || 30, 1), 100);
    const q = { active: { $ne: false }, title: new RegExp(keyword ? String(keyword) : '인테리어', 'i') };
    const rows = await db.collection('references').find(q).sort({ createdAt: -1 }).limit(n)
      .project({ url: 1, title: 1, width: 1, height: 1 }).toArray();
    return ok(rows.map((r) => ({ url: r.url, 제목: r.title, 크기: r.width && r.height ? `${r.width}x${r.height}` : '' })));
  },

  async size_pairing({ line, heightCm, lying }) {
    const p = await findProduct(line);
    if (!p) return fail(`'${line}' 제품을 찾지 못했습니다.`);
    const cm = Number(heightCm);
    if (!(cm > 0)) return fail('heightCm 은 0보다 큰 숫자여야 합니다.');
    const d = p.dims || {};
    const longest = Math.max(d.w ?? 0, d.d ?? 0, d.h ?? 0);
    const standH = d.h ?? longest;
    const lieH = d.d ?? 0;
    const h = lying && lieH ? lieH : standH;
    const r = h / cm;
    const child = cm < 150;
    return ok({
      제품: `${kr(p.line)} (${p.sizeText})`, 사람키: `${cm}cm`, 놓인방향: lying ? '바닥에 눕힘' : '세워 둠',
      기준높이: `${h}cm`, 배율: Number(r.toFixed(2)),
      한국어: `${kr(p.line)}를 ${lying ? '눕혀 놓으면' : '세워 놓으면'} 높이 ${h}cm 로, ${cm}cm 인 사람 옆에서 ${landmark(r)} 정도에 온다 (${r.toFixed(2)}배).`,
      영문_프롬프트용:
        `Yogibo ${p.line} (${p.sizeText}) vs a ${cm}cm person: ${lying ? 'lying flat on the floor it rises only' : 'standing beside them it reaches'} `
        + `${h}cm — ${r.toFixed(2)}x their height, about ${['mid-shin','just below the knee','knee','just above the knee','mid-thigh','upper thigh','hip','waist','lower ribs','chest','shoulder','chin','the top of their head','well above their head'][[0.20,0.26,0.31,0.36,0.41,0.47,0.53,0.60,0.68,0.78,0.88,0.97,1.06].findIndex((t) => r < t) + 1] || 'well above their head'} height. `
        + `Its longest side (${longest}cm) is ${(longest / cm).toFixed(2)}x their height.`
        + (child ? ` This person is a child, so the product must read visibly BIGGER against their body than against a 175cm adult.` : ''),
      주의: '사람이 앉아 누르면 빈백은 옆으로 퍼진다 — 눌린 상태의 투영 길이는 위 치수보다 길게 보이는 것이 정상이다.',
    });
  },
};

const server = new Server({ name: 'yogibo-assets', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const fn = handlers[req.params.name];
  if (!fn) return fail(`알 수 없는 도구: ${req.params.name}`);
  try {
    return await fn(req.params.arguments ?? {});
  } catch (e) {
    return fail(`조회 실패: ${e.message}`);
  }
});

await server.connect(new StdioServerTransport());
console.error('[yogibo-assets] MCP 서버 준비됨 — 읽기 전용, 도구 ' + TOOLS.length + '개');
