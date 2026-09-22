import { NextResponse } from 'next/server';
import { getDb, COLLECTIONS } from '@/lib/db';
import {
  writePrompt,
  type GenerationSpec,
  type RefSlot,
  type TalentSpec,
  type UploadedRefSpec,
  type EditTarget,
  type ProductSpec,
} from '@/lib/prompt-writer';
import { generateImage, loadReference, colorSwatch, GeminiError, type GenAspect, type InlineImage } from '@/lib/gemini';
import { generateImage as hfGenerate, higgsfieldConfigured, HiggsfieldError } from '@/lib/higgsfield';
import { generateImageGpt, openaiConfigured, OpenAIImageError } from '@/lib/openai-image';
import { uploadBuffer, dailySubpath, ftpConfigured } from '@/lib/ftp';
import { cropToSize, measureProductColor } from '@/lib/image-post';
import { planAspect } from '@/lib/aspect';
import { toSheet, supportPanels, panelAngleEn, isComboSheet, comboStaging, TOP_FORM_LINES, type AiProductSheet } from '@/lib/ai-products';
import { recoloredPanelUrl, normalizeHex } from '@/lib/sheet-recolor';
import { ObjectId } from 'mongodb';
import { measureSceneTone } from '@/lib/scene-tone';
import { scrubReferenceUrl, guardOutput } from '@/lib/logo-guard';
import { checkFaces } from '@/lib/face-guard';

/**
 * POST /api/generate — 자산 조합 → 프롬프트 → 나노바나나 → 크롭 → FTP → DB.
 *
 * dryRun:true 면 프롬프트와 참조 목록만 돌려주고 생성은 하지 않는다 (무과금 확인용).
 *
 * ⚠️ Vercel 함수 실행시간: Pro 2K 생성이 25~35초, 2샘플이면 60초를 넘길 수 있다.
 */

export const runtime = 'nodejs';
export const maxDuration = 300;

const USAGE_KEY = 'gemini-image';

/**
 * gemini-3-pro-image 공식 단가 ($/1M 토큰) — 실측 usageMetadata 와 곱해 실제 원가를 낸다.
 * 사고(thinking) 토큰도 출력 단가로 과금된다. 이걸 빼먹어 한동안 원가를 60%% 과소 표기했다.
 */
const PRICE_IN_PER_TOKEN = 2.0 / 1_000_000;
const PRICE_OUT_PER_TOKEN = 120.0 / 1_000_000;
const USD_TO_KRW = Number(process.env.USD_TO_KRW) || 1400;

function costFromUsage(u?: { promptTokens: number; imageTokens: number; thoughtTokens: number }): { usd: number; krw: number } | null {
  if (!u) return null;
  const usd = u.promptTokens * PRICE_IN_PER_TOKEN + (u.imageTokens + u.thoughtTokens) * PRICE_OUT_PER_TOKEN;
  return { usd: Number(usd.toFixed(5)), krw: Math.round(usd * USD_TO_KRW) };
}

/**
 * 프롬프트 작성(Opus) 원가. 단가는 env 로 뺀다 — 여기에 숫자를 박아두면
 * 요금이 바뀌었을 때 화면이 조용히 거짓말을 하게 된다.
 * 값이 없으면 원가를 null 로 두고 화면엔 실측 토큰만 보여준다.
 */
function promptCostFromUsage(u?: { input_tokens: number; output_tokens: number }): { usd: number; krw: number } | null {
  const inRate = Number(process.env.OPUS_PRICE_IN_PER_MTOK);
  const outRate = Number(process.env.OPUS_PRICE_OUT_PER_MTOK);
  if (!u || !inRate || !outRate) return null;
  const usd = (u.input_tokens * inRate + u.output_tokens * outRate) / 1_000_000;
  return { usd: Number(usd.toFixed(5)), krw: Math.round(usd * USD_TO_KRW) };
}

interface TalentPick {
  /** 전속 모델 코드. freeform 인물이면 비워둔다. */
  code?: string;
  /** 자유 서술 인물 — 전속 모델에 없는 인물(예: 한국인 중년 남성)을 텍스트로 지정 */
  freeform?: { identityEn: string; sizeEn?: string; outfitFree?: string; placement?: string };
  placement?: string;
  /** expressions._id ('soft_smile' 등) */
  expression?: string;
  outfitCode?: string;
}

interface Body {
  mode?: 'thumbnail' | 'banner';
  baseCutId?: string;
  /** ref 흐름에서 '이 레퍼런스에 담긴 제품' — 인물 대비 스케일용. products[] 와 별개 */
  refProduct?: string;
  /** 베이스 컷 사용 방식 — full(그대로 재현) | pose(포즈만 빌림) */
  baseCutUsage?: 'full' | 'pose';
  uploadedRefs?: { url: string; title: string; role?: 'style' | 'base' | 'background' }[];
  preservation?: string;
  /** 업로드 base 에서 무엇을 바꿀지 */
  editTargets?: EditTarget[];
  /** ⑥ 배경 변경 — base 에서 인물·포즈·제품만, background 업로드의 공간으로 합성 */
  backgroundSwap?: boolean;
  shapeRefKey?: string;
  poseRefKey?: string;
  usageShotId?: string;
  /** 등장 인물 — 사진 왼쪽부터 순서대로 */
  talents?: TalentPick[];
  /** 단일 제품 (기존 방식) */
  line?: string;
  colorKey?: string;
  /**
   * 다중 제품 — 한 컷에 2~3종을 위치별로. products 가 오면 line/colorKey 는 무시된다.
   * placement 예: 'left' | 'centre' | 'right'
   */
  products?: { line: string; colorKey?: string; placement?: string; sheetPanel?: SheetPanelPick }[];
  /** 단일 제품(line) 의 AI 생성 제품 칸 — products[] 로 보낼 때는 각 항목에 넣는다 */
  sheetPanel?: SheetPanelPick;
  /** 단일 제품(line) 의 화면상 위치 */
  placement?: string;
  /**
   * 화면의 작업 탭 — product(제품만 노출) | model(모델과 함께).
   * 형태 보조 칸 수를 정한다: 모델 컷은 얼굴 참조가 예산을 먼저 쓰므로 보조 칸을 줄인다.
   * 없으면 인물 유무로 판단한다 (SNS 자동화 등 다른 화면).
   */
  composition?: 'product' | 'model';
  /** 프롬프트 작성 방식 — 미지정이면 서버 기본값(PROMPT_MODE) */
  promptMode?: 'local' | 'opus';
  /**
   * 사람이 직접 쓴 프롬프트. 오면 템플릿도 Opus 도 타지 않는다 (무과금).
   * 로컬에서 대화로 뽑은 프롬프트를 그대로 붙여넣는 용도.
   */
  promptOverride?: string;
  /**
   * 조립 결과를 handoffs 컬렉션에 남긴다 (로컬 전용).
   * 화면의 선택값은 브라우저 상태라 대화 쪽에서 볼 수 없다 — 이걸 남겨야
   * "방금 고른 걸로 힉스필드로 뽑아줘"가 성립한다.
   */
  handoff?: boolean;
  sizeValue?: string;
  /** 어느 화면의 생성인가 — 'sns-auto' = SNS 자동화 (갤러리 분리 관리용) */
  origin?: string;
  /** sizeValue='custom' 일 때 직접 지정한 규격 */
  customSize?: { width: number; height: number };
  variationIds?: string[];
  direction?: string;
  samples?: number;
  tier?: 'pro' | 'draft';
  /** 생성 엔진 — gemini(나노바나나) | higgs(힉스필드 Element) */
  engine?: 'gemini' | 'higgs' | 'gpt';
  /** 출력 화질 — 기본 2K(2048px). 4K(4096px)는 POP·인쇄용 (A3 248dpi급, 단가 높음) */
  imageSize?: '1K' | '2K' | '4K';
  dryRun?: boolean;
  title?: string;
  /** 힉스필드 대기열: 이 핸드오프로 뽑을 장수 (1~4) */
  count?: number;
  /** 힉스필드 해상도 힌트 — 크레딧 추정용 (2k=1, 4k=4) */
  resolution?: '2k' | '4k';
  /** 대기열에서 알아보기 위해 사람이 붙인 이름 */
  handoffTitle?: string;
}

/** 생성 화면에서 고른 AI 생성 제품 칸 — 승인된 시트의 칸 하나가 "배치 각도"가 된다 */
interface SheetPanelPick {
  sheetId: string;
  key: string;
}

interface SizeDocLike {
  width: number;
  height: number;
  genAspect: string;
  retention: number;
  cropAxis: 'vertical' | 'horizontal' | 'none';
  label: string;
  value: string;
  /** 프리셋 묶음 — '인쇄' 면 A 규격(150ppi) 이라 생성 화질을 올린다 */
  group?: string;
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json()) as Body;
    const db = await getDb();

    // ── 1) 규격 — 프리셋 또는 직접 지정 ──────────────────────────
    let size: SizeDocLike;
    if (body.sizeValue === 'custom') {
      const w = Math.round(Number(body.customSize?.width) || 0);
      const h = Math.round(Number(body.customSize?.height) || 0);
      if (w < 64 || h < 64 || w > 8192 || h > 8192) {
        return NextResponse.json({ ok: false, error: '직접 지정 규격은 64~8192px 범위여야 합니다.' }, { status: 400 });
      }
      const plan = planAspect(w, h);
      size = { width: w, height: h, ...plan, label: `직접 지정 (${w}×${h})`, value: 'custom' };
    } else {
      const doc = await db
        .collection(COLLECTIONS.sizePresets)
        .findOne({ _id: (body.sizeValue || '1000x1000') as never });
      if (!doc) {
        return NextResponse.json({ ok: false, error: `사이즈 프리셋을 찾을 수 없습니다: ${body.sizeValue}` }, { status: 400 });
      }
      size = doc as unknown as SizeDocLike;
    }

    // ── 2) 자산 로딩 ──────────────────────────────────────────────
    const talentPicks = (body.talents ?? []).slice(0, 4);

    /*
     * ── 2.4) 인쇄 규격은 4K 로 강제 ──
     * A1(3508×4967) 같은 인쇄용은 2K(2048) 로 뽑으면 cropToSize 가 2.4배로 늘려서
     * 인쇄에서 흐려진다. 150ppi 를 맞추려고 만든 규격이므로 화질을 아끼면 의미가 없다.
     * 4K(4096) 로 뽑아도 A1 은 1.2배 확대가 남지만 그 정도는 인쇄에서 견딘다.
     */
    // 해상도 규칙(인쇄 4K·얼굴 보호 2K)은 GPT 에 해당하지 않는다 — GPT 는 최대 1536px
    const gptRequested = body.engine === 'gpt';
    const isPrint = size.group === '인쇄' || Math.max(size.width, size.height) >= 2500;
    if (isPrint && !gptRequested) body.imageSize = '4K';

    /*
     * ── 2.5) 얼굴 보호 강제 상향 — 전속 모델이 들어간 컷(모델 변경 포함)은 서버가 해상도를 올려버린다 ──
     * 실측 사고(9/3): 작업자가 1000×1000 으로 전신 모델 변경 컷을 뽑아 얼굴이 ~50px 로 뭉개짐
     * (Max 네이비, ΔE 9.2/7.2). 생성은 2K 로 잘 됐어도 cropToSize 가 1000px 로 줄이며 얼굴 픽셀을 버린다.
     * 안내로는 안 지켜지므로(사용자 지시: "아예 올려버려야 해") 요청값과 무관하게
     *   ① 생성 화질 최소 2K (4K 요청은 존중)
     *   ② 결과 파일 짧은 변 2048 목표 — 단, 생성 픽셀을 넘는 뻥튀기 업스케일은 하지 않는다
     * 비율은 그대로라 배치·용도는 안 바뀌고 파일만 커진다. 자유 인물(freeform)만 있으면 건드리지 않는다.
     */
    if (talentPicks.some((t) => !t.freeform)) {
      if (!gptRequested && body.imageSize !== '4K') body.imageSize = '2K';
      const genLong = body.imageSize === '4K' ? 4096 : 2048;
      const shortSide = Math.min(size.width, size.height);
      const longSide = Math.max(size.width, size.height);
      const k = Math.min(2048 / shortSide, genLong / longSide);
      if (k > 1.01) {
        const w2 = Math.round(size.width * k);
        const h2 = Math.round(size.height * k);
        size = { ...size, width: w2, height: h2, label: `${size.label} · 얼굴보호 ${w2}×${h2}` };
      }
    }
    const [baseCut, productDocs, talentDocs, shapeRef, poseRef, usageShot, preservation, variations, rules, exprDocs] =
      await Promise.all([
        body.baseCutId ? db.collection('cuts').findOne({ url: body.baseCutId }) : null,
        // 다중이면 products[], 아니면 line 하나. 어느 쪽이든 배열로 받는다.
        (() => {
          const lines = body.products?.length
            ? [...new Set(body.products.map((x) => x.line))]
            : body.line ? [body.line] : [];
          return lines.length
            ? db.collection('products').find({ _id: { $in: lines as never[] } }).toArray()
            : [];
        })(),
        talentPicks.length
          ? db.collection('talents').find({ _id: { $in: talentPicks.map((t) => t.code) as never[] } }).toArray()
          : [],
        body.shapeRefKey ? db.collection('pose_refs').findOne({ _id: body.shapeRefKey as never }) : null,
        body.poseRefKey ? db.collection('pose_refs').findOne({ _id: body.poseRefKey as never }) : null,
        body.usageShotId ? db.collection('usage_shots').findOne({ _id: body.usageShotId as never }) : null,
        body.preservation ? db.collection('preservation_modes').findOne({ _id: body.preservation as never }) : null,
        body.variationIds?.length
          ? db.collection('variation_options').find({ _id: { $in: body.variationIds as never[] } }).toArray()
          : [],
        db.collection('house_rules').find({ enabled: true, appliesTo: 'image' }).sort({ order: 1 }).toArray(),
        db.collection('expressions').find({}).toArray(),
      ]);

    const exprById = new Map(exprDocs.map((e) => [String(e._id), e]));
    const talentById = new Map(talentDocs.map((t) => [String(t._id), t]));

    // 선택 순서(사진 왼쪽부터)를 보존하며 TalentSpec 으로 변환
    const talents: TalentSpec[] = [];
    for (const pick of talentPicks) {
      // 자유 서술 인물 — 전속 모델에 없는 인물(한국인 중년 남성 등). 얼굴 시트가 없으므로
      // freeform 플래그로 표시해서 prompt-writer 가 참조 슬롯을 잡지 않게 한다.
      if (pick.freeform?.identityEn) {
        talents.push({
          code: '',
          category: 'freeform',
          slot: '',
          identityEn: pick.freeform.identityEn,
          sizeEn: pick.freeform.sizeEn || '',
          freeform: true,
          ...(pick.freeform.outfitFree ? { outfitFree: pick.freeform.outfitFree } : {}),
          ...(pick.freeform.placement || pick.placement ? { placement: pick.freeform.placement || pick.placement } : {}),
        });
        continue;
      }
      if (!pick.code) continue;
      const t = talentById.get(pick.code);
      if (!t) continue;
      const expr = pick.expression ? exprById.get(pick.expression) : null;
      const outfit = t.outfits?.find((o: { code: string }) => o.code === pick.outfitCode);
      talents.push({
        code: String(t.code),
        category: String(t.category),
        slot: String(t.slot),
        identityEn: String(t.identityEn || t.thumbDesc || t.identity || ''),
        sizeEn: String(t.sizeEn || t.size || ''),
        ...(t.rep ? { repShot: String(t.rep) } : {}),
        ...(pick.expression && t.expressionCrops?.[pick.expression]
          ? { expressionCrop: String(t.expressionCrops[pick.expression]) }
          : {}),
        ...(t.exprSheet ? { exprSheet: String(t.exprSheet) } : {}),
        ...(expr ? { expression: { kr: String(expr.kr), en: String(expr.en) } } : {}),
        ...(outfit
          ? { outfit: { code: outfit.code, desc: outfit.desc, descEn: outfit.descEn || '', ...(outfit.cropUrl ? { cropUrl: outfit.cropUrl } : {}) } }
          : {}),
        ...(pick.placement ? { placement: pick.placement } : {}),
      });
    }

    /*
     * 결과물 얼굴 대조에 쓸 참조 — 각도가 여러 장인 얼굴 시트가 대표컷보다 낫다
     * (생성된 얼굴이 정면이 아닐 때 대표컷 하나로는 각도 차이를 동일인 아님으로 오판한다).
     * 자유 서술 인물(freeform)은 지킬 얼굴이 없으므로 검사하지 않는다.
     */
    const faceRefs = talents
      .filter((t) => !t.freeform)
      .map((t) => {
        const doc = talentDocs.find((d) => String(d.code) === t.code);
        const url = String(doc?.sheets?.face || doc?.rep || '');
        return url ? { code: t.code, faceUrl: url } : null;
      })
      .filter((x): x is { code: string; faceUrl: string } => !!x);

    const uploadedRefs: UploadedRefSpec[] = (body.uploadedRefs ?? []).map((u) => ({
      url: u.url,
      title: u.title,
      role: u.role ?? 'style',
    }));

    /*
     * 장면 지시가 있으면 'no-scene' 규칙(스튜디오 배경 #f2f2f4)은 뺀다.
     * 업로드 base/background 가 있어도 마찬가지 — 배경은 그 이미지가 결정한다.
     */
    const hasScene =
      !!body.direction?.trim() ||
      (body.variationIds ?? []).some((v) => v.startsWith('scene:') && !v.endsWith(':auto')) ||
      uploadedRefs.some((u) => u.role === 'base' || u.role === 'background');
    /*
     * 규칙 필터링:
     *  - no-scene: 장면 지시가 있으면 스튜디오 배경 규칙을 뺀다
     *  - requires: 그 대상이 선택되지 않았으면 뺀다
     *    (인물 없는 제품컷에 "자연스러운 미소", 제품 없는 컷에 "Max 엔 지퍼가 없다" 가
     *     붙던 문제 — 무관한 규칙은 노이즈이고 모델을 헷갈리게 한다)
     */
    const hasTalent = talents.length > 0;
    const hasProduct = (body.products?.length ?? 0) > 0 || !!body.line;
    const activeRules = rules.filter((r) => {
      if (r.conditional === 'no-scene' && hasScene) return false;
      if (r.requires === 'talent' && !hasTalent) return false;
      if (r.requires === 'product' && !hasProduct) return false;
      return true;
    });

    /*
     * 제품 스펙 조립 — 단일(line/colorKey)이든 다중(products[])이든 배열로 만든다.
     * 다중이면 placement 로 위치를 못박아야 색·형태가 뒤섞이지 않는다.
     */
    const productById = new Map(productDocs.map((d) => [String(d._id), d]));
    const picks: { line: string; colorKey?: string; placement?: string; sheetPanel?: SheetPanelPick }[] = body.products?.length
      ? body.products
      : body.line ? [{ line: body.line, colorKey: body.colorKey, placement: body.placement, sheetPanel: body.sheetPanel }] : [];

    /*
     * AI 생성 제품 시트 — 화면에서 고른 칸의 시트만 읽는다. **승인된 것만** 쓴다
     * (자산관리 > AI 생성 제품의 "형태 기준으로 승인"이 곧 생성 사용 허가다).
     * 승인이 풀렸거나 숨긴 시트를 고른 채 남아 있으면 조용히 공식 사진 경로로 돌아간다.
     */
    const sheetIds = [...new Set(picks.map((x) => x.sheetPanel?.sheetId).filter((v): v is string => !!v && ObjectId.isValid(v)))];
    const sheetById = new Map<string, AiProductSheet>(
      sheetIds.length
        ? (await db.collection(COLLECTIONS.aiProducts)
            .find({ _id: { $in: sheetIds.map((v) => new ObjectId(v)) }, status: 'approved', hidden: { $ne: true } })
            .toArray()).map((d) => [String(d._id), toSheet(d)])
        : [],
    );
    /*
     * 형태 보조 칸 수 — 배치 각도 칸 1장 + 같은 시트의 다른 각도.
     * 제품만: 2장 (정면·측면·45° 중 둘이면 입체가 잡힌다)
     * 모델과 함께: 1장 (얼굴 대표컷·표정컷이 참조 예산을 먼저 쓴다)
     * 제품 여러 종: 0장 (제품마다 배치 각도 칸만 — 한 종이 칸을 다 먹으면 나머지 형태가 무너진다)
     */
    const withPeople = body.composition ? body.composition === 'model' : talentPicks.length > 0;
    const supportsPerProduct = picks.length > 1 ? 0 : withPeople ? 1 : 2;

    // 카메라 변형이 지정되면 그 각도의 공식 뷰를 우선 붙인다 (미지정=¾)
    const cameraPick = (body.variationIds ?? []).find((v) => v.startsWith('camera:'))?.split(':')[1];
    const ANGLE_PREF: Record<string, string[]> = {
      front: ['front', 'side'],
      '45deg': ['a045', 'side', 'front'],
      side: ['side', 'front'],
      top: ['front', 'side'],
      low: ['front', 'side'],
    };
    const wantedAngles = ANGLE_PREF[cameraPick ?? ''] ?? ['a045', 'side', 'front'];
    // 제품이 여러 종이면 참조 예산을 나눠 쓴다 (한 종이 뷰를 다 먹으면 나머지가 형태를 못 잡는다).
    // 단독 제품은 3장(정면·측면·45도)까지 — 형태가 생성마다 흔들리는 걸 각도 수로 눌러 잡는다
    const viewsPerProduct = picks.length > 1 ? 1 : 3;

    const productSpecs: ProductSpec[] = [];
    for (const pick of picks) {
      const doc = productById.get(pick.line);
      if (!doc) continue;
      let col = doc.colors?.find((c: { key: string }) => c.key === pick.colorKey);
      /*
       * 이 라인에 등록 안 된 컬러도 받는다 — 컬러 칩은 전 라인 공통 슬롯(맥스 기준)이라
       * 미니에 맥스 전용 컬러를 고를 수 있다. 이름·hex 는 그 컬러를 가진 다른 라인에서
       * 빌려오고, 뷰(views)는 라인이 달라 안 빌린다 → 아래 형태 폴백(같은 라인 다른 컬러
       * → shapeViews)이 형태를 잡고, 색은 이름·hex 로 지시된다.
       */
      if (!col && pick.colorKey) {
        const donor = await db.collection('products').findOne({ 'colors.key': pick.colorKey });
        const hit = (donor?.colors as { key: string; name: string; nameEn?: string; hex?: string }[] | undefined)
          ?.find((c) => c.key === pick.colorKey);
        if (hit) col = { name: hit.name, nameEn: hit.nameEn, hex: hit.hex };
      }

      /*
       * 공식 뷰 — 3단 폴백.
       *   ① 이 컬러의 뷰            (색까지 맞음)
       *   ② 같은 라인 다른 컬러의 뷰 (형태만)
       *   ③ shapeViews             (형태만 — legacy 에만 남은 단종 컬러. 이게 없으면
       *                             팟·드롭·피라미드·슬림·미니·서포트는 사진 참조가 0장이 된다)
       * 사진 참조 없이 텍스트만으로 형태를 지시하면 제품이 다른 물건으로 나온다 —
       * 이 프로젝트에서 확인된 가장 큰 품질 요인이다.
       */
      const views: NonNullable<ProductSpec['views']> = [];

      /*
       * ① AI 생성 제품 칸을 골랐으면 — 그 칸이 제품의 정답이다 (사용자 확정 방식:
       *    "내가 만든 AI 생성 제품 + 배경 + 배치 + 색상").
       *    대표 컷·공식 사진은 넣지 않는다. 다른 생성에서 나온 형태가 섞이면 모델이 평균을 내
       *    형태가 무너진다(드롭 꼭지 사고). 색은 칸 픽셀을 컬러칩 hex 로 먼저 바꿔서 넣는다.
       */
      const editBase = (!!baseCut && body.baseCutUsage !== 'pose') || uploadedRefs.some((u) => u.role === 'base');
      const sheet = pick.sheetPanel && !editBase ? sheetById.get(pick.sheetPanel.sheetId) : undefined;
      const primaryPanel = sheet && sheet.line === doc.line ? sheet.panels.find((x) => x.key === pick.sheetPanel!.key) : undefined;
      if (sheet && primaryPanel) {
        const wantHex = normalizeHex(col?.hex);
        // 시트 색과 고른 색이 같으면(또는 색을 안 골랐으면) 칸을 그대로 쓴다
        const sameColor = !wantHex || (!!pick.colorKey && pick.colorKey === sheet.colorKey) || wantHex === normalizeHex(sheet.hex);
        const place = async (panel: { key: string; label: string; url: string }, primary: boolean) => {
          const rc = sameColor ? { url: panel.url, recolored: false } : await recoloredPanelUrl(panel.url, wantHex);
          views.push({
            angle: panel.key,
            url: rc.url,
            colorMatched: sameColor || rc.recolored,
            source: 'sheet',
            primary,
            recolored: rc.recolored,
            label: panel.label,
            angleEn: panelAngleEn(doc.line, panel.key),
          });
        };
        await place(primaryPanel, true);
        for (const sp of supportPanels(sheet, primaryPanel.key, supportsPerProduct)) await place(sp, false);
      } else {
        /*
         * ② 칸을 안 골랐으면 기존 경로 — 대표(캐노니컬) 컷 + 공식 뷰 3단 폴백.
         * 대표 컷은 형태·로고까지 확정한 마스터 렌더 (드롭·팟·라운저·피라미드).
         * 어떤 컬러를 고르든 항상 1순위 앵커로 들어간다 — "우리가 지정한 제품컷이 정답"
         * (사용자 확정). 색은 텍스트(hex)가, 조명은 씬이 다시 정한다.
         */
        const canonicalUrl: string | null = doc.shapeViews?.canonical ? (doc.shapeViews?.views?.front ?? null) : null;
        if (canonicalUrl) views.push({ angle: 'front', url: canonicalUrl, colorMatched: false, canonical: true });
        let viewSrc: Record<string, string> | undefined = col?.views;
        let colorMatched = true;
        if (!viewSrc || !Object.keys(viewSrc).length) {
          viewSrc = doc.colors?.find((c: { views?: Record<string, string> }) => c.views && Object.keys(c.views).length)?.views;
          colorMatched = false;
        }
        if (!viewSrc || !Object.keys(viewSrc).length) {
          viewSrc = doc.shapeViews?.views;
          colorMatched = false;
        }
        if (viewSrc) {
          for (const a of wantedAngles) {
            if (views.length >= viewsPerProduct) break;
            if (viewSrc[a] && viewSrc[a] !== canonicalUrl) views.push({ angle: a, url: viewSrc[a], colorMatched });
          }
        }
      }

      // "연출: <영문>" 지침 — 컬러별 판매 데이터(product_items)가 우선,
      // 없으면 제품 문서의 notes (youtube 에서 끌어온 사용법 서술)에서 찾는다
      let staging = '';
      if (pick.colorKey) {
        const item = await db.collection('product_items').findOne({ line: doc.line, colorKey: pick.colorKey });
        staging = String(item?.notes || '').match(/연출:\s*([^·]+)/)?.[1]?.trim() ?? '';
      }
      if (!staging && doc.notes) {
        staging = String(doc.notes).match(/연출:\s*([^·]+)/)?.[1]?.trim() ?? '';
      }

      productSpecs.push({
        line: doc.line,
        // 메이트 인형·소품은 기하 서술이 없다 — 뷰 사진과 실측 치수가 형태를 잡는다
        shape: doc.geometry?.shape ?? `${doc.category || 'accessory'} — follow the reference views for its exact shape`,
        negative: doc.geometry?.negative ?? '',
        modes: doc.geometry?.modes ?? '',
        dims: doc.dims,
        scalePrompt: doc.scalePrompt,
        ...(col ? { color: { name: col.name, nameEn: col.nameEn || col.name, hex: col.hex } } : {}),
        ...(staging ? { staging } : {}),
        ...(views.length ? { views } : {}),
        ...(pick.placement ? { placement: pick.placement } : {}),
      });
    }

    // 첫 제품 — 컬러 측정·파일명·DB 기록·Element 토큰의 대표값으로 쓴다
    const product = picks[0] ? productById.get(picks[0].line) ?? null : null;
    // 대표 컬러 — 라인에 없는 슬롯 컬러면 위에서 빌려온 스펙의 색을 그대로 쓴다 (ΔE 측정·기록용)
    const color = product?.colors?.find((c: { key: string }) => c.key === picks[0]?.colorKey)
      ?? (productSpecs[0]?.color
        ? { name: productSpecs[0].color.name, nameEn: productSpecs[0].color.nameEn, hex: productSpecs[0].color.hex }
        : null);

    // ── 3) 프롬프트 작성 ──────────────────────────────────────────
    /*
     * 레퍼런스에 담긴 제품 — 인물 대비 스케일을 못박기 위해서만 쓴다.
     * 명시 제품(products[])이 이미 있으면 그게 스케일까지 담당하므로 중복으로 안 넣는다.
     */
    const scaleProductDoc = !productSpecs.length && body.refProduct
      ? await db.collection('products').findOne({ _id: body.refProduct as never })
      : null;

    /*
     * 배경 합성은 두 사진이 다 있을 때만 켠다 — 화면이 플래그만 보내고 사진 한쪽이 빠지면
     * 프롬프트가 "배경 사진" 을 가리키는데 그 사진이 없는 상태가 된다.
     */
    const bgSwapOn = !!body.backgroundSwap
      && uploadedRefs.some((u) => u.role === 'base')
      && uploadedRefs.some((u) => u.role === 'background');

    /*
     * 배경 톤 측정 — 배경 사진(없으면 분위기 참고 사진)의 화이트밸런스·밝기·대비·암부·채도·빛 방향.
     * 편집 베이스는 원본을 그대로 재현하는 흐름이라 재지 않는다. 로컬 계산이라 비용이 없다.
     * 단 배경 합성(② 편집 원본 + ⑥ 배경)은 공간·조명이 배경 사진에서 오므로 배경을 잰다 —
     * 안 재면 인물·제품이 원본의 스튜디오 톤 그대로 붙어 나온다
     * (사용자 요청 2026-09-22: "배경으로 지정했을 때는 제품·모델이 배경에 맞게 톤조절").
     */
    const toneSource = uploadedRefs.find((u) => u.role === 'background') ?? uploadedRefs.find((u) => u.role === 'style');
    const hasEditBase = uploadedRefs.some((u) => u.role === 'base') || (!!baseCut && body.baseCutUsage !== 'pose');
    const sceneTone = toneSource && (!hasEditBase || bgSwapOn) ? await measureSceneTone(toneSource.url) : null;

    /*
     * 제품 조합 — 고른 칸이 조합 시트면, 그 시트가 두 제품을 다 들고 있다.
     * 칸 자체는 위에서 이미 제품 참조로 들어갔다. 여기서는 공식 실사와 배치 지시를 얹는다.
     * 시트에 적힌 두 제품이 실제로 다 골라져 있을 때만 켠다 — 한쪽만 고른 채 조합 칸을 쓰면
     * 프롬프트가 화면에 없는 제품을 그리라고 말하게 된다.
     */
    const comboSrc = picks
      .map((x) => (x.sheetPanel ? sheetById.get(x.sheetPanel.sheetId) : undefined))
      .find((sh): sh is AiProductSheet => !!sh && isComboSheet(sh));
    const comboLines = comboSrc?.comboLines ?? [];
    const comboOn = comboLines.length >= 2 && comboLines.every((l) => productSpecs.some((ps) => ps.line === l));
    const combo = comboOn
      ? { lines: comboLines, ...(comboSrc?.realRef ? { realRef: comboSrc.realRef } : {}), staging: comboStaging(comboLines) }
      : undefined;

    const spec: GenerationSpec = {
      mode: body.mode || 'thumbnail',
      ...(sceneTone ? { sceneTone: sceneTone.summaryEn } : {}),
      ...(baseCut
        ? { baseCut: { url: baseCut.url, spec: baseCut.spec, line: baseCut.line, colorName: baseCut.colorName, usage: body.baseCutUsage ?? 'full' } }
        : {}),
      uploadedRefs,
      ...(body.editTargets?.length ? { editTargets: body.editTargets } : {}),
      ...(bgSwapOn ? { backgroundSwap: true } : {}),
      ...(preservation
        ? { preservation: { value: preservation.value, label: preservation.label, instruction: preservation.instruction } }
        : {}),
      ...(shapeRef ? { shapeRef: { url: shapeRef.offUrl, name: shapeRef.name } } : {}),
      ...(poseRef ? { poseRef: { url: poseRef.onUrl, name: poseRef.name } } : {}),
      ...(usageShot ? { usageShot: { url: usageShot.url, kindEn: usageShot.kindEn, kindKr: usageShot.kindKr } } : {}),
      ...(talents.length ? { talents } : {}),
      ...(productSpecs.length ? { products: productSpecs } : {}),
      ...(combo ? { combo } : {}),
      // 레퍼런스에 담긴 제품이 지정되면 인물 대비 스케일 앵커를 넣는다 (제품 블록과 무관하게)
      ...(scaleProductDoc
        ? { scaleProduct: { line: scaleProductDoc.line, dims: scaleProductDoc.dims ?? {}, scalePrompt: scaleProductDoc.scalePrompt ?? '' } }
        : {}),
      size: {
        width: size.width,
        height: size.height,
        genAspect: size.genAspect,
        retention: size.retention,
        cropAxis: size.cropAxis,
        label: size.label,
      },
      variations: variations.map((v) => ({ axis: v.axis, label: v.label, hint: v.hint })),
      ...(body.direction ? { direction: body.direction } : {}),
      houseRules: activeRules.map((r) => r.en).filter(Boolean),
      // 스토리보드 연속 컷은 앞 컷을 배경으로 넘긴다 — 가구를 지우면 컷끼리 안 이어진다
      clearBlockingFurniture: body.origin !== 'storyboard',
    };

    /*
     * 넘기기는 절대 Opus 를 타지 않는다.
     * 이 경로의 결과물은 대화로 넘어가서 거기서 프롬프트가 다시 쓰인다 —
     * 앱이 Opus 로 한 번 쓰면 그 토큰(1회 약 9,300개)은 그냥 버려진다.
     * env(PROMPT_MODE)가 opus 여도 여기서는 무조건 무과금 템플릿으로 조립한다.
     * 필요한 건 참조 순서와 선택값이지 완성된 문장이 아니다.
     */
    const written = await writePrompt(spec, {
      mode: body.handoff ? 'local' : body.promptMode,
      manualPrompt: body.promptOverride,
    });

    /*
     * ── 사진 참조의 태그를 먼저 지운다 (logo-guard.ts) ─────
     * 글로 "로고 없음" 이라고 해도 참조 사진에 태그가 보이면 그대로 옮겨 그린다(실측 2026-09-15).
     * 사진류(포즈 소스·베이스·배경·스타일·형태·연출·공식 제품 사진)만 — 모델 시트·의상 크롭·AI 제품 칸·스와치는
     * 태그가 없는 자산이라 검사하지 않는다. URL 만 바뀌고 순서·역할은 그대로라 프롬프트는 다시 쓸 필요가 없다.
     * 힉스필드도, 대화로 넘기는 기록(handoff)도 이 URL 을 받으므로 모든 경로가 지운 사본을 본다.
     * 단순 미리보기(dryRun, 넘기기 아님)는 무과금이어야 해서 검사하지 않는다.
     */
    const SCRUB_KINDS = new Set<RefSlot['kind']>(['base', 'background', 'style', 'shape', 'pose', 'usage', 'product']);
    const originalOf = new Map<string, string>();
    const doScrub = !body.dryRun || !!body.handoff;
    const refsToLoad: RefSlot[] = await Promise.all(written.refs.map(async (r) => {
      if (!doScrub || !r.url || r.swatchHex || !SCRUB_KINDS.has(r.kind)) return r;
      const s = await scrubReferenceUrl(r.url);
      if (!s.cleaned) return r;
      originalOf.set(s.url, r.url);
      return { ...r, url: s.url };
    }));

    /*
     * 넘기기 기록 — 프롬프트 + 참조 순서 + 화면에서 고른 값 원본을 통째로 남긴다.
     * 배포에서는 남기지 않는다: MD 용 기능이 아니고, 쌓아둘 이유도 없다.
     */
    let handoffId: string | null = null;
    if (body.dryRun && body.handoff && process.env.NODE_ENV !== 'production') {
      const r = await db.collection('handoffs').insertOne({
        createdAt: new Date(),
        prompt: written.prompt,
        promptMode: written.mode,
        refs: refsToLoad.map((x) => ({
          kind: x.kind, title: x.title, url: x.url ?? '', swatchHex: x.swatchHex ?? '', role: x.role,
          ...(x.url && originalOf.has(x.url) ? { originalUrl: originalOf.get(x.url) } : {}),
        })),
        aspect: size.genAspect,
        target: { width: size.width, height: size.height },
        sizeLabel: size.label,
        // 화면에서 고른 값 그대로 — 나중에 무엇을 골랐는지 되살릴 수 있어야 한다
        selection: {
          mode: body.mode ?? null,
          editTargets: body.editTargets ?? [],
          preservation: body.preservation ?? null,
          talents: body.talents ?? [],
          products: body.products ?? (body.line ? [{ line: body.line, colorKey: body.colorKey }] : []),
          ...(body.refProduct ? { refProduct: body.refProduct } : {}),
          uploadedRefs: body.uploadedRefs ?? [],
          direction: body.direction ?? '',
          sizeValue: body.sizeValue ?? '',
        },
        // 대기열 관리용 — 장수·해상도로 크레딧을 추정하고, 이름으로 알아본다
        count: Math.max(1, Math.min(4, Math.round(Number(body.count) || 1))),
        resolution: body.resolution === '4k' ? '4k' : '2k',
        title: (body.handoffTitle || '').trim() || size.label,
        status: 'queued',
        used: false,
      });
      handoffId = String(r.insertedId);
    }

    if (body.dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        prompt: written.prompt,
        promptMode: written.mode,
        refs: refsToLoad.map((r) => ({ kind: r.kind, title: r.title, url: r.url, swatchHex: r.swatchHex })),
        aspect: size.genAspect,
        target: { width: size.width, height: size.height },
        elementId: color?.elementId ?? null,
        usage: written.usage ?? null,
        promptCost: promptCostFromUsage(written.usage),
        ...(handoffId ? { handoffId } : {}),
      });
    }

    if (!ftpConfigured()) {
      return NextResponse.json({ ok: false, error: 'FTP 설정이 없습니다 (.env.local).' }, { status: 500 });
    }

    /*
     * 엔진은 요청 그대로 — 제품 컷도 GPT 로 만들 수 있다.
     * 2026-09-14 에 "제품이 들어가면 무조건 제미나이" 로 막았다가 되돌렸다 (사용자 지시 2026-09-15):
     * 제미나이 프로젝트가 월 지출 한도(429 "exceeded its monthly spending cap")에 걸리면 GPT 가 유일한 길이다.
     * 단 실측상 GPT 는 제품 형태를 참조대로 못 그린다(맥스·라운저가 다른 의자로) — 화면에서 경고한다.
     */
    const engine = body.engine === 'higgs' ? 'higgs' : body.engine === 'gpt' ? 'gpt' : 'gemini';
    if (engine === 'higgs' && !higgsfieldConfigured()) {
      return NextResponse.json({ ok: false, error: 'Higgsfield 설정이 없습니다 (.env.local).' }, { status: 500 });
    }
    if (engine === 'gpt' && !openaiConfigured()) {
      return NextResponse.json({ ok: false, error: 'OPENAI_API_KEY 가 없습니다 — .env.local 에 넣고 dev 를 재시작하세요.' }, { status: 500 });
    }
    /*
     * GPT 허들 — 전속 모델(얼굴 시트 보유) 컷에는 GPT 를 쓸 수 없다.
     * gpt-image-1 은 참조 얼굴을 유지하지 못해(실측) 브랜드 모델 일관성이 깨진다.
     * 인물 없는 컷과 AI 가상 인물(freeform)만 통과한다. 화면에도 같은 가드가 있다.
     */
    if (engine === 'gpt' && !body.dryRun && talents.some((t) => !t.freeform)) {
      return NextResponse.json(
        { ok: false, error: 'GPT는 전속 모델 컷에 쓸 수 없습니다 — 인물 없는 컷 또는 AI 가상 인물만 가능합니다 (얼굴 유지가 안 됩니다).' },
        { status: 400 },
      );
    }

    // ── 4) 사용량 한도 ────────────────────────────────────────────
    const samples = Math.max(1, Math.min(2, body.samples ?? 1));
    const limit = Number(process.env.GEMINI_USAGE_LIMIT) || 300;
    const usageCol = db.collection(COLLECTIONS.apiUsage);
    const usage = await usageCol.findOneAndUpdate(
      { _id: USAGE_KEY as never },
      { $setOnInsert: { count: 0, limit } },
      { upsert: true, returnDocument: 'after' },
    );
    const cur = usage?.count ?? 0;
    const cap = usage?.limit ?? limit;
    if (engine === 'gemini' && cur + samples > cap) {
      return NextResponse.json(
        { ok: false, error: `생성 한도 초과 — ${cur}/${cap} 장 사용됨. 관리자가 한도를 늘려야 합니다.`, usage: { count: cur, limit: cap } },
        { status: 429 },
      );
    }


    // ── 5) 참조 이미지 적재 (순서가 프롬프트와 일치해야 한다) ─────
    const inline: InlineImage[] = [];
    const usedRefs: RefSlot[] = [];
    for (const slot of refsToLoad) {
      let r = slot;
      // 모델 시트는 다패널이라 덜 줄인다 — 1024 로 줄이면 얼굴이 판독 불가 크기가 된다
      let img = r.swatchHex
        ? await colorSwatch(r.swatchHex)
        : r.url
          ? await loadReference(r.url, r.kind === 'talent' ? 1600 : 1024)
          : null;
      // 태그 지운 사본을 못 받으면 원래 사진으로 — 참조가 통째로 빠지는 것보다 태그 있는 사진이 낫다(결과 검사가 한 번 더 막는다)
      if (!img && r.url && originalOf.has(r.url)) {
        const orig = originalOf.get(r.url)!;
        console.warn('[generate] 태그 지운 사본 로딩 실패 — 원본 사진으로:', r.url);
        img = await loadReference(orig, 1024);
        if (img) { originalOf.delete(r.url); r = { ...r, url: orig }; }
      }
      if (!img) {
        console.warn('[generate] 참조 로딩 실패 — 건너뜀:', r.title, r.url);
        continue;
      }
      inline.push(img);
      usedRefs.push(r);
    }
    if (usedRefs.length !== written.refs.length) {
      // 참조가 빠지면 FIRST/SECOND 번호가 어긋난다 — 프롬프트를 다시 쓴다
      console.warn(`[generate] 참조 ${written.refs.length - usedRefs.length}장 누락 — 프롬프트 재작성`);
      const redone = await writePrompt(spec, { mode: body.handoff ? 'local' : body.promptMode, manualPrompt: body.promptOverride });
      written.prompt = redone.prompt;
    }

    // ── 6) 생성 ───────────────────────────────────────────────────
    const isoNow = new Date().toISOString();
    const results: Record<string, unknown>[] = [];
    let produced = 0;

    for (let n = 1; n <= samples; n++) {
      let gen: {
        buffer: Buffer; model: string; elapsedMs: number; requestBytes: number;
        usage?: { promptTokens: number; imageTokens: number; thoughtTokens: number; totalTokens: number };
      };
      try {
        if (engine === 'higgs') {
          const r = await hfGenerate({
            prompt: written.prompt,
            // 힉스필드는 공개 URL 을 자체 스토리지로 가져간다 (스와치는 URL 이 없어 제외)
            referenceUrls: usedRefs.filter((x) => x.url).map((x) => x.url as string),
            aspect: size.genAspect,
            ...(color?.elementId ? { elementId: String(color.elementId) } : {}),
          });
          gen = { buffer: r.buffer, model: `higgsfield/${r.model}${r.usedElement ? '+element' : ''}`, elapsedMs: r.elapsedMs, requestBytes: 0 };
        } else if (engine === 'gpt') {
          // GPT(gpt-image-1) — 최대 1536px 라 imageSize(4K)는 받지 않는다. 참조는 edits 로 들어간다.
          const r = await generateImageGpt({
            prompt: written.prompt,
            references: inline,
            aspect: size.genAspect,
          });
          gen = { buffer: r.buffer, model: r.model, elapsedMs: r.elapsedMs, requestBytes: r.requestBytes };
        } else {
          gen = await generateImage({
            prompt: written.prompt,
            references: inline,
            aspect: size.genAspect as GenAspect,
            tier: body.tier ?? 'pro',
            // 화질 — 기본 2K, POP·인쇄용은 4K(4096px). gemini.ts 가 검증한다.
            ...(body.imageSize ? { size: body.imageSize } : {}),
          });
        }
      } catch (e) {
        const err = e as GeminiError & HiggsfieldError & OpenAIImageError;
        results.push({ ok: false, error: err.message, blockReason: err.blockReason ?? null, status: err.status ?? null });
        /*
         * 힉스필드가 크레딧 부족을 내면 표시 잔액을 0 으로 못박는다.
         * 앱이 쓰는 API 키와 MCP 계정은 지갑이 달라서, MCP 잔액을 기준값으로 넣어두면
         * 화면은 "2,386 크레딧 남음"이라 말하는데 생성은 403 으로 죽는다.
         * 한 번 겪은 일이라, 실패를 본 즉시 화면이 거짓말을 멈추게 한다.
         */
        if (engine === 'higgs' && /not enough credits|insufficient/i.test(err.message || '')) {
          await usageCol.updateOne(
            { _id: 'higgs-image' as never },
            { $set: { baseline: 0, count: 0, depleted: true, lastErrorAt: new Date() } },
            { upsert: true },
          );
        }
        if (err.status === 422 || err.quotaExhausted) break; // 같은 요청은 같은 이유로 또 막힌다
        continue;
      }

      const croppedRaw = await cropToSize(gen.buffer, size.width, size.height);
      /*
       * 결과물 검사 (logo-guard.ts) — 참조를 지웠어도 모델이 태그를 새로 그릴 수 있다.
       * 남은 태그는 그 자리만 주변 원단으로 메운다(다시 생성하지 않으니 얼굴·구도는 그대로).
       * 피라미드가 아닌 빈백의 윗부분 말림은 지우는 게 아니라 다시 뽑아야 하는 문제라 표시만 한다.
       */
      // 프롬프트 TOP FORM 과 같은 목록 (ai-products.ts TOP_FORM_LINES) — 둘이 어긋나면 안 된다
      const foldTargets = productSpecs.filter((p) => TOP_FORM_LINES.has(p.line));
      const guard = await guardOutput(croppedRaw.buffer, {
        topFold: foldTargets.length > 0,
        // 정답 형태를 같이 줘야 "꽉 찬 물방울이라 정상" 같은 오판을 안 한다
        expectedShapes: foldTargets.map((p) => `Yogibo ${p.line}: ${p.shape}`),
        exemptProducts: productSpecs.filter((p) => !TOP_FORM_LINES.has(p.line)).map((p) => `the Yogibo ${p.line}`),
      });
      const cropped = { ...croppedRaw, buffer: guard.buffer };
      /*
       * 얼굴 대조 — 로고와 달리 픽셀로 못 고친다. 어긋났다고 알려만 주고 결과는 그대로 둔다
       * (고치려면 다시 생성해야 하고, 그건 사람이 정할 일이다 — 사용자 지적 2026-09-16 "얼굴 변형 체크").
       * 로고를 지운 뒤의 버퍼로 검사한다: 사람이 실제로 보게 될 그림이 검사 대상이어야 한다.
       */
      const faceCheck = await checkFaces(cropped.buffer, faceRefs);
      const colorCheck = color?.hex ? await measureProductColor(cropped.buffer, color.hex) : null;

      const stamp = isoNow.replace(/[-:T]/g, '').slice(0, 14);
      const rand = Math.random().toString(36).slice(2, 7);
      const namePart =
        [
          ...picks.flatMap((x) => [x.line, x.colorKey]),
          ...talentPicks.map((t) => t.code),
        ]
          .filter(Boolean)
          .join('_')
          .slice(0, 80) || 'gen';
      const url = await uploadBuffer(dailySubpath(isoNow), `${namePart}_${stamp}_${rand}_${n}.jpg`, cropped.buffer);
      // 태그를 지웠으면 지우기 전 원본도 남긴다 — 오검출로 다른 걸 지웠을 때 되돌릴 수 있게 (숨김 원칙과 같은 이유)
      const rawUrl = guard.erased.length
        ? await uploadBuffer(dailySubpath(isoNow), `${namePart}_${stamp}_${rand}_${n}_raw.jpg`, croppedRaw.buffer).catch(() => '')
        : '';
      const qc = {
        checked: guard.checked,
        model: guard.model,
        logoFound: guard.found,
        logoErased: guard.erased.length,
        ...(guard.erased.length ? { logoBoxes: guard.erased, rawUrl } : {}),
        topFold: guard.topFold,
        refsCleaned: originalOf.size,
        ...(guard.usage ? { usage: guard.usage } : {}),
        face: { checked: faceCheck.checked, verdicts: faceCheck.verdicts, ...(faceCheck.usage ? { usage: faceCheck.usage } : {}) },
      };

      const doc = {
        // 대표 제품 = 첫 번째. 갤러리 필터·컬러 측정이 이 값을 쓴다.
        line: product?.line ?? '',
        colorKey: picks[0]?.colorKey ?? '',
        colorName: color?.name ?? '',
        hex: color?.hex ?? '',
        url,
        title: body.title || '',
        // 한 컷에 여러 제품이면 전부 기록한다 — 대표값(line/colorKey)만으로는 뭘 넣었는지 못 되살린다
        ...(picks.length > 1
          ? { products: picks.map((x) => ({ line: x.line, colorKey: x.colorKey ?? '', placement: x.placement ?? '' })) }
          : {}),
        spec: [
          ...(picks.length > 1 ? [picks.map((x) => x.line).join('+')] : []),
          ...talentPicks.map((t) => t.code || t.freeform?.identityEn?.slice(0, 20)),
          size.label,
          ...(body.editTargets ?? []),
        ]
          .filter(Boolean)
          .join(' · '),
        recipe: {
          talentCodes: talentPicks.map((t) => t.code).filter(Boolean),
          ...(talentPicks.some((t) => t.freeform)
            ? { freeformTalents: talentPicks.filter((t) => t.freeform).map((t) => t.freeform!.identityEn) }
            : {}),
          ...(body.poseRefKey || body.shapeRefKey ? { pose: body.poseRefKey || body.shapeRefKey } : {}),
          ...(talentPicks[0]?.expression ? { expression: talentPicks[0].expression } : {}),
          ...(talentPicks[0]?.outfitCode ? { outfit: talentPicks[0].outfitCode } : {}),
        },
        source: 'imgcreate' as const,
        ...(body.origin ? { origin: String(body.origin).slice(0, 40) } : {}),
        prompt: written.prompt,
        promptMode: written.mode,
        aiModel: gen.model,
        provider: engine,
        sizeValue: size.value,
        sizeLabel: size.label,
        aspect: size.genAspect,
        editTargets: body.editTargets ?? [],
        // 스와치는 URL 이 없으므로 hex 를 함께 남긴다 — 갤러리에서 색칩으로 되살린다
        inputImages: usedRefs.map((r) => ({
          kind: r.kind, title: r.title, url: r.url ?? '', role: r.role,
          ...(r.swatchHex ? { swatchHex: r.swatchHex } : {}),
          // 태그를 지운 사본을 보냈으면 원래 사진 주소도 남긴다
          ...(r.url && originalOf.has(r.url) ? { originalUrl: originalOf.get(r.url) } : {}),
        })),
        qc,
        direction: body.direction ?? '',
        width: cropped.width,
        height: cropped.height,
        deltaE: colorCheck?.deltaE ?? null,
        measuredHex: colorCheck?.hex ?? null,
        elapsedMs: gen.elapsedMs,
        requestBytes: gen.requestBytes,
        // 실측 토큰과 그로부터 계산한 실제 원가 — 추정이 아니라 응답에서 읽은 값
        ...(gen.usage ? { tokenUsage: gen.usage, cost: costFromUsage(gen.usage) } : {}),
        // 프롬프트를 Opus 가 썼다면 그 원가도 컷에 남긴다 (이미지 생성비와 별개)
        ...(written.usage ? { promptUsage: written.usage, promptCost: promptCostFromUsage(written.usage) } : {}),
        hidden: false,
        note: '',
        createdAt: new Date(isoNow),
        updatedAt: new Date(isoNow),
      };
      const ins = await db.collection('cuts').insertOne(doc as never);
      produced++;
      results.push({
        ok: true,
        id: String(ins.insertedId),
        url,
        // 실측 토큰 기반 실제 원가 — 화면이 추정치 대신 이 값을 쓴다
        cost: costFromUsage(gen.usage),
        tokenUsage: gen.usage ?? null,
        promptUsage: written.usage ?? null,
        promptCost: promptCostFromUsage(written.usage),
        width: cropped.width,
        height: cropped.height,
        deltaE: colorCheck?.deltaE ?? null,
        measuredHex: colorCheck?.hex ?? null,
        elapsedMs: gen.elapsedMs,
        qc: {
          checked: qc.checked, logoErased: qc.logoErased, topFold: qc.topFold, refsCleaned: qc.refsCleaned,
          face: { checked: faceCheck.checked, verdicts: faceCheck.verdicts },
        },
      });
    }

    // 엔진별로 다른 카운터 — gemini 는 월 한도, higgs 는 크레딧 추정 차감
    if (produced > 0) {
      await usageCol.updateOne(
        { _id: (engine === 'higgs' ? 'higgs-image' : USAGE_KEY) as never },
        { $inc: { count: produced } },
        { upsert: true },
      );
    }

    const after = await usageCol.findOne({ _id: USAGE_KEY as never });
    return NextResponse.json({
      ok: produced > 0,
      produced,
      results,
      prompt: written.prompt,
      promptMode: written.mode,
      refs: usedRefs.map((r) => ({ kind: r.kind, title: r.title, url: r.url, swatchHex: r.swatchHex })),
      usage: { count: after?.count ?? 0, limit: after?.limit ?? limit },
      totalMs: Date.now() - startedAt,
    });
  } catch (e) {
    console.error('[generate]', e);
    return NextResponse.json({ ok: false, error: (e as Error).message || '생성 실패' }, { status: 500 });
  }
}
