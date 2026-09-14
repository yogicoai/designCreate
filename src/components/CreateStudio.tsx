'use client';

import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import type { ProductDoc, TalentDoc, PoseRefDoc, ExpressionDoc } from '@/lib/types';
import type { SizePresetDoc, PreservationDoc, ReferenceDoc } from '@/lib/queries';
import { shrinkForUpload, formatBytes } from '@/lib/client-image';
import Zoomable from '@/components/Zoomable';
import { thumbUrl } from '@/lib/thumb';
import { defaultPanelKey, supportPanels, type AiProductSheet } from '@/lib/ai-products';

type WithId<T> = T & { id: string };

interface BaseCut {
  url: string; line: string; colorKey: string; colorName: string; spec: string; talentCodes: string[];
}

interface Props {
  products: WithId<ProductDoc>[];
  talents: WithId<TalentDoc>[];
  poses: WithId<PoseRefDoc>[];
  sizes: WithId<SizePresetDoc>[];
  preservations: WithId<PreservationDoc>[];
  expressions: WithId<ExpressionDoc>[];
  baseCuts: BaseCut[];
  /** 자산관리 > 레퍼런스 보관함 (레퍼런스 화면에서 등록한 것만 — 생성 중 업로드분은 안 들어간다) */
  references: ReferenceDoc[];
  /** 자산관리 > AI 생성 제품 — 승인된 형태 시트만. 제품을 고르면 이 칸들 중에서 배치 각도를 고른다 */
  aiSheets: AiProductSheet[];
  /** 프롬프트 작성 모드 — local(템플릿·무과금) / opus(라이브, 확인에도 소액 과금) */
  promptMode: 'local' | 'opus';
  /** 로컬 개발 여부. 대화로 넘기는 버튼은 여기서만 보인다 */
  localMode: boolean;
  /** OPENAI_API_KEY 가 설정돼 있으면 GPT 엔진 선택지가 열린다 */
  gptEnabled?: boolean;
}

/*
 * 올린 사진의 쓰임.
 *   「모델과 함께」 — 기존 레퍼런스 방식 그대로: 분위기 참고 / 이 사진을 편집(base) / 배경으로 사용
 *   「제품만 노출」 — 배경 이미지: 배경으로 사용 / 분위기 참고 (편집 없음)
 * (사용자 확정 2026-09-14)
 */
type RefRole = 'style' | 'base' | 'background';
interface UploadedRef { url: string; title: string; role: RefRole }

/** 작업 탭 — 제품만 노출 / 모델과 함께. 이게 아래 섹션 구성과 참조 구성을 정한다 */
type Flow = 'product' | 'model';

/** 고른 AI 생성 제품 칸 — 승인된 시트의 칸 하나가 "배치 각도" */
interface SheetPick { sheetId: string; key: string }

/** 선택된 모델 1명 — 순서가 곧 "사진 왼쪽부터" 배정 순서다 */
interface TalentPick { code: string; expression: string; outfitCode: string; placement?: string }
/** 추가 제품 — 한 컷에 2~3종을 넣을 때. 첫 제품은 위의 line/colorKey 가 맡는다. */
interface ExtraProduct { line: string; colorKey: string; placement: string; sheet: SheetPick | null }

/** 위치 — 프롬프트의 "on the left" 로 그대로 들어간다 */
const PLACEMENTS = [
  { value: '', label: '자동' },
  { value: 'left', label: '왼쪽' },
  { value: 'centre', label: '가운데' },
  { value: 'right', label: '오른쪽' },
  { value: 'foreground', label: '앞쪽' },
  { value: 'background', label: '뒤쪽' },
];

type EditTarget = 'face' | 'person' | 'add-person' | 'outfit' | 'product-color' | 'background' | 'text-removal';

const EDIT_TARGETS: { value: EditTarget; label: string; desc: string }[] = [
  { value: 'face', label: '얼굴만 교체', desc: '몸·포즈·의상·배경 유지, 얼굴+헤어만 우리 모델로' },
  { value: 'person', label: '인물 전체 교체', desc: '포즈는 유지하고 사람을 통째로 우리 모델로' },
  { value: 'add-person', label: '인물 추가 (앉히기)', desc: '사람 없는 사진에 우리 모델을 기존 빈백·좌석에 앉혀 합성. 공간·가구는 그대로' },
  { value: 'product-color', label: '제품 리컬러', desc: '제품 색만 공식 컬러로' },
  { value: 'outfit', label: '의상만 교체', desc: '얼굴·포즈 유지, 옷만' },
  { value: 'background', label: '배경만 교체', desc: '인물·제품 유지, 공간만' },
  { value: 'text-removal', label: '텍스트 제거', desc: '박힌 글자·배지·로고 지우기' },
];

const ROLE_META: { value: RefRole; label: string; desc: string }[] = [
  { value: 'style', label: '분위기 참고', desc: '조명·색감·무드만 따라가고 장면은 새로 — 그 공간 자체를 쓰려면 「배경으로 사용」을 고르세요' },
  { value: 'base', label: '이 사진을 편집', desc: '사진은 그대로 두고 지정한 것만 바꿈 (합성·교체)' },
  { value: 'background', label: '배경으로 사용', desc: '공간만 가져오고 인물·제품은 우리 자산으로' },
];

/** 「제품만 노출」 의 배경 이미지 역할 — 사진 편집(base)은 없다 */
const BG_ROLE_META: { value: RefRole; label: string; desc: string }[] = [
  { value: 'background', label: '배경으로 사용', desc: '이 공간에 제품을 새로 배치합니다 — 조명·색감도 이 공간에 맞춥니다' },
  { value: 'style', label: '분위기 참고', desc: '조명·색감·무드만 따라가고 장면은 새로 그립니다' },
];

const FLOWS: { value: Flow; title: string; desc: string }[] = [
  { value: 'model', title: '모델과 함께', desc: '제품에 전속·AI 모델을 앉히거나 함께 세웁니다. 포즈·표정·의상을 고릅니다' },
  { value: 'product', title: '제품만 노출', desc: '승인된 AI 생성 제품을 골라 배경·배치·색상을 입힙니다. 사람은 나오지 않습니다' },
];

/**
 * 장당 예상 단가 — 실측 usageMetadata 기반 (₩1,400/$).
 *
 * 실제 원가는 사고(thinking) 토큰에 따라 매번 달라진다: 같은 브리프로도 199~699 토큰이
 * 나와 ₩230~₩314 범위로 흔들린다. 그래서 여기 값은 어디까지나 **예상 범위의 중앙**이고,
 * 생성 후에는 응답의 실측 원가를 그대로 표시한다.
 *   gemini-3-pro-image 2K — 실측 ₩230~₩314
 */
// (금액 표시는 화면에서 뺐다 — 사용자 지시: 장수만 보여준다. 단가 실측치는 위 주석에 남긴다)
const ORD = ['①', '②', '③', '④'];
const MY_SIZE_GROUP = '내 규격';

/*
 * 레퍼런스 보관함 분류 — 내용 기준으로 묶는다 (표시 전용, DB 의 category 값은 안 바꾼다).
 *   촬영   = 기존 thumbnail (실제 촬영·연출 컷)
 *   배너   = 기존 web-banner + mobile (배너 규격)
 *   SNS    = 기존 sns + sns-story
 *   미분류 = 그 외/빈 값
 * 보관함 팝업에서 이 순서로 묶어 보여준다.
 */
const REF_CATS: { value: string; label: string }[] = [
  { value: 'shoot', label: '촬영' },
  { value: 'banner', label: '배너' },
  { value: 'sns', label: 'SNS' },
  { value: 'interior', label: '인테리어' },
  { value: 'instagram', label: '인스타그램' },
  { value: 'model', label: '모델컷' },
  { value: '__none', label: '미분류' },
];
function refCatOf(cat: string | null | undefined): string {
  if (cat === 'shoot' || cat === 'thumbnail') return 'shoot';
  if (cat === 'banner' || cat === 'web-banner' || cat === 'mobile') return 'banner';
  if (cat === 'sns' || cat === 'sns-story') return 'sns';
  if (cat === 'interior') return 'interior';
  if (cat === 'instagram') return 'instagram';
  if (cat === 'model') return 'model';
  return '__none';
}

interface DryRunResult {
  prompt: string;
  promptMode: string;
  usage?: { input_tokens: number; output_tokens: number } | null;
  promptCost?: { usd: number; krw: number } | null;
  refs: { kind: string; title: string; url?: string; swatchHex?: string }[];
  /** 선택한 제품 컬러의 힉스필드 Element 토큰 (있으면 힉스필드가 유리) */
  elementId?: string | null;
  aspect?: string;
  target?: { width: number; height: number };
}

interface GenResult {
  ok: boolean; id?: string; url?: string; width?: number; height?: number;
  /** 실측 토큰 기반 실제 원가 */
  cost?: { usd: number; krw: number } | null;
  tokenUsage?: { promptTokens: number; imageTokens: number; thoughtTokens: number; totalTokens: number } | null;
  deltaE?: number | null; measuredHex?: string | null; elapsedMs?: number;
  error?: string; blockReason?: string | null;
}

function Section({ n, title, hint, children, right, id }: {
  n: string; title: string; hint?: string; children: React.ReactNode; right?: React.ReactNode; id?: string;
}) {
  return (
    <section className="card p-4" id={id}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="w-[19px] h-[19px] rounded-md text-[10.5px] font-bold flex items-center justify-center shrink-0"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>{n}</span>
            <h2 className="text-[13.5px] font-bold">{title}</h2>
          </div>
          {hint && <p className="text-[11px] mt-1 ml-[27px]" style={{ color: 'var(--text-mute)' }}>{hint}</p>}
        </div>
        {right}
      </div>
      <div className="ml-[27px]">{children}</div>
    </section>
  );
}

export default function CreateStudio(p: Props) {
  /**
   * 작업 방식 — 이게 아래 섹션 구성을 결정한다.
   *   ref    = 가진 사진으로 제작 (사진이 출발점)
   *   direct = 자산으로 직접 제작 (제품·모델·포즈 조합이 출발점)
   */
  /*
   * 작업 탭 (사용자 확정 2026-09-14) — 제품만 노출 / 모델과 함께.
   * 예전의 "레퍼런스로 제작 / 직접 제작" 은 두 컷의 개념이 섞여 섹션이 전부 보였다.
   * 이제 탭이 섹션과 참조 구성을 정한다: 제품만 노출엔 모델·포즈가 없다.
   */
  const [flow, setFlow] = useState<Flow>('model');
  // 앱의 생성 엔진은 나노바나나 하나다. 힉스필드는 화면에서 뺐다 (백엔드 경로는 살아 있다).
  /*
   * 생성 엔진 — 제미나이(나노바나나) / GPT(gpt-image-1).
   * 「제품만 노출」 탭은 GPT 가 기본이다 (사용자 지시). 「모델과 함께」 는 제미나이 —
   * GPT 는 전속 모델 얼굴을 유지하지 못한다(실측).
   * GPT 는 최대 1536px 라 POP·인쇄용(4K) 화질이 없다 — 고르면 4K 선택지를 숨기고 2K 로 되돌린다.
   * (힉스필드는 앱 키에 크레딧이 없어 여전히 화면에서 뺀다)
   */
  // 첫 탭이 「모델과 함께」 라 제미나이로 시작한다 — 「제품만 노출」 로 바꾸면 switchFlow 가 GPT 로 돌린다
  const [engine, setEngine] = useState<'gemini' | 'gpt'>('gemini');
  const [balance, setBalance] = useState<{ gemini?: { count: number; limit: number; remaining: number } } | null>(null);
  const [mode, setMode] = useState<'thumbnail' | 'banner'>('thumbnail');
  /** 프리셋 목록 — 커스텀 규격을 저장하면 여기 즉시 추가된다 */
  const [sizes, setSizes] = useState<WithId<SizePresetDoc>[]>(p.sizes);
  const [sizeValue, setSizeValue] = useState(p.sizes.find((s) => s.value === '1000x1000')?.value ?? p.sizes[0]?.value ?? '');
  const [customW, setCustomW] = useState('1200');
  const [customH, setCustomH] = useState('800');
  const [sizeName, setSizeName] = useState('');
  const [savingSize, setSavingSize] = useState(false);
  const [line, setLine] = useState('');
  const [colorKey, setColorKey] = useState('');
  /** 첫 제품의 AI 생성 제품 칸 (배치 각도). null = 승인 시트 없음 또는 공식 사진으로 */
  const [sheetPick, setSheetPick] = useState<SheetPick | null>(null);
  /** 선택 순서 유지 — ①②③④ = 사진 왼쪽부터 */
  const [picks, setPicks] = useState<TalentPick[]>([]);
  const [mainPlacement, setMainPlacement] = useState('');
  const [extraProducts, setExtraProducts] = useState<ExtraProduct[]>([]);
  // 포즈 소스 — 우리 컷에서 포즈만(posecut) / 실사 포즈 레퍼(pose). 「모델과 함께」 에서만 쓴다
  const [baseTab, setBaseTab] = useState<'none' | 'posecut' | 'pose'>('none');
  const [baseCutUrl, setBaseCutUrl] = useState('');
  const [poseRefKey, setPoseRefKey] = useState('');
  const [shapeRefKey, setShapeRefKey] = useState('');
  const [uploads, setUploads] = useState<UploadedRef[]>([]);
  const [library, setLibrary] = useState<ReferenceDoc[]>(p.references);
  // 보관함 팝업 — 전체 레퍼런스를 분류별로 보고 고른다
  const [libOpen, setLibOpen] = useState(false);
  const [libCat, setLibCat] = useState<string>(''); // '' = 전체
  const [libSearch, setLibSearch] = useState('');
  // 하위 분류(sub) — '22 맥스' 같은 촬영 2022 폴더 단위. 분류 탭을 고르면 한 줄 더 나뉜다
  const [libSub, setLibSub] = useState('');
  // 분류별 표시 개수 — 인스타 백필로 2천 장이 넘어서, 한 번에 다 그리면 팝업이 무거워진다
  // 게시판식 페이지 — 한 번에 다 그리면 이미지 수천 장이 동시에 로딩돼 빈 카드만 보인다
  const [libPage, setLibPage] = useState(1);
  const LIB_PAGE = 20;
  const [preservation, setPreservation] = useState('similar');
  const [editTargets, setEditTargets] = useState<EditTarget[]>([]);
  // 레퍼런스에 담긴 제품 — 인물 대비 스케일용 (사진 속 빈백이 무엇인지)
  const [refProduct, setRefProduct] = useState('');
  const [direction, setDirection] = useState('');
  const [samples, setSamples] = useState(1);
  /*
   * 출력 화질 — 기본 2K(2048px). 4K(4096px)는 POP·인쇄용.
   * 실측: 4096px = A3 인쇄 248dpi / A2 실사출력 175dpi. 웹·SNS 용도는 2K 로 충분하다.
   */
  const [imageSize, setImageSize] = useState<'2K' | '4K'>('2K');
  // 프롬프트 작성 방식 — 서버(PROMPT_MODE)가 정한다. 화면에서 바꿀 수 없다.
  const writer: 'local' | 'opus' = p.promptMode === 'opus' ? 'opus' : 'local';

  const [uploadNote, setUploadNote] = useState('');
  const [copied, setCopied] = useState<'prompt' | 'urls' | null>(null);
  const [zipping, setZipping] = useState(false);
  const [handoff, setHandoff] = useState<'busy' | 'done' | null>(null);
  /*
   * 힉스필드 대기열 — 로컬 전용.
   * 이 핸드오프로 몇 장(hoCount), 어느 해상도(hoRes)로 뽑을지, 대기열에서 알아볼
   * 이름(hoTitle)을 함께 남긴다. 장수·해상도로 크레딧을 미리 추정해 보여준다.
   */
  const [hoCount, setHoCount] = useState(1);
  const [hoRes, setHoRes] = useState<'2k' | '4k'>('2k');
  const [hoTitle, setHoTitle] = useState('');
  type QueueItem = {
    id: string; title: string; createdAt?: string; aspect?: string | null;
    sizeLabel?: string | null; count: number; resolution: '2k' | '4k'; credits: number;
    refCount: number; talentCount: number; productCount: number; direction: string;
  };
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueCredits, setQueueCredits] = useState(0);
  /*
   * 생성 경과 시간.
   * 생성이 25~40초 걸리는데 화면에 아무 변화가 없으면 멈춘 건지 도는 건지 알 수 없다.
   * 초를 세어 보여주면 "돌고 있다"가 눈으로 확인된다.
   */
  const [elapsed, setElapsed] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [dry, setDry] = useState<DryRunResult | null>(null);
  /*
   * 프롬프트 직접 편집.
   * 앱은 이 대화에 접근할 수 없다 — 프롬프트가 필요하면 API 를 호출하고 돈을 낸다.
   * 그래서 사람이 쓴 프롬프트를 붙여넣는 길을 열어둔다.
   * 로컬에서 대화로 뽑은 프롬프트를 그대로 쓰면 무과금으로 최고 품질이 나온다.
   */
  const [promptText, setPromptText] = useState('');
  const [promptEdited, setPromptEdited] = useState(false);
  const [busy, setBusy] = useState<'dry' | 'gen' | 'handoff' | null>(null);
  const [results, setResults] = useState<GenResult[]>([]);
  // 생성 완료 팝업 — 성공하면 결과를 크게 띄운다 (사용자 요청: 완료 시 팝업)
  const [donePopup, setDonePopup] = useState<GenResult[] | null>(null);
  const [err, setErr] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!busy) { setElapsed(0); return; }
    setElapsed(0);
    const t = window.setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [busy]);

  const loadBalance = useCallback(async () => {
    try {
      const r = await fetch('/api/balance');
      const j = await r.json();
      if (j.ok) setBalance({ gemini: j.gemini });
    } catch { /* 잔액 조회 실패는 생성을 막지 않는다 */ }
  }, []);
  useEffect(() => { loadBalance(); }, [loadBalance]);

  const product = p.products.find((x) => x.line === line);

  /**
   * 컬러 칩 = 그 라인 등록 컬러 + **맥스 슬롯 컬러** (사용자 지시: "맥스 기준으로 다").
   * 전 라인 합집합으로 했더니 메이트 인형·럭스 변형 같은 제품형 항목까지 칩에 딸려
   * 나왔다 (실측 스샷) — 기준을 맥스 한 라인으로 고정한다. 같은 이름 중복(다른 키의
   * 네이비블루 등)은 이름으로 걸러 한 번만 보여준다.
   */
  const maxColors = useMemo(() => {
    const max = p.products.find((x) => /^max$/i.test(x.line))
      ?? [...p.products].sort((a, b) => (b.colors?.length ?? 0) - (a.colors?.length ?? 0))[0];
    return max?.colors ?? [];
  }, [p.products]);
  const colorsFor = (pr: { colors: (typeof p.products)[number]['colors'] } | undefined) => {
    if (!pr) return [];
    const own = pr.colors ?? [];
    const seenKey = new Set(own.map((c) => c.key));
    const seenName = new Set(own.map((c) => c.name));
    return [...own, ...maxColors.filter((c) => !seenKey.has(c.key) && !seenName.has(c.name))];
  };
  const size = sizes.find((s) => s.value === sizeValue);
  const linePoses = p.poses.filter((x) => x.line === line);
  // 사진 편집(base)은 「모델과 함께」 에서만 — 제품만 노출 탭에서는 역할 칩이 없어 base 를 못 고른다
  const hasBaseUpload = flow === 'model' && uploads.some((u) => u.role === 'base');

  /** 라인의 승인된 AI 생성 제품 시트 (최근 승인 순) */
  const sheetsFor = useCallback((l: string) => p.aiSheets.filter((s) => s.line === l), [p.aiSheets]);
  /** 제품을 새로 고르면 첫 시트의 45° 칸을 배치 각도로 미리 골라둔다 — 사람은 바꾸기만 하면 된다 */
  const defaultSheetPick = useCallback((l: string): SheetPick | null => {
    const s = sheetsFor(l)[0];
    const key = s ? defaultPanelKey(s) : '';
    return s && key ? { sheetId: s.id, key } : null;
  }, [sheetsFor]);

  function switchFlow(next: Flow) {
    setFlow(next);
  }
  /*
   * 제품을 고르면 무조건 제미나이 (사용자 확정 2026-09-14).
   * 실측: 같은 배경·같은 AI 생성 제품 칸으로 GPT 는 색·배경은 따라왔지만 맥스·라운저 형태를 다른 의자로 다시 그렸다.
   * GPT 는 제품 없는 컷(분위기 러프 등)에만 남긴다. 서버(route.ts)도 같은 규칙으로 막는다.
   */
  const gptAllowed = !!p.gptEnabled && !line;
  const effectiveEngine: 'gemini' | 'gpt' = gptAllowed ? engine : 'gemini';
  const withPeople = flow === 'model';
  const uploadsForFlow = flow === 'model' ? uploads : uploads.filter((u) => u.role !== 'base');
  /** 형태 보조 칸 수 — 서버(route.ts)와 같은 규칙: 여러 종이면 0, 모델 컷 1, 제품만 2 */
  const supportCount = extraProducts.some((x) => x.line) ? 0 : withPeople ? 1 : 2;

  /**
   * 포즈 소스 — 포즈만 빌리는 용도라 컬러로 거르지 않는다.
   * 같은 라인을 앞에, 그 다음 형태가 같은 라인(Max 계열), 나머지 순.
   * (Mini 라이트그레이처럼 그 색 컷이 0건이어도 다른 색 포즈를 쓸 수 있어야 한다)
   */
  const poseCuts = useMemo(() => {
    const sameShape = new Set(
      p.products.filter((x) => x.line === line || x.sameShapeAs === line || (product?.sameShapeAs && x.line === product.sameShapeAs)).map((x) => x.line),
    );
    /*
     * 고른 컬러에 컷이 있으면 그 컬러만 보여준다 — 색이 맞는 포즈가 있는데
     * 다른 색까지 섞어 보여주면 고르기만 어려워진다.
     * 그 색 컷이 하나도 없을 때만 전체로 넓힌다 (같은 라인 > 같은 형태 > 나머지 순).
     */
    const exact = p.baseCuts.filter((c) => c.line === line && c.colorKey === colorKey);
    if (colorKey && exact.length) return exact.slice(0, 96);

    const rank = (c: BaseCut) => (c.line === line ? 0 : sameShape.has(c.line) ? 1 : 2);
    return [...p.baseCuts].sort((a, b) => rank(a) - rank(b)).slice(0, 96);
  }, [p.baseCuts, p.products, line, colorKey, product]);

  /** 포즈 목록이 선택 컬러로 좁혀졌는지 — 안내 문구에 쓴다 */
  const poseScoped = !!colorKey && p.baseCuts.some((c) => c.line === line && c.colorKey === colorKey);

  const sizeGroups = useMemo(() => {
    const m = new Map<string, WithId<SizePresetDoc>[]>();
    for (const s of sizes) { if (!m.has(s.group)) m.set(s.group, []); m.get(s.group)!.push(s); }
    return [...m.entries()];
  }, [sizes]);

  /*
   * 규격 드롭다운 라벨 — "이름 · 비율 (px)".
   * 생성은 실제로 비율(genAspect)로 도니까 비율을 앞세운다. px 는 최종 게시 규격이라 괄호로 남긴다.
   * 저장된 라벨엔 이모지+이름+(px) 가 이미 들어있어, 뒤의 (px) 만 떼고 비율·px 를 다시 붙인다.
   */
  const sizeOptionLabel = (s: WithId<SizePresetDoc>) => {
    const name = s.label.replace(/\s*\(\s*\d+\s*[×xX]\s*\d+\s*\)\s*$/, '').trim();
    const px = `${s.width}×${s.height}`;
    return name ? `${name} · ${s.genAspect} (${px})` : `${s.genAspect} (${px})`;
  };

  function togglePick(code: string) {
    setPicks((cur) => {
      const i = cur.findIndex((x) => x.code === code);
      if (i >= 0) return cur.filter((x) => x.code !== code);
      if (cur.length >= 4) return cur; // 최대 4명
      const t = p.talents.find((x) => x.code === code);
      return [...cur, { code, expression: 'soft_smile', outfitCode: t?.outfits[0]?.code ?? '' }];
    });
  }

  /** 선택된 모델의 순서 변경 — 순서가 곧 "사진 왼쪽부터" 배정이라 자리 바꿈이 필요하다 */
  function movePick(i: number, dir: -1 | 1) {
    setPicks((cur) => {
      const j = i + dir;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  /** 보관함에서 현재 작업으로 가져오기 (중복 제외) */
  function addFromLibrary(r: ReferenceDoc) {
    setUploads((cur) => (cur.some((u) => u.url === r.url) ? cur : [...cur, { url: r.url, title: r.title, role: flow === 'model' ? 'style' : 'background' }]));
  }

  /** 직접 지정 규격을 '내 규격' 프리셋으로 저장 */
  async function saveCustomSize() {
    setSavingSize(true); setErr('');
    try {
      const res = await fetch('/api/size-presets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ width: Number(customW), height: Number(customH), label: sizeName }),
      });
      const json = await res.json();
      if (!json.ok) { setErr(json.error || '저장 실패'); return; }
      const preset = json.preset as WithId<SizePresetDoc>;
      if (!json.existed) setSizes((cur) => [...cur, preset]);
      setSizeValue(preset.value); // 저장 즉시 그 규격이 선택된다
      setSizeName('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSavingSize(false);
    }
  }

  /** '내 규격' 프리셋 삭제 */
  async function deleteMySize(value: string) {
    if (!window.confirm('이 규격을 삭제할까요?')) return;
    const res = await fetch('/api/size-presets', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    if ((await res.json()).ok) {
      setSizes((cur) => cur.filter((s) => s.value !== value));
      setSizeValue('1000x1000');
    }
  }

  /*
   * 현재 선택을 그대로 조립해 handoffs 에 남긴다.
   * 화면의 선택값은 브라우저 상태라 대화 쪽에서 볼 수 없다 — 이걸 눌러 남겨두면
   * "방금 고른 걸로 뽑아줘" 한마디로 끝난다. 로컬에서만 보인다.
   */
  async function leaveHandoff() {
    setHandoff('busy'); setBusy('handoff'); setErr('');
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...payload(true), handoff: true,
          count: hoCount, resolution: hoRes,
          handoffTitle: hoTitle.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!json.ok) { setErr(json.error || '실패'); setHandoff(null); return; }
      setDry({
        prompt: json.prompt, promptMode: json.promptMode, refs: json.refs,
        aspect: json.aspect, target: json.target,
        usage: json.usage ?? null, promptCost: json.promptCost ?? null,
      });
      setPromptText(json.prompt); setPromptEdited(false);
      setHandoff('done');
      refreshQueue();
      window.setTimeout(() => setHandoff(null), 6000);
    } catch (e) {
      setErr((e as Error).message); setHandoff(null);
    } finally {
      setBusy(null);
    }
  }

  /* 대기열 읽기·삭제 — 로컬 전용. 실제 생성은 대화(MCP)에서 돈다. */
  const refreshQueue = useCallback(async () => {
    if (!p.localMode) return;
    try {
      const res = await fetch('/api/handoffs');
      const json = await res.json();
      if (json.ok) { setQueue(json.items || []); setQueueCredits(json.totalCredits || 0); }
    } catch { /* 대기열 조회 실패는 조용히 넘긴다 — 핵심 흐름이 아니다 */ }
  }, [p.localMode]);

  async function deleteQueued(id: string) {
    try {
      await fetch(`/api/handoffs?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      refreshQueue();
    } catch { /* 무시 */ }
  }

  useEffect(() => { refreshQueue(); }, [refreshQueue]);

  function payload(dryRun: boolean) {
    return {
      mode, dryRun, samples,
      sizeValue,
      ...(sizeValue === 'custom' ? { customSize: { width: Number(customW), height: Number(customH) } } : {}),
      // 탭 — 서버가 형태 보조 칸 수를 이걸로 정한다
      composition: flow,
      /*
       * 제품은 한 종이어도 products[] 로 보낸다 — 배치(placement)·AI 생성 제품 칸(sheetPanel)이
       * 제품마다 붙기 때문이다. 서버는 1종이면 단일 제품으로 다룬다.
       */
      ...(line
        ? {
            products: [
              { line, colorKey, placement: mainPlacement, ...(sheetPick ? { sheetPanel: sheetPick } : {}) },
              ...extraProducts
                .filter((x) => x.line)
                .map((x) => ({ line: x.line, colorKey: x.colorKey, placement: x.placement, ...(x.sheet ? { sheetPanel: x.sheet } : {}) })),
            ],
          }
        : {}),
      // 사람은 「모델과 함께」 탭에서만 — 제품만 노출 탭으로 바꿔도 고른 모델이 몰래 따라가지 않게
      ...(withPeople && picks.length ? { talents: picks } : {}),
      // 포즈는 「모델과 함께」 에서만 — 포즈는 사람이 앉는 방식이다
      ...(withPeople && baseTab === 'posecut' && baseCutUrl ? { baseCutId: baseCutUrl, baseCutUsage: 'pose' } : {}),
      ...(withPeople && baseTab === 'pose' && poseRefKey ? { poseRefKey } : {}),
      ...(withPeople && baseTab === 'pose' && shapeRefKey ? { shapeRefKey } : {}),
      // 제품만 노출 탭에서는 편집 베이스를 보내지 않는다 (모델과 함께에서 base 로 두고 탭을 바꾼 경우)
      ...(uploadsForFlow.length ? { uploadedRefs: uploadsForFlow, preservation } : {}),
      ...(hasBaseUpload && editTargets.length ? { editTargets } : {}),
      ...(withPeople && refProduct ? { refProduct } : {}),
      engine: effectiveEngine,
      ...(imageSize !== '2K' ? { imageSize } : {}),
      ...(direction.trim() ? { direction: direction.trim() } : {}),
      // promptMode 는 보내지 않는다 — 서버 env 가 유일한 결정권자여야
      // 클라이언트가 과금 모드를 강제로 켤 수 없다.
      // 단 사람이 직접 쓴 프롬프트는 예외 — 이건 과금을 늘리는 게 아니라 없애는 방향이다
      ...(promptEdited && promptText.trim() ? { promptOverride: promptText.trim() } : {}),
    };
  }

  async function run(dryRun: boolean) {
    /*
     * GPT 허들 — 전속 모델(얼굴 시트 보유)이 선택돼 있으면 생성을 막는다.
     * GPT 는 얼굴 유지가 안 돼서(실측) 브랜드 모델 일관성이 깨진다.
     * 인물 없는 컷 또는 AI 가상 인물(자유 서술)만 통과. 서버에도 같은 가드가 있다.
     */
    if (!dryRun && effectiveEngine === 'gpt' && withPeople && picks.length > 0) {
      setErr('GPT는 전속 모델 컷에 쓸 수 없습니다 — 인물 없는 컷 또는 AI 가상 인물만 가능합니다. 엔진을 제미나이로 바꾸거나 전속 모델 선택을 비워주세요.');
      return;
    }
    setErr(''); setBusy(dryRun ? 'dry' : 'gen');
    if (!dryRun) setResults([]);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload(dryRun)),
      });
      const json = await res.json();
      if (!json.ok && !json.results) { setErr(json.error || '실패'); return; }
      if (dryRun) setDry(json);
      else {
        setResults(json.results ?? []);
        if (json.prompt) {
          setDry({ prompt: json.prompt, promptMode: json.promptMode, refs: json.refs, aspect: json.aspect, target: json.target, usage: json.usage ?? null, promptCost: json.promptCost ?? null });
          setPromptText(json.prompt);
          setPromptEdited(false);
        }
        if (!json.ok) setErr(json.results?.find((r: GenResult) => r.error)?.error || '생성 실패');
        // 성공한 결과가 하나라도 있으면 완료 팝업을 띄운다
        const ok = (json.results ?? []).filter((r: GenResult) => r.ok);
        if (ok.length) setDonePopup(ok);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      if (!dryRun) loadBalance(); // 차감 결과를 즉시 반영
    }
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true); setErr(''); setUploadNote('');
    try {
      for (const f of Array.from(files).slice(0, 3)) {
        // Vercel 4.5MB 본문 한도 — 브라우저에서 먼저 줄인다 (11MB 사진도 여기서 3MB 이하로)
        const shrunk = await shrinkForUpload(f);
        if (shrunk.bytes !== shrunk.originalBytes) {
          setUploadNote(`${f.name}: ${formatBytes(shrunk.originalBytes)} → ${formatBytes(shrunk.bytes)} 로 줄여서 업로드`);
        }
        const fd = new FormData();
        fd.append('file', shrunk.file);
        fd.append('title', f.name);
        // 이번 작업에만 쓰는 사진 — 보관함에는 올리지 않는다. 보관함은 자산관리 > 레퍼런스에서만 채운다
        fd.append('register', '0');
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        const json = await res.json();
        if (json.ok) {
          setUploads((u) => [...u, { url: json.url, title: json.title, role: flow === 'model' ? 'style' : 'background' }]);
        } else setErr(json.error || '업로드 실패');
      }
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const ORDS = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH', 'NINTH', 'TENTH', 'ELEVENTH', 'TWELFTH', 'THIRTEENTH', 'FOURTEENTH'];

  async function copyText(kind: 'prompt' | 'urls') {
    if (!dry) return;
    const text = kind === 'prompt'
      ? dry.prompt
      : dry.refs.map((r, i) => `[${ORDS[i]}] ${r.title} — ${r.url ?? `(단색 스와치 ${r.swatchHex}, 첨부 생략 가능)`}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      /*
       * 클립보드가 막힌 환경 폴백 — window.prompt 는 Next dev 가 막아서 못 쓴다.
       * 임시 textarea 로 execCommand 복사를 시도하고, 그마저 안 되면 안내만 한다.
       */
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) { setCopied(kind); setTimeout(() => setCopied(null), 1600); return; }
      } catch { /* 아래 안내로 */ }
      setErr('복사가 막혀 있습니다 — 프롬프트 확인 영역에서 직접 드래그해 복사하세요.');
    }
  }

  /** 프롬프트 + 참조 이미지(순번 파일명) ZIP — ChatGPT/Gemini 앱에서 동등 비교용 */
  async function downloadTestKit() {
    if (!dry) return;
    setZipping(true); setErr('');
    try {
      const res = await fetch('/api/test-kit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: dry.prompt, refs: dry.refs, aspect: dry.aspect, target: dry.target }),
      });
      if (!res.ok) { setErr('ZIP 생성 실패'); return; }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'imgcreate-test-kit.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } finally {
      setZipping(false);
    }
  }

  const isMySize = size?.group === MY_SIZE_GROUP;

  /**
   * AI 생성 제품 칸 고르기 — 제품 섹션(첫 제품)과 함께 놓을 제품(추가 제품)이 같이 쓴다.
   * 컴포넌트가 아니라 JSX 를 돌려주는 함수다: 렌더 중 컴포넌트를 만들면 매번 새로 마운트된다.
   */
  function renderSheetPicker(l: string, ck: string, value: SheetPick | null, onChange: (v: SheetPick | null) => void, compact: boolean) {
    const sheets = sheetsFor(l);
    if (!sheets.length) {
      return (
        <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
          승인된 AI 생성 제품이 없어 공식 사진으로 형태를 잡습니다 — 자산관리 &gt; AI 생성 제품에서 시트를 승인하면 여기서 각도를 고를 수 있습니다.
        </div>
      );
    }
    const chosen = value ? sheets.find((s) => s.id === value.sheetId) : undefined;
    const prod = p.products.find((x) => x.line === l);
    const colorName = prod ? colorsFor(prod).find((c) => c.key === ck)?.name : undefined;
    const thumb = compact ? 56 : 76;
    return (
      <div className="mt-3">
        <div className="label mb-1">
          각도 <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>— AI 생성 제품에서 장면에 보여줄 방향을 고릅니다</span>
        </div>
        {sheets.map((s) => (
          <div key={s.id} className="mb-1.5">
            {sheets.length > 1 && (
              <div className="text-[10px] mb-1" style={{ color: 'var(--text-mute)' }}>{s.title}</div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {s.panels.map((panel) => {
                const on = value?.sheetId === s.id && value.key === panel.key;
                return (
                  <button key={panel.key} onClick={() => onChange(on ? null : { sheetId: s.id, key: panel.key })}
                          title={`${s.title} · ${panel.label}`}
                          className="rounded-lg overflow-hidden border block text-center"
                          style={{ width: thumb, padding: 0, background: '#fff',
                                   borderColor: on ? 'var(--accent)' : 'var(--line)', borderWidth: on ? 2 : 1 }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={thumbUrl(panel.url, 256)} alt={panel.label} loading="lazy"
                         className="w-full object-contain" style={{ aspectRatio: '1/1' }} />
                    <div className="text-[9px] px-0.5 py-0.5 truncate"
                         style={{ background: 'var(--surface)', color: on ? 'var(--accent)' : 'var(--text-mute)' }}>
                      {panel.label}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className="text-[10.5px] mt-1 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          {!value || !chosen
            ? '각도를 고르지 않으면 공식 사진으로 형태를 잡습니다.'
            : (() => {
                const panel = chosen.panels.find((x) => x.key === value.key);
                const sup = supportPanels(chosen, value.key, supportCount).map((x) => x.label);
                const colorNote = !ck
                  ? `컬러를 고르지 않아 시트 색(${chosen.colorName}) 그대로 넣습니다`
                  : ck === chosen.colorKey
                    ? `시트 색이 ${colorName ?? chosen.colorName} 이라 그대로 넣습니다`
                    : `${colorName ?? '고른 컬러'} 로 색을 바꿔 넣습니다`;
                return `배치 각도 ${panel?.label ?? value.key}${sup.length ? ` + 형태 보조 ${sup.join('·')}` : ''} · ${colorNote}`;
              })()}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col xl:flex-row h-full">
      {/*
        생성 중 오버레이.
        생성은 25~40초 걸리는데 그동안 화면이 그대로면 도는 건지 멈춘 건지 알 수 없다.
        화면 한가운데에서 계속 움직이는 것 + 흘러가는 초를 같이 보여준다.
        오버레이가 화면을 덮으므로 중복 클릭도 자연히 막힌다.
      */}
      {busy && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center"
             style={{ background: 'rgba(10,11,14,.82)', backdropFilter: 'blur(2px)' }}>
          <div className="flex flex-col items-center gap-4 px-8 py-7 rounded-2xl"
               style={{ background: 'var(--surface)', border: '1px solid var(--line-strong)', minWidth: 260 }}>
            {/* 회전 링 — 바깥은 옅게, 한 조각만 진하게 해서 도는 게 보이도록 */}
            <span
              className="block animate-spin"
              style={{
                width: 46, height: 46, borderRadius: '50%',
                border: '3px solid var(--line)',
                borderTopColor: 'var(--accent)',
                animationDuration: '0.9s',
              }}
            />
            <div className="text-center">
              <div className="text-[14px] font-bold">
                {busy === 'gen' ? '이미지 생성 중' : busy === 'handoff' ? '대화로 넘길 내용 만드는 중' : '프롬프트 만드는 중'}
              </div>
              <div className="text-[11.5px] mt-1.5 tabular-nums" style={{ color: 'var(--text-dim)' }}>
                {Math.floor(elapsed / 60) > 0 && `${Math.floor(elapsed / 60)}분 `}
                {elapsed % 60}초 경과
              </div>
              <div className="text-[10.5px] mt-1" style={{ color: 'var(--text-mute)' }}>
                {busy === 'gen'
                  ? `보통 25~35초 걸립니다${samples > 1 ? ` · ${samples}장` : ''}. 창을 닫지 마세요.`
                  : busy === 'handoff'
                    ? '프롬프트와 선택값을 저장만 합니다 — 생성은 하지 않습니다.'
                    : '레퍼런스를 읽고 프롬프트를 씁니다. 40~50초 걸립니다.'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── 좌: 선택 ── */}
      <div className="flex-1 min-w-0 p-4 sm:p-6 2xl:p-8 xl:overflow-y-auto">
        <header className="mb-5">
          <h1 className="text-[22px] font-extrabold tracking-tight">이미지 생성</h1>
          <p className="text-[13px] mt-1" style={{ color: 'var(--text-dim)' }}>
            어떻게 만들지 먼저 고르면, 그에 맞는 항목만 아래에 나옵니다.
          </p>
        </header>

        {/*
          넓은 화면에서 폼을 680px 에 묶어두면 가운데가 통째로 비어 보인다.
          2xl 부터 2열 masonry 로 펼쳐 화면을 쓰되, 각 카드는 읽기 좋은 폭을 유지한다.
        */}
        <div className="w-full max-w-[1320px] flex flex-col gap-3 2xl:block 2xl:columns-2 2xl:gap-3 [&>*]:2xl:mb-3 [&>*]:2xl:break-inside-avoid">
          {/* 0. 작업 방식 — 이 선택이 아래 섹션 구성을 바꾼다 */}
          <div className="grid sm:grid-cols-2 gap-2.5 2xl:break-inside-avoid">
            {FLOWS.map(({ value: v, title, desc }) => {
              const on = flow === v;
              return (
                <button key={v} onClick={() => switchFlow(v)} className="card p-3.5 text-left"
                        style={{ borderColor: on ? 'var(--accent)' : 'var(--line)', borderWidth: on ? 2 : 1,
                                 background: on ? 'var(--accent-soft)' : 'var(--surface)' }}>
                  <div className="text-[13.5px] font-bold" style={{ color: on ? 'var(--accent)' : 'var(--text)' }}>
                    {on ? '● ' : '○ '}{title}
                  </div>
                  <div className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--text-dim)' }}>{desc}</div>
                </button>
              );
            })}
          </div>

          {/* ① 용도 · 규격 */}
          <Section n="1" title="용도와 규격" hint="프리셋에서 고르거나 픽셀을 직접 지정합니다. 직접 지정한 규격은 저장해서 다시 쓸 수 있습니다.">
            <div className="flex gap-1.5 mb-3">
              {([['thumbnail', '상품 썸네일'], ['banner', '이벤트 배너 · SNS']] as const).map(([v, l]) => (
                <button key={v} onClick={() => setMode(v)} className="btn"
                        style={mode === v ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' } : {}}>
                  {l}
                </button>
              ))}
            </div>
            <select className="input" value={sizeValue} onChange={(e) => setSizeValue(e.target.value)}>
              {sizeGroups.map(([g, list]) => (
                <optgroup key={g} label={g}>
                  {list.map((s) => <option key={s.value} value={s.value}>{sizeOptionLabel(s)}</option>)}
                </optgroup>
              ))}
              <optgroup label="직접 지정">
                <option value="custom">📐 규격 직접 입력…</option>
              </optgroup>
            </select>

            {sizeValue === 'custom' && (
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <input className="input w-[110px]" type="number" min={64} max={8192} value={customW}
                         onChange={(e) => setCustomW(e.target.value)} placeholder="가로 px" />
                  <span style={{ color: 'var(--text-mute)' }}>×</span>
                  <input className="input w-[110px]" type="number" min={64} max={8192} value={customH}
                         onChange={(e) => setCustomH(e.target.value)} placeholder="세로 px" />
                  <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>px</span>
                </div>
                <div className="flex items-center gap-2">
                  <input className="input flex-1" value={sizeName} maxLength={40}
                         onChange={(e) => setSizeName(e.target.value)}
                         placeholder="규격 이름 (선택 — 예: 카카오 채널 배너)" />
                  <button className="btn" onClick={saveCustomSize} disabled={savingSize}>
                    {savingSize ? '저장 중…' : '내 규격으로 저장'}
                  </button>
                </div>
                <div className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>
                  저장하면 &lsquo;{MY_SIZE_GROUP}&rsquo; 그룹에 추가되고 다음부터 목록에서 바로 고를 수 있습니다.
                </div>
              </div>
            )}

            {sizeValue !== 'custom' && size && (
              <div className="text-[11px] mt-2 flex items-center gap-3 flex-wrap" style={{ color: 'var(--text-mute)' }}>
                <span>생성 비율 <b style={{ color: 'var(--text-dim)' }}>{size.genAspect}</b></span>
                {size.retention < 1 && (
                  <span style={{ color: size.retention < 0.7 ? 'var(--warn)' : 'var(--text-mute)' }}>
                    {size.cropAxis === 'vertical' ? '세로' : '가로'} {Math.round((1 - size.retention) * 100)}% 크롭
                    {size.retention < 0.7 && ' — 손실이 큽니다'}
                  </span>
                )}
                {size.variableHeight && <span>세로 가변</span>}
                {isMySize && (
                  <button onClick={() => deleteMySize(size.value)} className="text-[10.5px]"
                          style={{ color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer' }}>
                    이 규격 삭제
                  </button>
                )}
              </div>
            )}
          </Section>

          {/* ② 레퍼런스 — 가장 흔한 시작 행동이라 위로 올렸다 */}
          {flow === 'model' && (
          <Section n="2" title="레퍼런스 이미지"
                   hint="새로 올리거나 보관함에서 가져옵니다. 여기서 올린 이미지는 이번 작업에만 쓰이고 보관함에는 쌓이지 않습니다 — 계속 쓸 사진은 자산관리 > 레퍼런스에서 등록하세요."
                   right={
                     <button className="btn btn-ghost text-[11px]" onClick={() => { setLibOpen(true); setLibCat(''); setLibSub(''); setLibSearch(''); setLibPage(1); }}>
                       보관함 열기 ({library.length})
                     </button>
                   }>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
            <div className="flex gap-2 flex-wrap items-start mb-1">
              <button className="btn" onClick={() => fileInput.current?.click()} disabled={uploading}>
                {uploading ? '업로드 중…' : '＋ 이미지 추가'}
              </button>
            </div>
            {uploadNote && <div className="text-[10.5px] mb-2" style={{ color: 'var(--ok)' }}>{uploadNote}</div>}


            {uploads.map((u, i) => (
              <div key={u.url} className="flex gap-2.5 p-2 rounded-lg mb-2" style={{ background: 'var(--surface-2)' }}>
                <Zoomable src={u.url} alt={u.title} caption={u.title}
                          className="w-[76px] h-[76px] object-cover rounded-lg shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] truncate" style={{ color: 'var(--text-dim)' }}>{u.title}</div>
                    <button onClick={() => setUploads((a) => a.filter((_, j) => j !== i))}
                            className="text-[11px] shrink-0" style={{ color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer' }}>
                      빼기
                    </button>
                  </div>
                  <div className="flex gap-1.5 mt-1.5 flex-wrap">
                    {ROLE_META.map((r) => (
                      <button key={r.value} title={r.desc}
                              onClick={() => setUploads((a) => a.map((x, j) => j === i ? { ...x, role: r.value } : x))}
                              className="chip"
                              style={u.role === r.value ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                  <div className="text-[10px] mt-1" style={{ color: 'var(--text-mute)' }}>
                    {ROLE_META.find((r) => r.value === u.role)?.desc}
                  </div>
                </div>
              </div>
            ))}

            {/*
              베이스 편집 3원칙 — 실측 사고에서 나온 규칙 (라운저 베이스에 Max 를 골라
              장면이 통째로 재구성된 비교 사례). 베이스가 올라온 순간에만 뜬다.
            */}
            {hasBaseUpload && (
              <div className="mt-2 px-3 py-2 rounded-[10px] text-[11px] leading-relaxed"
                   style={{ background: 'rgba(240,180,41,.08)', border: '1px solid var(--warn)', color: 'var(--warn)' }}>
                ⚠ <b>베이스 컷 편집 3원칙</b><br />
                ① 사진 속 제품을 그대로 쓸 거면 <b>제품 선택을 비워두세요</b> — 제품을 고르는 순간 &ldquo;그 제품으로 바꿔라&rdquo;는 명령이 됩니다 (형태·장면이 재구성됨)<br />
                ② 색만 바꿀 땐 방향 지시에 <b>&ldquo;빈백 색상만 ○○로, 나머지 전부 유지&rdquo;</b>라고 적으세요<br />
                ③ 참조는 최소한만 — <b>많이 붙일수록 원본이 흐려집니다</b>
              </div>
            )}

            {/* base 역할이 있으면: 무엇을 바꿀지 */}
            {hasBaseUpload && (
              <div className="mt-2 p-2.5 rounded-lg" style={{ background: 'var(--accent-soft)' }}>
                <div className="label mb-1.5">이 사진에서 무엇을 바꿀까요 (복수 선택)</div>
                <div className="flex flex-wrap gap-1.5">
                  {EDIT_TARGETS.map((t) => {
                    const on = editTargets.includes(t.value);
                    return (
                      <button key={t.value} title={t.desc}
                              onClick={() => setEditTargets((c) => on ? c.filter((x) => x !== t.value) : [...c, t.value])}
                              className="chip"
                              style={on ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--surface)' } : {}}>
                        {t.label}
                      </button>
                    );
                  })}
                </div>
                {editTargets.includes('face') || editTargets.includes('person') || editTargets.includes('add-person') ? (
                  <>
                    <div className="text-[10.5px] mt-2" style={{ color: 'var(--text-dim)' }}>
                      {editTargets.includes('add-person')
                        ? '앉힐 모델을 아래 모델 섹션에서 고르세요. 사진 왼쪽 좌석부터 ①②③④ 순서로 앉습니다. 제품은 비워두세요 — 사진의 빈백을 그대로 씁니다.'
                        : '교체할 모델을 아래 모델 섹션에서 고르세요. 사진 왼쪽 사람부터 ①②③④ 순서로 들어갑니다.'}
                    </div>
                    {/*
                      사진 속 빈백이 무엇인지 알려주면, 그 실측 치수로 모델 크기를 잡는다.
                      빈백 대비 사람이 크게/작게 나오는 걸 막는다 (스케일 앵커).
                    */}
                    <div className="mt-2">
                      <div className="label mb-1">사진 속 빈백 (모델 크기 기준 — 선택)</div>
                      <select className="input py-1 text-[12px]" value={refProduct}
                              onChange={(e) => setRefProduct(e.target.value)}>
                        <option value="">— 모르면 비워두세요 —</option>
                        {p.products.filter((x) => !x.accessory).map((x) => (
                          <option key={x.line} value={x.line}>{x.emoji} {x.line} · {x.sizeText}</option>
                        ))}
                      </select>
                      <div className="text-[10.5px] mt-1 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
                        고르면 그 빈백의 실측 크기로 모델 키와 비교해 앉힙니다 — 빈백 대비 사람이 너무 크거나 작게 나오는 걸 줄입니다.
                      </div>
                    </div>
                  </>
                ) : null}
              </div>
            )}

            {uploads.some((u) => u.role !== 'base') && (
              <div className="mt-2">
                <div className="label mb-1">분위기 참고를 얼마나 살릴까요</div>
                <div className="flex flex-wrap gap-1.5">
                  {p.preservations.map((m) => (
                    <button key={m.value} onClick={() => setPreservation(m.value)} className="chip"
                            style={m.value === preservation ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Section>
          )}

          {/*
            ② 배경 이미지 — 예전 "레퍼런스 이미지" 자리.
            올린 사진은 배경으로 쓰거나(그 공간에 제품·모델을 새로 배치) 분위기만 참고한다.
            사진 편집(base)은 화면에서 뺐다 (사용자 확정 2026-09-14).
          */}
          {flow === 'product' && (
          <Section n="2" title="배경 이미지 (선택)"
                   hint="제품을 놓을 공간 사진을 올리거나 보관함에서 가져옵니다. 사진이 없으면 아래 「배경 · 연출」에 글로 적으면 됩니다. 여기서 올린 사진은 이번 작업에만 쓰이고 보관함에는 쌓이지 않습니다."
                   right={
                     <button className="btn btn-ghost text-[11px]" onClick={() => { setLibOpen(true); setLibCat(''); setLibSub(''); setLibSearch(''); setLibPage(1); }}>
                       보관함 열기 ({library.length})
                     </button>
                   }>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
            <div className="flex gap-2 flex-wrap items-start mb-1">
              <button className="btn" onClick={() => fileInput.current?.click()} disabled={uploading}>
                {uploading ? '업로드 중…' : '＋ 이미지 추가'}
              </button>
            </div>
            {uploadNote && <div className="text-[10.5px] mb-2" style={{ color: 'var(--ok)' }}>{uploadNote}</div>}

            {uploads.map((u, i) => (
              <div key={u.url} className="flex gap-2.5 p-2 rounded-lg mb-2" style={{ background: 'var(--surface-2)' }}>
                <Zoomable src={u.url} alt={u.title} caption={u.title}
                          className="w-[76px] h-[76px] object-cover rounded-lg shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] truncate" style={{ color: 'var(--text-dim)' }}>{u.title}</div>
                    <button onClick={() => setUploads((a) => a.filter((_, j) => j !== i))}
                            className="text-[11px] shrink-0" style={{ color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer' }}>
                      빼기
                    </button>
                  </div>
                  <div className="flex gap-1.5 mt-1.5 flex-wrap">
                    {BG_ROLE_META.map((r) => (
                      <button key={r.value} title={r.desc}
                              onClick={() => setUploads((a) => a.map((x, j) => j === i ? { ...x, role: r.value } : x))}
                              className="chip"
                              style={u.role === r.value ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                  <div className="text-[10px] mt-1" style={{ color: 'var(--text-mute)' }}>
                    {BG_ROLE_META.find((r) => r.value === u.role)?.desc}
                  </div>
                </div>
              </div>
            ))}

            {uploads.some((u) => u.role === 'background') && (
              <div className="text-[10.5px] mt-1 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
                빈백 놓을 자리에 기존 가구가 걸리면 그 가구는 지우고 생성합니다.
              </div>
            )}

            {uploads.some((u) => u.role === 'style') && (
              <div className="mt-2">
                <div className="label mb-1">분위기 참고를 얼마나 살릴까요</div>
                <div className="flex flex-wrap gap-1.5">
                  {p.preservations.map((m) => (
                    <button key={m.value} onClick={() => setPreservation(m.value)} className="chip"
                            style={m.value === preservation ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Section>
          )}

          {/* ③ 제품 · 컬러 · 각도 · 배치 */}
          <Section n="3" title="제품 · 컬러 · 각도"
                   hint={hasBaseUpload
                     ? '사진 속 제품을 그대로 쓸 거면 비워두세요. 다른 제품으로 바꿀 때만 고릅니다.'
                     : '제품을 고르고 컬러칩으로 색을 정한 뒤, 승인된 AI 생성 제품에서 보여줄 각도를 고릅니다. 고른 칸은 컬러칩 색으로 바꿔서 넣습니다.'}>
            <select className="input mb-2" value={line}
                    onChange={(e) => {
                      const next = e.target.value;
                      setLine(next); setColorKey(''); setPoseRefKey(''); setShapeRefKey('');
                      setSheetPick(next ? defaultSheetPick(next) : null);
                    }}>
              <option value="">— 제품 없음 {withPeople ? '(인물·분위기만)' : ''} —</option>
              {/* 메인 제품은 빈백류만 — 메이트 인형·소품은 '함께 놓을 제품'에서 고른다 */}
              {p.products.filter((x) => !x.accessory).map((x) => <option key={x.line} value={x.line}>{x.emoji} {x.line} · {x.sizeText}</option>)}
            </select>
            {withPeople && (
              <div className="text-[10.5px] mb-2 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
                레퍼런스 사진 안에서 <b style={{ color: 'var(--text-dim)' }}>모델만 바꾸는 경우</b>에는 제품·컬러를 고르지 않아도 됩니다 — 사진 속 빈백을 그대로 씁니다.
              </div>
            )}
            {product && (
              <>
                <div className="label mb-1">컬러</div>
                <div className="flex flex-wrap gap-1.5">
                  {colorsFor(product).map((c) => (
                    <button key={c.key} onClick={() => { setColorKey(c.key === colorKey ? '' : c.key); setBaseCutUrl(''); setBaseTab('none'); }}
                            className="flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-lg border text-[11px]"
                            style={{ borderColor: c.key === colorKey ? 'var(--accent)' : 'var(--line)',
                                     background: c.key === colorKey ? 'var(--accent-soft)' : 'transparent' }}>
                      <span className="w-4 h-4 rounded" style={{ background: c.hex, border: '1px solid rgba(255,255,255,.15)' }} />
                      {c.name}
                    </button>
                  ))}
                </div>

                {renderSheetPicker(line, colorKey, sheetPick, setSheetPick, false)}

                <div className="label mt-3 mb-1">배치</div>
                <div className="flex flex-wrap gap-1.5">
                  {PLACEMENTS.map((x) => (
                    <button key={x.value} onClick={() => setMainPlacement(x.value)} className="chip"
                            style={mainPlacement === x.value ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                      {x.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </Section>

          {/*
            포즈 — 예전엔 제품 카드 안에 묻혀 있어 눈에 안 띄었다.
            제품·컬러 다음에 바로 고르는 것이라 제 번호를 단 섹션으로 올린다.
          */}
          {/* 포즈는 사람이 앉는 방식이라 「모델과 함께」 에만 있다 */}
          {withPeople && (
          <Section n="4" title="포즈"
                   hint="우리가 실제로 만든 컷에서 포즈·앵글만 가져오거나, 촬영 원본 실사 포즈 레퍼를 고릅니다. 제품·컬러는 위 선택이 적용됩니다.">
            {!product && (
              <div className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>먼저 제품을 고르세요.</div>
            )}
            {product && (
              <div className="flex gap-1.5 mb-1 flex-wrap">
                {([
                  ['none', '자동', ''],
                  ['posecut', '우리 컷에서 포즈', '우리가 만든 컷의 포즈·앵글·눌림만 빌립니다'],
                  ['pose', '실사 포즈 레퍼', '촬영 원본 — 형태(사람 지운 눌림)와 각도를 각각 고릅니다'],
                ] as const).map(([v, l, tip]) => (
                  <button key={v} title={tip} className="chip"
                          onClick={() => { setBaseTab(v); if (v !== 'posecut') setBaseCutUrl(''); }}
                          style={baseTab === v ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                    {l}
                  </button>
                ))}
              </div>
            )}
            {product && baseTab === 'pose' && (
              linePoses.length ? (
                <>
                  <div className="text-[10.5px] mt-2 mb-2" style={{ color: 'var(--text-mute)' }}>
                    <b style={{ color: 'var(--accent)' }}>형태</b>(사람 지운 눌림)와 <b style={{ color: 'var(--info)' }}>포즈</b>(각도·자세)를
                    <b> 둘 다</b> 고르는 게 가장 정확합니다.
                  </div>
                  <div className="grid grid-cols-4 gap-2 max-h-[240px] overflow-y-auto pr-1">
                    {linePoses.map((r) => (
                      <div key={r.key} className="text-center">
                        <div className="flex gap-1">
                          {([['off', r.offUrl, shapeRefKey], ['on', r.onUrl, poseRefKey]] as const).map(([kind, url, sel]) => (
                            <button key={kind} onClick={() => kind === 'off'
                                      ? setShapeRefKey(shapeRefKey === r.key ? '' : r.key)
                                      : setPoseRefKey(poseRefKey === r.key ? '' : r.key)}
                                    className="flex-1" title={`${r.name} · ${kind === 'off' ? '형태' : '포즈각도'}`}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={thumbUrl(url, 256)} alt={r.name} loading="lazy" className="w-full aspect-square object-cover rounded-md border"
                                   style={{ borderColor: sel === r.key ? 'var(--accent)' : 'var(--line)', borderWidth: sel === r.key ? 2 : 1 }} />
                              <div className="text-[9px] mt-0.5" style={{ color: 'var(--text-mute)' }}>{kind === 'off' ? '형태' : '포즈'}</div>
                            </button>
                          ))}
                        </div>
                        <div className="text-[9.5px] mt-0.5 leading-tight" style={{ color: 'var(--text-mute)' }}>{r.name.replace(/^\S+\s/, '')}</div>
                      </div>
                    ))}
                  </div>
                </>
              ) : <p className="text-[11.5px] mt-2" style={{ color: 'var(--text-mute)' }}>이 제품의 실사 포즈 레퍼가 아직 없습니다.</p>
            )}
            {product && baseTab === 'posecut' && (
              <>
                {poseCuts.length > 0 && (
                  <>
                    <div className="label mt-3 mb-1">
                      포즈{' '}
                      <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>
                        {poseScoped
                          ? ` — ${product?.colors.find((c) => c.key === colorKey)?.name ?? ''} 컷 ${poseCuts.length}개`
                          : colorKey
                            ? ' — 이 컬러엔 컷이 없어 전체에서 고릅니다 (포즈·앵글만 가져옴)'
                            : ' — 우리 썸네일 컷에서 포즈·앵글만 가져옵니다'}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 max-h-[210px] overflow-y-auto pr-1">
                      {poseCuts.map((c, ci) => {
                        const on = baseCutUrl === c.url;
                        return (
                          // 같은 URL 이 두 번 올 수 있어 인덱스를 섞어 key 를 유일하게 만든다
                          <button key={`${c.url}#${ci}`}
                                  onClick={() => {
                                    setBaseCutUrl(on ? '' : c.url);
                                  }}
                                  title={`${c.line} · ${c.colorName}
${c.spec}`}
                                  className="rounded-lg overflow-hidden border block"
                                  style={{ width: 72, padding: 0, background: 'var(--surface)',
                                           borderColor: on ? 'var(--accent)' : 'var(--line)', borderWidth: on ? 2 : 1 }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={c.url} alt={c.spec} loading="lazy"
                                 className="w-full object-cover" style={{ aspectRatio: '1/1' }} />
                            <div className="text-[8.5px] px-1 py-0.5 truncate"
                                 style={{ color: on ? 'var(--accent)' : c.line === line ? 'var(--text-dim)' : 'var(--text-mute)' }}>
                              {c.line} {c.colorName}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </>
            )}
          </Section>
          )}

          {/*
            함께 놓을 제품 · 소품 — 한 컷에 2~3종.
            위치를 안 박으면 모델이 두 제품을 같은 형태·같은 색으로 뭉개버린다.
            그래서 추가하는 순간 첫 제품에도 위치 선택이 생긴다.
            메이트 인형·필로우(소품)도 여기서 고른다 — youtube 제품 데이터에서 끌어왔다.
          */}
          <Section n={withPeople ? '5' : '4'} title="함께 놓을 제품 · 소품"
                   hint="한 컷에 2~3종. 메이트 인형·필로우 같은 소품도 여기서 고릅니다. 제품마다 컬러·각도·배치를 따로 정해야 형태·색이 안 섞입니다.">
            {!line && (
              <div className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>먼저 제품을 고르세요.</div>
            )}
            {line && (
              <div>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="label">
                    함께 놓을 제품{' '}
                    <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>
                      — 한 컷에 2~3종. 위치를 지정해야 형태·색이 안 섞입니다.
                    </span>
                  </div>
                  {extraProducts.length < 2 && (
                    <button className="chip shrink-0"
                            onClick={() => setExtraProducts((c) => [...c, { line: '', colorKey: '', placement: '', sheet: null }])}>
                      + 제품 추가
                    </button>
                  )}
                </div>

                {extraProducts.length > 0 && !mainPlacement && (
                  <div className="text-[10.5px] mb-2" style={{ color: 'var(--warn)' }}>
                    ① {line} 의 배치가 자동입니다 — 위 제품 섹션에서 위치를 정해야 제품끼리 섞이지 않습니다.
                  </div>
                )}

                {extraProducts.map((ex, i) => {
                  const exProd = p.products.find((x) => x.line === ex.line);
                  return (
                    <div key={i} className="mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] shrink-0" style={{ color: 'var(--text-dim)' }}>{i === 0 ? '②' : '③'}</span>
                        <select className="input py-1 text-[11px] flex-1" value={ex.line}
                                onChange={(e) => setExtraProducts((c) =>
                                  c.map((x, j) => (j === i ? { ...x, line: e.target.value, colorKey: '', sheet: e.target.value ? defaultSheetPick(e.target.value) : null } : x)))}>
                          <option value="">— 제품 선택 —</option>
                          <optgroup label="빈백">
                            {p.products.filter((x) => !x.accessory).map((x) => <option key={x.line} value={x.line}>{x.emoji} {x.line}</option>)}
                          </optgroup>
                          {/* 메이트 인형·필로우·소품 — youtube 제품 데이터에서 끌어온 것들 */}
                          <optgroup label="메이트 · 소품">
                            {p.products.filter((x) => !!x.accessory).map((x) => <option key={x.line} value={x.line}>{x.emoji} {x.line}</option>)}
                          </optgroup>
                        </select>
                        <select className="input py-1 text-[11px]" style={{ width: 110 }} value={ex.placement}
                                onChange={(e) => setExtraProducts((c) =>
                                  c.map((x, j) => (j === i ? { ...x, placement: e.target.value } : x)))}>
                          {PLACEMENTS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                        </select>
                        <button className="chip shrink-0" style={{ color: 'var(--text-mute)' }}
                                onClick={() => setExtraProducts((c) => c.filter((_, j) => j !== i))}>✕</button>
                      </div>
                      {exProd && (
                        <div className="flex flex-wrap gap-1.5 mt-1.5 ml-5">
                          {colorsFor(exProd).map((c) => (
                            <button key={c.key}
                                    onClick={() => setExtraProducts((cur) =>
                                      cur.map((x, j) => (j === i ? { ...x, colorKey: c.key === x.colorKey ? '' : c.key } : x)))}
                                    className="flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-lg border text-[11px]"
                                    style={{ borderColor: c.key === ex.colorKey ? 'var(--accent)' : 'var(--line)',
                                             background: c.key === ex.colorKey ? 'var(--accent-soft)' : 'transparent' }}>
                              <span className="w-4 h-4 rounded" style={{ background: c.hex, border: '1px solid rgba(255,255,255,.15)' }} />
                              {c.name}
                            </button>
                          ))}
                        </div>
                      )}
                      {exProd && (
                        <div className="ml-5">
                          {renderSheetPicker(ex.line, ex.colorKey, ex.sheet,
                            (v) => setExtraProducts((cur) => cur.map((x, j) => (j === i ? { ...x, sheet: v } : x))), true)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          {/* 모델 — 전속 모델. 클릭 순서 = 사진 왼쪽부터 */}
          {withPeople && (
          <Section n="6" title="모델" hint="여러 명을 고르면 클릭한 순서대로 ①②③④ — 사진 왼쪽부터 배정됩니다.">
            <div className="flex flex-wrap gap-2 mb-3">
              {p.talents.map((t) => {
                const idx = picks.findIndex((x) => x.code === t.code);
                const on = idx >= 0;
                return (
                  <button key={t.code} onClick={() => togglePick(t.code)}
                          className="relative rounded-lg border overflow-hidden text-left"
                          style={{ borderColor: on ? 'var(--accent)' : 'var(--line)', borderWidth: on ? 2 : 1, width: 68 }}>
                    {on && (
                      <span className="absolute top-1 left-1 z-10 w-[18px] h-[18px] rounded-full text-[11px] font-bold flex items-center justify-center"
                            style={{ background: 'var(--accent)', color: '#fff' }}>{ORD[idx]}</span>
                    )}
                    {t.rep
                      /* eslint-disable-next-line @next/next/no-img-element */
                      ? <img src={t.rep} alt={t.code} className="w-full object-cover" style={{ aspectRatio: '3/4' }} />
                      : <div style={{ aspectRatio: '3/4', background: 'var(--surface-2)' }} />}
                    <div className="text-[10px] text-center py-1" style={{ color: on ? 'var(--accent)' : 'var(--text-mute)' }}>
                      {t.category}{t.slot}
                    </div>
                  </button>
                );
              })}
            </div>

            {picks.length > 0 && (
              <div className="flex flex-col gap-2">
                {picks.length > 1 && (
                  <div className="text-[11px] px-2.5 py-1.5 rounded-lg" style={{ background: 'var(--accent-soft)', color: 'var(--text-dim)' }}>
                    사진 <b style={{ color: 'var(--accent)' }}>왼쪽부터</b> ① → ④ 순서로 배정됩니다.
                  </div>
                )}
                {picks.map((pick, i) => {
                  const t = p.talents.find((x) => x.code === pick.code)!;
                  const arrow = (dir: -1 | 1, on: boolean, label: string) => (
                    <button onClick={() => movePick(i, dir)} disabled={!on} aria-label={label}
                            className="w-[18px] h-[15px] leading-none text-[10px] rounded"
                            style={{ background: 'none', border: 'none', cursor: on ? 'pointer' : 'default',
                                     color: on ? 'var(--text-dim)' : 'var(--line-strong)', padding: 0 }}>
                      {dir === -1 ? '▲' : '▼'}
                    </button>
                  );
                  const setExpr = (id: string) => setPicks((c) => c.map((x, j) => j === i ? { ...x, expression: id } : x));
                  const setOutfit = (code: string) => setPicks((c) => c.map((x, j) => j === i ? { ...x, outfitCode: code } : x));
                  const exprKr = p.expressions.find((e) => e.id === pick.expression)?.kr ?? '';
                  const outfitDesc = t.outfits.find((o) => o.code === pick.outfitCode)?.desc ?? '자동';
                  const sel = (on: boolean) => ({
                    borderColor: on ? 'var(--accent)' : 'var(--line)',
                    borderWidth: on ? 2 : 1,
                    opacity: on ? 1 : 0.7,
                  });
                  return (
                    <div key={pick.code} className="p-2 rounded-lg" style={{ background: 'var(--surface-2)' }}>
                      {/* 1행 — 순번·이동·이름·빼기 */}
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-[13px] font-bold w-5 text-center" style={{ color: 'var(--accent)' }}>{ORD[i]}</span>
                        {/* 순서 변경 — ①이 사진 맨 왼쪽 사람 */}
                        <span className="flex flex-col shrink-0">
                          {arrow(-1, i > 0, '왼쪽으로')}
                          {arrow(1, i < picks.length - 1, '오른쪽으로')}
                        </span>
                        <span className="text-[11.5px] font-semibold">{t.category}{t.slot}</span>
                        <span className="text-[10.5px] truncate" style={{ color: 'var(--text-mute)' }}>
                          {exprKr} · {outfitDesc}
                        </span>
                        <button onClick={() => setPicks((c) => c.filter((_, j) => j !== i))} aria-label="빼기"
                                className="text-[12px] shrink-0 ml-auto"
                                style={{ color: 'var(--text-mute)', background: 'none', border: 'none', cursor: 'pointer' }}>
                          ✕
                        </button>
                      </div>

                      {/* 2행 — 표정: 시트에서 잘라둔 표정컷 썸네일 (없으면 텍스트 칩) */}
                      <div className="label mb-1">표정</div>
                      <div className="flex items-start gap-1.5 mb-2 flex-wrap">
                        {p.expressions.map((ex) => {
                          const url = t.expressionCrops?.[ex.id];
                          const on = pick.expression === ex.id;
                          return url ? (
                            <div key={ex.id} className="text-center shrink-0">
                              <button onClick={() => setExpr(ex.id)} title={ex.kr}
                                      className="rounded-lg overflow-hidden border block" style={{ width: 78, height: 86, padding: 0, background: 'var(--surface)', ...sel(on) }}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={url} alt={ex.kr} loading="lazy" className="w-full h-full object-cover" />
                              </button>
                              <div className="text-[9.5px] mt-0.5" style={{ color: on ? 'var(--accent)' : 'var(--text-mute)' }}>{ex.kr}</div>
                            </div>
                          ) : (
                            <button key={ex.id} onClick={() => setExpr(ex.id)} className="chip"
                                    style={on ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                              {ex.kr}
                            </button>
                          );
                        })}
                      </div>

                      {/* 3행 — 의상: 컨셉 이미지 썸네일 */}
                      <div className="label mb-1">의상</div>
                      <div className="flex items-start gap-1.5 flex-wrap">
                        <button onClick={() => setOutfit('')} className="chip"
                                style={!pick.outfitCode ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
                          자동
                        </button>
                        {t.outfits.map((o) => {
                          const on = pick.outfitCode === o.code;
                          return (
                            <div key={o.code} className="text-center shrink-0" style={{ width: 66 }}>
                              <button onClick={() => setOutfit(o.code)} title={`${o.code} · ${o.desc}`}
                                      className="rounded-lg overflow-hidden border block" style={{ width: 66, height: 86, padding: 0, background: 'var(--surface)', ...sel(on) }}>
                                {o.imageUrl ? (
                                  /* eslint-disable-next-line @next/next/no-img-element */
                                  <img src={o.imageUrl} alt={o.desc} loading="lazy" className="w-full h-full object-cover object-top" />
                                ) : (
                                  /* 전속 모델 화면에서 사진 없이 글로만 등록한 의상 — 프롬프트 문장으로 들어간다 */
                                  <div className="w-full h-full flex items-center justify-center text-[8.5px] px-1 text-center leading-tight"
                                       style={{ color: 'var(--text-mute)' }}>
                                    글로만<br />지정
                                  </div>
                                )}
                              </button>
                              <div className="text-[9px] mt-0.5 truncate" style={{ color: on ? 'var(--accent)' : 'var(--text-mute)' }}>{o.desc}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>
          )}

          {/*
            연출(카메라·조명·인물구성) 드롭다운은 뺐다 — 5개를 따로 고르는 것보다
            방향 지시에 한 줄로 쓰는 편이 자연스럽고 헷갈리지 않는다.
            (variation_options 데이터는 남아 있어 필요하면 되살릴 수 있다)
          */}

          {/* 배경 · 연출 (글) — 배경 사진이 없으면 여기 적은 글이 배경을 정한다 */}
          <Section n={withPeople ? '7' : '5'} title="배경 · 연출" hint="배경 공간·조명·분위기를 한글로 편하게 적으면 됩니다. 배경 사진을 올렸다면 그 공간에 더할 것만 적으세요.">
            {/*
              광각 배너(21:9·16:9) 힌트 — 넓게 뽑으면 한쪽을 비워야 글자가 들어간다.
              애초에 빈 쪽이 없으면 배너 스튜디오의 자동 배치도 놓을 자리가 없다.
              그래서 배너급 가로 규격을 고르면 '한쪽 비우기' 한 줄을 제안한다 (넣을지는 사용자 선택).
            */}
            {size && (size.genAspect === '21:9' || size.genAspect === '16:9') && (
              <div className="mb-2">
                <div className="text-[11px] mb-1" style={{ color: 'var(--text-dim)' }}>
                  가로로 넓은 배너예요 — 글자 들어갈 자리를 비워두면 좋습니다:
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    ['왼쪽 비우기', '인물과 제품을 화면 오른쪽에 배치하고, 왼쪽 1/3은 벽·여백으로 비워 글자 자리를 남긴다'],
                    ['오른쪽 비우기', '인물과 제품을 화면 왼쪽에 배치하고, 오른쪽 1/3은 벽·여백으로 비워 글자 자리를 남긴다'],
                  ].map(([label, hint]) => (
                    <button key={label} type="button" className="chip"
                            onClick={() => setDirection((d) => d.includes(hint) ? d : (d.trim() ? `${d.trim()}
${hint}` : hint))}>
                      + {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <textarea className="input" rows={3} value={direction} onChange={(e) => setDirection(e.target.value)}
                      placeholder="예: 창가 자연광이 드는 아늑한 거실, 45도 측면에서, 옆에 작은 화분" />
          </Section>
        </div>
      </div>

      {/* ── 우: 미리보기 · 실행 ── */}
      <aside
        className="w-full xl:w-[336px] 2xl:w-[380px] shrink-0 border-t xl:border-t-0 xl:border-l p-4 sm:p-5 xl:overflow-y-auto"
        style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
      >
        {dry?.prompt && (
          <div className="card p-3 mb-4" style={{ borderColor: 'var(--accent-dim)' }}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[13px] font-bold">
                프롬프트{' '}
                <span className="font-normal" style={{ color: 'var(--text-mute)' }}>
                  ({promptEdited ? '직접 입력' : dry.promptMode})
                </span>
              </h2>
              <span className="text-[10px]" style={{ color: 'var(--text-mute)' }}>{dry.aspect ?? ''}</span>
            </div>
            {/* 읽기 전용이 아니다 — 고쳐 쓰거나 통째로 붙여넣으면 그대로 생성에 쓰인다 */}
            <textarea
              value={promptText}
              onChange={(e) => { setPromptText(e.target.value); setPromptEdited(true); }}
              placeholder="여기에 프롬프트를 붙여넣으면 그대로 생성에 쓰입니다."
              className="input font-mono text-[10px] leading-relaxed"
              style={{ height: 150, resize: 'vertical' }}
            />
            {promptEdited && (
              <div className="text-[10px] mt-1.5 px-0.5 leading-relaxed" style={{ color: 'var(--ok)' }}>
                이 프롬프트가 그대로 들어갑니다 — 템플릿도 Opus 도 타지 않습니다.
                참조 이미지 순서는 아래 목록 그대로이니 FIRST/SECOND 지칭을 맞춰 쓰세요.
              </div>
            )}
            <div className="flex gap-1.5 mt-2 flex-wrap">
              <button className="btn text-[11px]" onClick={() => copyText('prompt')}>{copied === 'prompt' ? '복사됨 ✓' : '프롬프트 복사'}</button>
              {promptEdited && (
                <button className="btn text-[11px]"
                        onClick={() => { setPromptText(dry.prompt); setPromptEdited(false); }}>
                  되돌리기
                </button>
              )}
              <button className="btn text-[11px]" onClick={() => copyText('urls')}>{copied === 'urls' ? '복사됨 ✓' : '참조 URL 복사'}</button>
              <button className="btn text-[11px]" onClick={downloadTestKit} disabled={zipping}>{zipping ? '묶는 중…' : '테스트 키트 ZIP'}</button>
            </div>
            <div className="text-[10px] mt-2 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
              ChatGPT·Gemini 앱에서 비교하려면 <b>참조 이미지를 같은 순서로 첨부</b>한 뒤 프롬프트를 붙여넣으세요.
              ZIP에 순번 파일명 + 프롬프트 txt가 들어 있습니다.
            </div>
          </div>
        )}

        <h2 className="text-[13.5px] font-bold mb-3">
          참조 이미지
          {!!dry?.refs?.some((r) => r.kind === 'sheet') && (
            <span className="text-[10.5px] font-normal ml-1.5" style={{ color: 'var(--text-mute)' }}>
              AI 생성 제품 {dry.refs.filter((r) => r.kind === 'sheet').length}칸
            </span>
          )}
        </h2>
        {dry?.refs?.length ? (
          <div className="flex flex-col gap-1.5 mb-4">
            {dry.refs.map((r, i) => (
              <div key={i} className="flex items-center gap-2 p-1.5 rounded-lg" style={{ background: 'var(--surface-2)' }}>
                <span className="text-[9.5px] w-[46px] shrink-0 font-bold" style={{ color: 'var(--accent)' }}>
                  {ORDS[i]}
                </span>
                {r.swatchHex
                  ? <span className="w-8 h-8 rounded shrink-0" style={{ background: r.swatchHex, border: '1px solid rgba(255,255,255,.15)' }} />
                  /* eslint-disable-next-line @next/next/no-img-element */
                  : <img src={r.url} alt={r.title} className="w-8 h-8 object-cover rounded shrink-0" />}
                <span className="text-[10.5px] leading-tight" style={{ color: 'var(--text-dim)' }}>
                  {r.kind === 'sheet' && (
                    <span className="text-[9px] font-bold px-1 py-px rounded mr-1" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>AI 제품</span>
                  )}
                  {r.title}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[11.5px] mb-4" style={{ color: 'var(--text-mute)' }}>
            선택을 마치고 <b>프롬프트 확인</b>을 누르면 어떤 이미지가 들어가는지 여기 표시됩니다.
          </p>
        )}

        <div className="flex flex-col gap-2 mb-4">
          <button className="btn" onClick={() => run(true)} disabled={!!busy}>
            {busy === 'dry'
              ? '만드는 중…'
              : writer === 'opus'
                ? '프롬프트 확인 (Opus 작성)'
                : '프롬프트 확인 (무료)'}
          </button>

          {/*
            대화로 넘기기 — 로컬 전용.
            화면에서 고른 값은 브라우저 상태라 대화 쪽에서 볼 수 없다. 이 버튼이
            프롬프트·참조 순서·선택값을 handoffs 에 남겨서, 말로 다시 설명할 필요를 없앤다.
          */}
          {p.localMode && (
            <>
              {/* 대기열에 남길 조건 — 장수·해상도·이름. 크레딧을 미리 추정해 보여준다. */}
              <div className="rounded-[10px] p-2 mt-1" style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
                <div className="label mb-1.5">힉스필드 대기열에 추가</div>
                <input value={hoTitle} onChange={(e) => setHoTitle(e.target.value)}
                       placeholder="대기열 이름 (예: 여성ABC 라운지 · 웹배너)"
                       className="w-full mb-1.5 px-2 py-1 text-[12px] rounded-[8px]"
                       style={{ background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text)' }} />
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-1">
                    <span className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>장수</span>
                    {[1, 2, 3, 4].map((n) => (
                      <button key={n} className={`btn px-2 py-0.5 ${hoCount === n ? 'btn-primary' : ''}`}
                              onClick={() => setHoCount(n)}>{n}</button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>해상도</span>
                    {(['2k', '4k'] as const).map((r) => (
                      <button key={r} className={`btn px-2 py-0.5 ${hoRes === r ? 'btn-primary' : ''}`}
                              onClick={() => setHoRes(r)}>{r.toUpperCase()}</button>
                    ))}
                  </div>
                  <span className="text-[10.5px] ml-auto" style={{ color: 'var(--text-mute)' }}>
                    약 {hoCount * (hoRes === '4k' ? 4 : 1)} 크레딧
                  </span>
                </div>
              </div>

              <button className="btn" onClick={leaveHandoff} disabled={!!busy || handoff === 'busy'}
                      title="프롬프트와 지금 고른 값(모델·표정·의상·규격·레퍼런스)을 대기열에 저장합니다. 대화에서 '대기열 돌려줘' 한마디로 한꺼번에 뽑습니다. 프롬프트는 대화에서 쓰므로 Opus 를 타지 않습니다."
                      style={handoff === 'done' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : {}}>
                {handoff === 'busy' ? '남기는 중…' : handoff === 'done' ? '대기열에 넣었습니다 ✓' : '대기열에 추가'}
              </button>

              {handoff === 'done' && (
                <div className="text-[10px] px-1" style={{ color: 'var(--ok)' }}>
                  대기열에 넣었습니다. 대화에서 &quot;대기열 돌려줘&quot; 라고 하시면 한꺼번에 뽑습니다.
                </div>
              )}

              {/* 대기열 목록 — 지금 무엇이 쌓여 있고 총 몇 크레딧인지 한눈에. */}
              {queue.length > 0 && (
                <div className="rounded-[10px] p-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
                  <div className="flex items-center mb-1.5">
                    <span className="label">대기열 {queue.length}건</span>
                    <span className="text-[10.5px] ml-auto" style={{ color: 'var(--text-mute)' }}>
                      총 약 {queueCredits} 크레딧
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {queue.map((q) => (
                      <div key={q.id} className="flex items-center gap-2 px-2 py-1 rounded-[8px]"
                           style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}>
                        <div className="min-w-0 flex-1">
                          <div className="text-[12px] truncate" style={{ color: 'var(--text)' }}>{q.title}</div>
                          <div className="text-[10px]" style={{ color: 'var(--text-mute)' }}>
                            {q.count}장 · {q.resolution.toUpperCase()} · {q.aspect || q.sizeLabel || ''}
                            {q.talentCount ? ` · 모델 ${q.talentCount}` : ''}
                            {q.refCount ? ` · 참조 ${q.refCount}` : ''}
                          </div>
                        </div>
                        <span className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>{q.credits}cr</span>
                        <button className="btn px-2 py-0.5" onClick={() => deleteQueued(q.id)} title="대기열에서 제거">✕</button>
                      </div>
                    ))}
                  </div>
                  <div className="text-[10px] mt-1.5 px-1" style={{ color: 'var(--text-mute)' }}>
                    실제 생성은 대화(MCP)에서 돕니다. &quot;대기열 돌려줘&quot; 하면 장수·크레딧·잔액을 먼저 알려드리고 승인 후 뽑습니다.
                  </div>
                </div>
              )}
            </>
          )}
          {/*
            엔진 선택은 화면에서 뺐다.
            힉스필드는 앱이 쓰는 API 키에 크레딧이 없어 어차피 못 쓰고(대화용 MCP 계정과 지갑이 다르다),
            골라봐야 403 을 맞을 뿐이다. 앱의 생성은 나노바나나 하나다.
            백엔드의 힉스필드 경로는 살려둔다 — 크레딧을 붙이면 다시 열면 된다.
          */}

          {/* 사용량 — 장수만 보여준다. 금액 표시는 사용자 지시로 뺐다 ("몇 개 생성했다 정도만") */}
          <div className="text-[10.5px] px-1 leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            {balance?.gemini ? (
              <>
                이번 달 생성 <b style={{ color: 'var(--text-dim)' }}>{balance.gemini.count}/{balance.gemini.limit}장</b>
                {` (남은 ${balance.gemini.remaining}장) → 이번에 `}
                <b style={{ color: 'var(--warn)' }}>{samples}장 생성</b>
              </>
            ) : '사용량을 불러오는 중…'}
          </div>

          {/* 생성 엔진 — 제미나이(기본) / GPT. GPT 는 키가 있을 때만 열린다 */}
          <div className="flex gap-1.5">
            <button onClick={() => setEngine('gemini')} className="chip flex-1 justify-center"
                    title="나노바나나(gemini-3-pro-image) — 기본 엔진. 2K/4K 지원."
                    style={effectiveEngine === 'gemini' ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
              제미나이로 생성하기
            </button>
            {gptAllowed && (
              <button onClick={() => { setEngine('gpt'); setImageSize('2K'); }} className="chip flex-1 justify-center"
                      title="GPT(gpt-image-1) — 최대 1536px, POP·인쇄용 4K 없음. 비용은 OpenAI 계정에서 나갑니다 (장당 약 $0.2 안팎, 참고치)."
                      style={engine === 'gpt' ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                GPT로 생성하기
              </button>
            )}
          </div>
          {effectiveEngine === 'gpt' && (
            <div className="text-[10px] px-1" style={{ color: 'var(--text-mute)' }}>
              gpt-image-1 · 최대 1536px (POP/인쇄용 없음) · 제품 없는 컷 전용
            </div>
          )}
          {p.gptEnabled && !!line && (
            <div className="text-[10px] px-1" style={{ color: 'var(--text-mute)' }}>
              제품이 들어간 컷은 제미나이로만 생성합니다 — GPT 는 제품 형태를 참조대로 못 그립니다(실측).
            </div>
          )}
          {/* GPT 는 참조 조건화가 느슨해 전속 모델 얼굴이 유지되지 않는다 (실측) — 고르면 미리 경고 */}
          {effectiveEngine === 'gpt' && withPeople && picks.length > 0 && (
            <div className="text-[10px] px-1" style={{ color: 'var(--warn)' }}>
              ⚠ GPT는 전속 모델 얼굴 유지력이 낮습니다 (실측: 얼굴이 바뀜) — 모델 얼굴이 중요한 컷은 제미나이를 쓰세요.
            </div>
          )}

          {/* 화질 — 웹·SNS 는 2K 로 충분, POP·인쇄물만 4K. 실측 4096px = A3 248dpi (GPT 는 4K 없음) */}
          <div>
            <div className="flex gap-1.5">
              {([['2K', '2K · 웹/SNS 기본'], ['4K', '4K · POP/인쇄용']] as const)
                .filter(([v]) => effectiveEngine !== 'gpt' || v !== '4K')
                .map(([v, l]) => (
                <button key={v} onClick={() => setImageSize(v)} className="chip flex-1 justify-center"
                        title={v === '4K'
                          ? '4096px — A3 포스터 248dpi급 인쇄 화질.'
                          : '2048px — 자사몰·스마트스토어·SNS 게시엔 이 화질로 충분합니다.'}
                        style={imageSize === v ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                  {l}
                </button>
              ))}
            </div>
            {imageSize === '4K' && (
              <div className="text-[10px] px-1 mt-1" style={{ color: 'var(--warn)' }}>
                4K는 포스터·인쇄물에만 권장 — 웹·SNS 게시는 2K로 충분합니다.
              </div>
            )}
            {/* 얼굴 보호 — 서버가 강제하는 규칙을 화면에도 말해둔다. 몰래 커지면 "왜 파일이 크지?"가 된다 */}
            {withPeople && picks.length > 0 && (
              <div className="text-[10px] px-1 mt-1" style={{ color: 'var(--text-mute)' }}>
                🛡 전속 모델 컷은 얼굴 보호를 위해 결과물이 자동으로 짧은 변 2048px까지 상향됩니다 (작은 규격을 골라도 서버가 올립니다).
              </div>
            )}
          </div>

          {/*
            프롬프트 작성 방식은 고르는 게 아니라 환경이 정한다.
            로컬(PROMPT_MODE=local) = 템플릿 조립, 무과금.
            배포 = Opus 가 레퍼런스를 보고 직접 작성.
            버튼으로 두면 로컬에서 실수로 유료를 눌러 돈이 나간다 — 그래서 표시만 한다.
          */}
          <div className="text-[10px] px-1" style={{ color: writer === 'opus' ? 'var(--info)' : 'var(--text-mute)' }}>
            {writer === 'opus' ? (
              <>
                프롬프트 — <b>Opus 작성</b> · 레퍼런스를 직접 보고 씁니다.{' '}
                {dry?.promptMode === 'opus' && dry.usage ? (
                  <>
                    직전 실측 <b>{(dry.usage.input_tokens + dry.usage.output_tokens).toLocaleString()} 토큰</b>
                  </>
                ) : (
                  <>레퍼런스를 직접 읽고 프롬프트를 씁니다.</>
                )}
              </>
            ) : (
              <>프롬프트 — <b>템플릿 조립</b> (로컬 개발 모드)</>
            )}
          </div>
          <div className="flex gap-2">
            <select className="input flex-1" value={samples} onChange={(e) => setSamples(Number(e.target.value))}>
              <option value={1}>1장</option>
              <option value={2}>2장 (골라쓰기)</option>
            </select>
            <button className="btn btn-primary flex-1" onClick={() => run(false)} disabled={!!busy}>
              {busy === 'gen' ? '생성 중…' : '생성'}
            </button>
          </div>
          <div className="text-[10.5px] text-center" style={{ color: 'var(--text-mute)' }}>
            25~35초/장
          </div>
        </div>

        {err && (
          <div className="card p-2.5 mb-4 text-[11.5px]" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>{err}</div>
        )}

        {results.length > 0 && (
          <div className="mb-4">
            <h2 className="text-[13.5px] font-bold mb-2">결과</h2>
            <div className="flex flex-col gap-2">
              {results.map((r, i) => r.ok ? (
                <div key={i}>
                  <a href={r.url} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={r.url} alt="생성 결과" className="w-full rounded-lg border" style={{ borderColor: 'var(--line-strong)' }} />
                  </a>
                  <div className="text-[10px] mt-1 flex gap-2 flex-wrap" style={{ color: 'var(--text-mute)' }}>
                    <span>{r.width}×{r.height}</span>
                    <span>{((r.elapsedMs ?? 0) / 1000).toFixed(1)}초</span>
                    {r.deltaE != null && (
                      <span style={{ color: r.deltaE < 5 ? 'var(--ok)' : r.deltaE < 15 ? 'var(--warn)' : 'var(--danger)' }}>
                        컬러 ΔE {r.deltaE}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <div key={i} className="card p-2 text-[11px]" style={{ color: 'var(--danger)' }}>
                  {r.blockReason ? `안전필터 차단 (${r.blockReason})` : r.error}
                </div>
              ))}
            </div>
          </div>
        )}


      </aside>

      {/* ── 레퍼런스 보관함 팝업 — 분류(촬영/배너/SNS)별로 전체를 보고 고른다 ── */}
      {libOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
             style={{ background: 'rgba(0,0,0,.8)' }} onClick={() => setLibOpen(false)}>
          <div className="card p-4 max-w-[min(1200px,95vw)] max-h-[92vh] w-full flex flex-col"
               onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-[15px] font-bold" style={{ color: 'var(--text)' }}>
                레퍼런스 보관함 · {library.length}개
              </h2>
              <button className="chip" onClick={() => setLibOpen(false)}>닫기</button>
            </div>

            {/* 분류 탭 + 이름 검색 */}
            <div className="flex items-center gap-1.5 flex-wrap mb-3">
              <button className="chip"
                      style={libCat === '' ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}
                      onClick={() => { setLibCat(''); setLibSub(''); setLibPage(1); }}>전체 ({library.length})</button>
              {REF_CATS.map((c) => {
                const n = library.filter((r) => refCatOf(r.category) === c.value).length;
                if (!n) return null;
                return (
                  <button key={c.value} className="chip"
                          style={libCat === c.value ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}
                          onClick={() => { setLibCat(c.value); setLibSub(''); setLibPage(1); }}>{c.label} ({n})</button>
                );
              })}
              {/*
                고른 전속 모델의 레퍼런스로 한 번에 — 모델컷 분류 안에서 그 모델(sub)만 남긴다.
                자산관리 > 레퍼런스에서 [모델 지정] 으로 묶어둔 사진들이 여기 걸린다.
              */}
              {picks.map((pk) => {
                const t = p.talents.find((x) => x.code === pk.code);
                const label = t ? `${t.category}${t.slot ?? ''}` : '';
                const n = label ? library.filter((r) => refCatOf(r.category) === 'model' && r.sub === label).length : 0;
                if (!label || !n) return null;
                const on = libCat === 'model' && libSub === label;
                return (
                  <button key={pk.code} className="chip"
                          title={`${label} 레퍼런스만 보기 (${n}장)`}
                          onClick={() => {
                            if (on) { setLibCat(''); setLibSub(''); } else { setLibCat('model'); setLibSub(label); }
                            setLibPage(1);
                          }}
                          style={on ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}>
                    ☺ {label} 레퍼런스 ({n})
                  </button>
                );
              })}
              <input value={libSearch} onChange={(e) => { setLibSearch(e.target.value); setLibPage(1); }} placeholder="이름 검색"
                     className="ml-auto px-2 py-1 text-[12px] rounded-[8px]"
                     style={{ background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text)', maxWidth: 200 }} />
            </div>

            {/* 하위 분류 — 촬영 2022(22 맥스…) 처럼 sub 가 있는 탭에서만 한 줄 더 */}
            {libCat && (() => {
              const subs = ([...new Set(library
                .filter((r) => refCatOf(r.category) === libCat && r.sub)
                .map((r) => r.sub))] as string[]).sort();
              if (!subs.length) return null;
              return (
                <div className="flex items-center gap-1.5 flex-wrap mb-3">
                  <button className="chip"
                          style={!libSub ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}
                          onClick={() => { setLibSub(''); setLibPage(1); }}>전체</button>
                  {subs.map((s) => (
                    <button key={s} className="chip"
                            style={libSub === s ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : {}}
                            onClick={() => { setLibSub(s === libSub ? '' : s); setLibPage(1); }}>
                      {s} ({library.filter((r) => refCatOf(r.category) === libCat && r.sub === s).length})
                    </button>
                  ))}
                </div>
              );
            })()}

            {/* 목록 — 전체면 분류별 섹션, 특정 분류면 단일 그리드 */}
            <div className="overflow-y-auto pr-1 flex-1" style={{ minHeight: 220 }}>
              {(() => {
                const q = libSearch.trim().toLowerCase();
                const match = (r: ReferenceDoc) =>
                  (!libCat || refCatOf(r.category) === libCat) &&
                  (!libSub || r.sub === libSub) &&
                  (!q || (r.title || '').toLowerCase().includes(q));
                const list = library.filter(match);
                if (!list.length) {
                  return (
                    <div className="text-[12px] py-10 text-center" style={{ color: 'var(--text-mute)' }}>
                      {library.length ? '해당 조건의 레퍼런스가 없습니다.' : '보관함이 비어 있습니다. 자산관리 > 레퍼런스에서 등록하거나 위에서 이미지를 추가하세요.'}
                    </div>
                  );
                }
                // 게시판식 페이지 — 한 페이지 20장만 그려서 이미지 로딩이 밀리지 않게 한다
                const totalPages = Math.max(1, Math.ceil(list.length / LIB_PAGE));
                const page = Math.min(libPage, totalPages);
                const items = list.slice((page - 1) * LIB_PAGE, page * LIB_PAGE);
                // 페이지 번호는 10개 블록 단위 (1~10 / 11~20 …) — 좌우 « ‹ › » 로 이동
                const blockStart = Math.floor((page - 1) / 10) * 10 + 1;
                const blockPages = Array.from({ length: Math.min(10, totalPages - blockStart + 1) }, (_, k) => blockStart + k);
                const goto = (p: number) => setLibPage(Math.max(1, Math.min(totalPages, p)));
                return (
                  <div>
                    <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-2">
                      {items.map((r) => {
                        const used = uploads.some((u) => u.url === r.url);
                        const catLabel = REF_CATS.find((c) => c.value === refCatOf(r.category))?.label;
                        return (
                          <div key={r.url} className="rounded-lg overflow-hidden border relative"
                               style={{ borderColor: used ? 'var(--accent)' : 'var(--line)', background: 'var(--surface-2)' }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={thumbUrl(r.url, 256)} alt={r.title} className="w-full aspect-square object-cover"
                                 style={{ opacity: used ? 0.5 : 1 }} draggable={false} loading="lazy" />
                            {!libCat && catLabel && (
                              <span className="absolute top-1 left-1 text-[8.5px] px-1 py-0.5 rounded"
                                    style={{ background: 'rgba(0,0,0,.55)', color: '#9fd1ff' }}>{catLabel}</span>
                            )}
                            <div className="p-1.5">
                              <div className="text-[10.5px] truncate mb-1" style={{ color: 'var(--text-dim)' }}>{r.title}</div>
                              <button className={`btn w-full py-0.5 text-[11px] ${used ? '' : 'btn-primary'}`}
                                      disabled={used} onClick={() => addFromLibrary(r)}>
                                {used ? '추가됨 ✓' : '＋ 추가'}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {totalPages > 1 && (
                      <div className="flex items-center justify-center gap-1 mt-3 flex-wrap">
                        <button className="chip px-2" disabled={page === 1} onClick={() => goto(1)} title="첫 페이지">«</button>
                        <button className="chip px-2" disabled={blockStart === 1} onClick={() => goto(blockStart - 1)} title="이전 10페이지">‹</button>
                        {blockPages.map((p) => (
                          <button key={p} className="chip px-2"
                                  onClick={() => goto(p)}
                                  style={p === page ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)', fontWeight: 700 } : {}}>
                            {p}
                          </button>
                        ))}
                        <button className="chip px-2" disabled={blockStart + 10 > totalPages} onClick={() => goto(blockStart + 10)} title="다음 10페이지">›</button>
                        <button className="chip px-2" disabled={page === totalPages} onClick={() => goto(totalPages)} title="마지막 페이지">»</button>
                        <span className="text-[10.5px] ml-2" style={{ color: 'var(--text-mute)' }}>
                          {page}/{totalPages} · 총 {list.length.toLocaleString()}장
                        </span>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

            <div className="flex items-center justify-between mt-3 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
              <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>이번 작업에 {uploads.length}개 담김</span>
              <button className="btn btn-primary" onClick={() => setLibOpen(false)}>완료</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 생성 완료 팝업 ── */}
      {donePopup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
             style={{ background: 'rgba(0,0,0,.8)' }} onClick={() => setDonePopup(null)}>
          <div className="card p-4 max-w-[min(1100px,94vw)] max-h-[92vh] overflow-y-auto w-full"
               onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-[15px] font-bold" style={{ color: 'var(--text)' }}>
                ✓ 생성 완료 · {donePopup.length}장
              </h2>
              <button className="chip" onClick={() => setDonePopup(null)}>닫기</button>
            </div>
            <div className={`grid gap-3 ${donePopup.length > 1 ? 'sm:grid-cols-2' : ''}`}>
              {donePopup.map((r, i) => (
                <div key={i}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={r.url} alt="생성 결과" className="w-full rounded-lg border"
                       style={{ borderColor: 'var(--line-strong)' }} />
                  <div className="text-[10.5px] mt-1 flex gap-2 flex-wrap" style={{ color: 'var(--text-mute)' }}>
                    <span>{r.width}×{r.height}</span>
                    {r.deltaE != null && <span>컬러 ΔE {r.deltaE}</span>}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-3 justify-end flex-wrap">
              <a href={donePopup[0].url} target="_blank" rel="noreferrer" className="btn">원본 열기</a>
              <a href="/cuts" className="btn">생성이미지 갤러리</a>
              <button className="btn btn-primary" onClick={() => setDonePopup(null)}>확인</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
