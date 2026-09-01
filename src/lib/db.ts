import { MongoClient, type Db, type Collection, type Document } from 'mongodb';

/**
 * MongoDB 연결 — Next dev 의 HMR 로 연결이 매번 새로 열리는 걸 막기 위해 전역에 캐시한다.
 * (youtube/src/lib/db.js 와 같은 패턴)
 *
 * mongoose 대신 네이티브 드라이버를 쓴다. eventTemp 는 모델마다
 * `delete mongoose.models.X` 로 HMR 재정의를 우회해야 했는데, 그 해킹이 통째로 불필요해진다.
 * 시드 스크립트(scripts/seed.mjs)도 같은 드라이버를 쓰므로 스키마가 두 벌로 갈라지지 않는다.
 */

const uri = process.env.MONGODB_URI || '';
const dbName = process.env.MONGODB_DB || 'imgcreate';

type Cache = { client: MongoClient | null; promise: Promise<MongoClient> | null };
const g = globalThis as unknown as { _imgcreateMongo?: Cache };
const cached: Cache = (g._imgcreateMongo ??= { client: null, promise: null });

/** URI 가 비었거나 견본(<cluster> 등)이면 DNS 오류 대신 바로 안내 메시지로 실패시킨다. */
export function mongoConfigured(): boolean {
  return (uri.startsWith('mongodb://') || uri.startsWith('mongodb+srv://')) && !uri.includes('<');
}

export async function getDb(): Promise<Db> {
  if (cached.client) return cached.client.db(dbName);
  if (!mongoConfigured()) {
    throw new Error('MONGODB_URI 가 설정되지 않았습니다. .env.local 을 확인해주세요.');
  }
  if (!cached.promise) {
    cached.promise = new MongoClient(uri, { maxPoolSize: 10 }).connect();
  }
  cached.client = await cached.promise;
  return cached.client.db(dbName);
}

export async function collection<T extends Document = Document>(name: string): Promise<Collection<T>> {
  const db = await getDb();
  return db.collection<T>(name);
}

/** 컬렉션 이름 상수 — 오타 방지 + 한 곳에서 관리 */
export const COLLECTIONS = {
  products: 'products',                    // 제품 라인 + 컬러 슬롯 (프롬프트 조립 단위)
  productItems: 'product_items',           // 제품 카탈로그 70종 (판매 제품 단위)
  usageShots: 'usage_shots',               // 제품 연출컷
  poseRefs: 'pose_refs',                   // 실사 포즈 레퍼 (on=포즈·각도 / off=형태)
  talents: 'talents',                      // 전속 모델 + 아이덴티티 시트 3종 + 의상
  cuts: 'cuts',                            // 생성 컷 (legacy 이관분 + 신규 생성물)
  colorChips: 'color_chips',               // 공식 컬러칩
  houseRules: 'house_rules',               // 전 컷 공통 규칙 (구 CAUTIONS)
  sizePresets: 'size_presets',             // 규격 프리셋 (자사몰/스마트스토어/SNS)
  variationOptions: 'variation_options',   // 카메라·포즈·인물·조명·시나리오
  preservationModes: 'preservation_modes', // 업로드 레퍼런스 보존 강도
  apiUsage: 'api_usage',                   // 생성 사용량/한도
  trendImages: 'trend_images',             // 시즌 트렌드 참고 보드 (썸네일+출처만, 원본 미보관)
} as const;
