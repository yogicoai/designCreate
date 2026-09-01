import { NextResponse } from 'next/server';
import { getDb, COLLECTIONS } from '@/lib/db';
import {
  writePrompt,
  type GenerationSpec,
  type RefSlot,
  type TalentSpec,
  type UploadedRefSpec,
  type EditTarget,
} from '@/lib/prompt-writer';
import { generateImage, loadReference, colorSwatch, GeminiError, type GenAspect, type InlineImage } from '@/lib/gemini';
import { generateImage as hfGenerate, higgsfieldConfigured, HiggsfieldError } from '@/lib/higgsfield';
import { uploadBuffer, dailySubpath, ftpConfigured } from '@/lib/ftp';
import { cropToSize, measureProductColor } from '@/lib/image-post';
import { planAspect } from '@/lib/aspect';

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

interface TalentPick {
  code: string;
  /** expressions._id ('soft_smile' 등) */
  expression?: string;
  outfitCode?: string;
}

interface Body {
  mode?: 'thumbnail' | 'banner';
  baseCutId?: string;
  /** 베이스 컷 사용 방식 — full(그대로 재현) | pose(포즈만 빌림) */
  baseCutUsage?: 'full' | 'pose';
  uploadedRefs?: { url: string; title: string; role?: 'style' | 'base' | 'background' }[];
  preservation?: string;
  /** 업로드 base 에서 무엇을 바꿀지 */
  editTargets?: EditTarget[];
  shapeRefKey?: string;
  poseRefKey?: string;
  usageShotId?: string;
  /** 등장 인물 — 사진 왼쪽부터 순서대로 */
  talents?: TalentPick[];
  line?: string;
  colorKey?: string;
  sizeValue?: string;
  /** sizeValue='custom' 일 때 직접 지정한 규격 */
  customSize?: { width: number; height: number };
  variationIds?: string[];
  direction?: string;
  samples?: number;
  tier?: 'pro' | 'draft';
  /** 생성 엔진 — gemini(나노바나나) | higgs(힉스필드 Element) */
  engine?: 'gemini' | 'higgs';
  dryRun?: boolean;
  title?: string;
}

interface SizeDocLike {
  width: number;
  height: number;
  genAspect: string;
  retention: number;
  cropAxis: 'vertical' | 'horizontal' | 'none';
  label: string;
  value: string;
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
    const [baseCut, product, talentDocs, shapeRef, poseRef, usageShot, preservation, variations, rules, exprDocs] =
      await Promise.all([
        body.baseCutId ? db.collection('cuts').findOne({ url: body.baseCutId }) : null,
        body.line ? db.collection('products').findOne({ _id: body.line as never }) : null,
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
      });
    }

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
    const hasProduct = !!product;
    const activeRules = rules.filter((r) => {
      if (r.conditional === 'no-scene' && hasScene) return false;
      if (r.requires === 'talent' && !hasTalent) return false;
      if (r.requires === 'product' && !hasProduct) return false;
      return true;
    });

    const color = product?.colors?.find((c: { key: string }) => c.key === body.colorKey);

    /*
     * 공식 제품 뷰 선택 — youtube/productPrompt.js 의 규칙:
     * "카메라 각도에 맞는 뷰를 첨부하라". 카메라 변형 미지정이면 ¾뷰 우선(썸네일 관행).
     * 자기 색 뷰가 없으면 같은 라인의 뷰 보유 색으로 폴백 — 형태만 참고, 색은 스와치가 잡는다.
     */
    const cameraPick = (body.variationIds ?? []).find((v) => v.startsWith('camera:'))?.split(':')[1];
    const ANGLE_PREF: Record<string, string[]> = {
      front: ['front', 'side'],
      '45deg': ['a045', 'side', 'front'],
      side: ['side', 'front'],
      top: ['front', 'side'],
      low: ['front', 'side'],
    };
    const wantedAngles = ANGLE_PREF[cameraPick ?? ''] ?? ['a045', 'side', 'front'];

    let productViews: { angle: string; url: string; colorMatched: boolean }[] = [];
    if (product && body.colorKey) {
      let viewSrc: Record<string, string> | undefined = color?.views;
      let colorMatched = true;
      if (!viewSrc || !Object.keys(viewSrc).length) {
        const fallback = product.colors?.find(
          (c: { views?: Record<string, string> }) => c.views && Object.keys(c.views).length,
        );
        viewSrc = fallback?.views;
        colorMatched = false;
      }
      if (viewSrc) {
        for (const a of wantedAngles) {
          if (productViews.length >= 2) break; // 참조 슬롯 예산 — 뷰는 2장까지
          if (viewSrc[a]) productViews.push({ angle: a, url: viewSrc[a], colorMatched });
        }
      }
    }

    // product_items.notes 의 "연출: <영문>" — 실제 판매 데이터에 박힌 연출 지침
    let staging = '';
    if (product && body.colorKey) {
      const item = await db.collection('product_items').findOne({ line: product.line, colorKey: body.colorKey });
      staging = String(item?.notes || '').match(/연출:\s*([^·]+)/)?.[1]?.trim() ?? '';
    }

    // ── 3) 프롬프트 작성 ──────────────────────────────────────────
    const spec: GenerationSpec = {
      mode: body.mode || 'thumbnail',
      ...(baseCut
        ? { baseCut: { url: baseCut.url, spec: baseCut.spec, line: baseCut.line, colorName: baseCut.colorName, usage: body.baseCutUsage ?? 'full' } }
        : {}),
      uploadedRefs,
      ...(body.editTargets?.length ? { editTargets: body.editTargets } : {}),
      ...(preservation
        ? { preservation: { value: preservation.value, label: preservation.label, instruction: preservation.instruction } }
        : {}),
      ...(shapeRef ? { shapeRef: { url: shapeRef.offUrl, name: shapeRef.name } } : {}),
      ...(poseRef ? { poseRef: { url: poseRef.onUrl, name: poseRef.name } } : {}),
      ...(usageShot ? { usageShot: { url: usageShot.url, kindEn: usageShot.kindEn, kindKr: usageShot.kindKr } } : {}),
      ...(talents.length ? { talents } : {}),
      ...(product
        ? {
            product: {
              line: product.line,
              shape: product.geometry.shape,
              negative: product.geometry.negative,
              modes: product.geometry.modes,
              dims: product.dims,
              scalePrompt: product.scalePrompt,
              ...(color ? { color: { name: color.name, nameEn: color.nameEn || color.name, hex: color.hex } } : {}),
              ...(staging ? { staging } : {}),
              ...(productViews.length ? { views: productViews } : {}),
            },
          }
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
    };

    const written = await writePrompt(spec);

    if (body.dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        prompt: written.prompt,
        promptMode: written.mode,
        refs: written.refs.map((r) => ({ kind: r.kind, title: r.title, url: r.url, swatchHex: r.swatchHex })),
        aspect: size.genAspect,
        target: { width: size.width, height: size.height },
        elementId: color?.elementId ?? null,
        usage: written.usage ?? null,
      });
    }

    if (!ftpConfigured()) {
      return NextResponse.json({ ok: false, error: 'FTP 설정이 없습니다 (.env.local).' }, { status: 500 });
    }

    const engine = body.engine === 'higgs' ? 'higgs' : 'gemini';
    if (engine === 'higgs' && !higgsfieldConfigured()) {
      return NextResponse.json({ ok: false, error: 'Higgsfield 설정이 없습니다 (.env.local).' }, { status: 500 });
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
    for (const r of written.refs) {
      // 모델 시트는 다패널이라 덜 줄인다 — 1024 로 줄이면 얼굴이 판독 불가 크기가 된다
      const img = r.swatchHex
        ? await colorSwatch(r.swatchHex)
        : r.url
          ? await loadReference(r.url, r.kind === 'talent' ? 1600 : 1024)
          : null;
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
      const redone = await writePrompt(spec);
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
        } else {
          gen = await generateImage({
            prompt: written.prompt,
            references: inline,
            aspect: size.genAspect as GenAspect,
            tier: body.tier ?? 'pro',
          });
        }
      } catch (e) {
        const err = e as GeminiError & HiggsfieldError;
        results.push({ ok: false, error: err.message, blockReason: err.blockReason ?? null, status: err.status ?? null });
        if (err.status === 422 || err.quotaExhausted) break; // 같은 요청은 같은 이유로 또 막힌다
        continue;
      }

      const cropped = await cropToSize(gen.buffer, size.width, size.height);
      const colorCheck = color?.hex ? await measureProductColor(cropped.buffer, color.hex) : null;

      const stamp = isoNow.replace(/[-:T]/g, '').slice(0, 14);
      const rand = Math.random().toString(36).slice(2, 7);
      const namePart =
        [body.line, body.colorKey, ...talentPicks.map((t) => t.code)].filter(Boolean).join('_') || 'gen';
      const url = await uploadBuffer(dailySubpath(isoNow), `${namePart}_${stamp}_${rand}_${n}.jpg`, cropped.buffer);

      const doc = {
        line: product?.line ?? '',
        colorKey: body.colorKey ?? '',
        colorName: color?.name ?? '',
        hex: color?.hex ?? '',
        url,
        title: body.title || '',
        spec: [...talentPicks.map((t) => t.code), size.label, ...(body.editTargets ?? [])].filter(Boolean).join(' · '),
        recipe: {
          talentCodes: talentPicks.map((t) => t.code),
          ...(body.poseRefKey || body.shapeRefKey ? { pose: body.poseRefKey || body.shapeRefKey } : {}),
          ...(talentPicks[0]?.expression ? { expression: talentPicks[0].expression } : {}),
          ...(talentPicks[0]?.outfitCode ? { outfit: talentPicks[0].outfitCode } : {}),
        },
        source: 'imgcreate' as const,
        prompt: written.prompt,
        promptMode: written.mode,
        aiModel: gen.model,
        provider: engine,
        sizeValue: size.value,
        sizeLabel: size.label,
        aspect: size.genAspect,
        editTargets: body.editTargets ?? [],
        inputImages: usedRefs.map((r) => ({ kind: r.kind, title: r.title, url: r.url ?? '', role: r.role })),
        direction: body.direction ?? '',
        width: cropped.width,
        height: cropped.height,
        deltaE: colorCheck?.deltaE ?? null,
        measuredHex: colorCheck?.hex ?? null,
        elapsedMs: gen.elapsedMs,
        requestBytes: gen.requestBytes,
        // 실측 토큰과 그로부터 계산한 실제 원가 — 추정이 아니라 응답에서 읽은 값
        ...(gen.usage ? { tokenUsage: gen.usage, cost: costFromUsage(gen.usage) } : {}),
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
        width: cropped.width,
        height: cropped.height,
        deltaE: colorCheck?.deltaE ?? null,
        measuredHex: colorCheck?.hex ?? null,
        elapsedMs: gen.elapsedMs,
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
