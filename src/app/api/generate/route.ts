import { NextResponse } from 'next/server';
import { getDb, COLLECTIONS } from '@/lib/db';
import { writePrompt, type GenerationSpec, type RefSlot } from '@/lib/prompt-writer';
import { generateImage, loadReference, colorSwatch, GeminiError, type GenAspect, type InlineImage } from '@/lib/gemini';
import { uploadBuffer, dailySubpath, ftpConfigured } from '@/lib/ftp';
import { cropToSize, measureProductColor } from '@/lib/image-post';

/**
 * POST /api/generate — 자산 조합 → 프롬프트 → 나노바나나 → 크롭 → FTP → DB.
 *
 * dryRun:true 면 프롬프트와 참조 목록만 돌려주고 생성은 하지 않는다 (무과금 확인용).
 *
 * ⚠️ Vercel 함수 실행시간: Pro 2K 생성이 25~30초, 2샘플이면 60초를 넘길 수 있다.
 *    maxDuration 을 최대로 잡되, 그래도 모자라면 샘플을 1장으로 줄여야 한다.
 */

export const runtime = 'nodejs';
export const maxDuration = 300;

const USAGE_KEY = 'gemini-image';

interface Body {
  mode?: 'thumbnail' | 'banner';
  baseCutId?: string;
  uploadedRefs?: { url: string; title: string }[];
  preservation?: string;
  shapeRefKey?: string;
  poseRefKey?: string;
  usageShotId?: string;
  talentCode?: string;
  expression?: string;
  outfitCode?: string;
  line?: string;
  colorKey?: string;
  sizeValue?: string;
  /** variation_options 의 _id 목록 ('camera:front' 등) */
  variationIds?: string[];
  direction?: string;
  samples?: number;
  tier?: 'pro' | 'draft';
  dryRun?: boolean;
  title?: string;
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json()) as Body;
    const db = await getDb();

    // ── 1) 자산 로딩 ──────────────────────────────────────────────
    const sizeValue = body.sizeValue || '1000x1000';
    const size = await db.collection(COLLECTIONS.sizePresets ?? 'size_presets').findOne({ _id: sizeValue as never });
    if (!size) {
      return NextResponse.json({ ok: false, error: `사이즈 프리셋을 찾을 수 없습니다: ${sizeValue}` }, { status: 400 });
    }

    const [baseCut, product, talent, shapeRef, poseRef, usageShot, preservation, variations, rules] = await Promise.all([
      body.baseCutId ? db.collection('cuts').findOne({ url: body.baseCutId }) : null,
      body.line ? db.collection('products').findOne({ _id: body.line as never }) : null,
      body.talentCode ? db.collection('talents').findOne({ _id: body.talentCode as never }) : null,
      body.shapeRefKey ? db.collection('pose_refs').findOne({ _id: body.shapeRefKey as never }) : null,
      body.poseRefKey ? db.collection('pose_refs').findOne({ _id: body.poseRefKey as never }) : null,
      body.usageShotId ? db.collection('usage_shots').findOne({ _id: body.usageShotId as never }) : null,
      body.preservation ? db.collection('preservation_modes').findOne({ _id: body.preservation as never }) : null,
      body.variationIds?.length
        ? db.collection('variation_options').find({ _id: { $in: body.variationIds as never[] } }).toArray()
        : [],
      db.collection('house_rules').find({ enabled: true, appliesTo: 'image' }).sort({ order: 1 }).toArray(),
    ]);

    // 표정 — 한글 라벨을 영문 서술로 바꾼다. 별칭('곁눈질미소' 등)도 흡수.
    let expression: { kr: string; en: string } | undefined;
    if (body.expression) {
      const alias = await db.collection('settings').findOne({ _id: 'expression_alias' as never });
      const id = alias?.map?.[body.expression] ?? body.expression;
      const doc = await db.collection('expressions').findOne({ _id: id as never });
      expression = doc ? { kr: doc.kr, en: doc.en } : { kr: body.expression, en: 'a natural, gentle smile' };
    }

    /*
     * 장면 지시가 있으면 'no-scene' 규칙(스튜디오 배경 #f2f2f4)은 뺀다.
     * 안 그러면 "배경을 거실로" 라는 지시와 "배경은 스튜디오 그레이" 규칙이 정면으로 부딪혀,
     * 모델이 둘 중 하나를 임의로 고른다.
     */
    const hasScene =
      !!body.direction?.trim() || (body.variationIds ?? []).some((v) => v.startsWith('scene:') && !v.endsWith(':auto'));
    const activeRules = rules.filter((r) => !(r.conditional === 'no-scene' && hasScene));

    const color = product?.colors?.find((c: { key: string }) => c.key === body.colorKey);
    const outfit = talent?.outfits?.find((o: { code: string }) => o.code === body.outfitCode);

    // ── 2) 프롬프트 작성 ──────────────────────────────────────────
    const spec: GenerationSpec = {
      mode: body.mode || 'thumbnail',
      ...(baseCut ? { baseCut: { url: baseCut.url, spec: baseCut.spec, line: baseCut.line, colorName: baseCut.colorName } } : {}),
      uploadedRefs: body.uploadedRefs ?? [],
      ...(preservation
        ? { preservation: { value: preservation.value, label: preservation.label, instruction: preservation.instruction } }
        : {}),
      ...(shapeRef ? { shapeRef: { url: shapeRef.offUrl, name: shapeRef.name } } : {}),
      ...(poseRef ? { poseRef: { url: poseRef.onUrl, name: poseRef.name } } : {}),
      ...(usageShot ? { usageShot: { url: usageShot.url, kindEn: usageShot.kindEn, kindKr: usageShot.kindKr } } : {}),
      ...(talent
        ? {
            talent: {
              code: talent.code,
              category: talent.category,
              slot: talent.slot,
              identityEn: talent.identityEn || talent.thumbDesc || talent.identity,
              sizeEn: talent.sizeEn || talent.size,
              exprSheet: talent.exprSheet,
              ...(expression ? { expression } : {}),
              ...(outfit ? { outfit: { code: outfit.code, desc: outfit.desc, descEn: outfit.descEn || '' } } : {}),
            },
          }
        : {}),
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
        usage: written.usage ?? null,
      });
    }

    if (!ftpConfigured()) {
      return NextResponse.json({ ok: false, error: 'FTP 설정이 없습니다 (.env.local).' }, { status: 500 });
    }

    // ── 3) 사용량 한도 ────────────────────────────────────────────
    const samples = Math.max(1, Math.min(2, body.samples ?? 1));
    const limit = Number(process.env.GEMINI_USAGE_LIMIT) || 300;
    const usageCol = db.collection(COLLECTIONS.apiUsage ?? 'api_usage');
    const usage = await usageCol.findOneAndUpdate(
      { _id: USAGE_KEY as never },
      { $setOnInsert: { count: 0, limit } },
      { upsert: true, returnDocument: 'after' },
    );
    const cur = usage?.count ?? 0;
    const cap = usage?.limit ?? limit;
    if (cur + samples > cap) {
      return NextResponse.json(
        {
          ok: false,
          error: `생성 한도 초과 — ${cur}/${cap} 장 사용됨. 관리자가 한도를 늘려야 합니다.`,
          usage: { count: cur, limit: cap },
        },
        { status: 429 },
      );
    }

    // ── 4) 참조 이미지 적재 (순서가 프롬프트와 일치해야 한다) ─────
    const inline: InlineImage[] = [];
    const usedRefs: RefSlot[] = [];
    for (const r of written.refs) {
      const img = r.swatchHex ? await colorSwatch(r.swatchHex) : r.url ? await loadReference(r.url) : null;
      if (!img) {
        console.warn('[generate] 참조 로딩 실패 — 건너뜀:', r.title, r.url);
        continue;
      }
      inline.push(img);
      usedRefs.push(r);
    }
    if (usedRefs.length !== written.refs.length) {
      // 참조가 빠지면 프롬프트의 FIRST/SECOND 번호가 어긋난다. 프롬프트를 다시 쓴다.
      const redone = await writePrompt({ ...spec, uploadedRefs: spec.uploadedRefs });
      console.warn(`[generate] 참조 ${written.refs.length - usedRefs.length}장 누락 — 프롬프트 재작성`);
      written.prompt = redone.prompt;
    }

    // ── 5) 생성 ───────────────────────────────────────────────────
    const isoNow = new Date().toISOString();
    const results: Record<string, unknown>[] = [];
    let produced = 0;

    for (let n = 1; n <= samples; n++) {
      let gen;
      try {
        gen = await generateImage({
          prompt: written.prompt,
          references: inline,
          aspect: size.genAspect as GenAspect,
          tier: body.tier ?? 'pro',
        });
      } catch (e) {
        const err = e as GeminiError;
        results.push({ ok: false, error: err.message, blockReason: err.blockReason ?? null, status: err.status ?? null });
        // 안전필터·할당량 소진은 다음 샘플도 똑같이 실패한다 — 반복하지 않는다
        if (err.status === 422 || err.quotaExhausted) break;
        continue;
      }

      // 목표 픽셀로 크롭
      const cropped = await cropToSize(gen.buffer, size.width, size.height);

      // 컬러 정확도 실측 (공식 hex 대비)
      const colorCheck = color?.hex ? await measureProductColor(cropped.buffer, color.hex) : null;

      // FTP — /web/design/<YYYY-MM-DD>/
      const stamp = isoNow.replace(/[-:T]/g, '').slice(0, 14);
      const rand = Math.random().toString(36).slice(2, 7);
      const namePart = [body.line, body.colorKey, body.talentCode].filter(Boolean).join('_') || 'gen';
      const url = await uploadBuffer(dailySubpath(isoNow), `${namePart}_${stamp}_${rand}_${n}.jpg`, cropped.buffer);

      // DB 등록 — 게시판이 이 문서를 읽는다
      const doc = {
        line: product?.line ?? '',
        colorKey: body.colorKey ?? '',
        colorName: color?.name ?? '',
        hex: color?.hex ?? '',
        url,
        title: body.title || '',
        spec: [body.talentCode, body.expression, outfit?.code, size.label].filter(Boolean).join(' · '),
        recipe: {
          talentCodes: body.talentCode ? [body.talentCode] : [],
          ...(body.poseRefKey || body.shapeRefKey ? { pose: body.poseRefKey || body.shapeRefKey } : {}),
          ...(body.expression ? { expression: body.expression } : {}),
          ...(outfit ? { outfit: outfit.code } : {}),
        },
        source: 'imgcreate' as const,
        prompt: written.prompt,
        promptMode: written.mode,
        aiModel: gen.model,
        provider: 'gemini',
        sizeValue,
        sizeLabel: size.label,
        aspect: size.genAspect,
        inputImages: usedRefs.map((r) => ({ kind: r.kind, title: r.title, url: r.url ?? '', role: r.role })),
        direction: body.direction ?? '',
        width: cropped.width,
        height: cropped.height,
        deltaE: colorCheck?.deltaE ?? null,
        measuredHex: colorCheck?.hex ?? null,
        elapsedMs: gen.elapsedMs,
        requestBytes: gen.requestBytes,
        hidden: false,
        note: '',
        createdAt: new Date(isoNow),
        updatedAt: new Date(isoNow),
      };
      const ins = await db.collection('cuts').insertOne(doc as never);
      produced++;
      results.push({ ok: true, id: String(ins.insertedId), url, width: cropped.width, height: cropped.height, deltaE: colorCheck?.deltaE ?? null, measuredHex: colorCheck?.hex ?? null, elapsedMs: gen.elapsedMs });
    }

    if (produced > 0) await usageCol.updateOne({ _id: USAGE_KEY as never }, { $inc: { count: produced } });

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
