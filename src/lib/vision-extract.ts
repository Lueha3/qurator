// 스크린샷 Vision 추출 — docs/06-screenshot-capture.md §4.1 정본 구현.
//
// ai-hook.ts와 동일한 그레이스풀 디그레이드 규율을 따른다:
//   1. 실패해도(키 없음/타임아웃/네트워크 오류/비-JSON 응답/필수 필드 누락) 절대 throw하지 않고
//      null을 반환한다 — 호출부(캡처 핸들러)는 null을 "빈 카드 + 직접 입력"으로 처리한다.
//   2. 여기서는 구조화 출력(beta) 대신 텍스트 프롬프트로 JSON만 뱉게 지시하고 직접 JSON.parse한다 —
//      이 SDK 버전에서 output_config.format의 정확한 와이어 스펙을 검증하지 않은 채 추측하면
//      조용히 실패할 수 있어, 첫 구현에서는 검증된 경로(텍스트 → JSON.parse)만 쓴다.
//   3. 모델이 화면에 없는 값을 지어낼 수 있으므로("약 5만원" 같은 문자열이 가격 필드에 들어오는 등)
//      모든 필드를 방어적으로 재검증한다 — 타입이 안 맞으면 그 필드만 null로 떨어뜨리고,
//      절대 caller를 향해 예외를 던지지 않는다.
//
// 이미지는 이 함수 안에서만 잠깐 base64로 들고 있다가 Claude에 보내고 버린다 — 디스크·DB·로그에
// 쓰지 않는다(docs/06 §4.3). 호출부도 같은 원칙을 지켜야 한다: 응답을 받은 뒤 원본 base64를 저장하지 말 것.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5";
/**
 * 상품 1건 응답은 200토큰이면 충분하지만, 좋아요 목록(그리드) 한 장에는 상품이 24개까지 들어온다
 * (docs/06 §4.6). 상한은 비용이 아니라 잘림 방지용이라 넉넉히 둔다 — 잘린 JSON은 파싱 실패가 되어
 * 통째로 버려진다.
 */
const MAX_TOKENS = 8192;
/**
 * 텍스트 훅 생성(ai-hook.ts, 10초)보다 넉넉히 잡는다 — 이미지 토큰 처리가 텍스트만 보낼 때보다 오래 걸린다.
 * 그리드는 읽을 것이 24배라 더 걸린다. 라우트의 maxDuration(60초) 안에서 끝나야 하므로 45초로 둔다.
 */
const TIMEOUT_MS = 45_000;

// SDK가 받는 media_type은 이 네 값만의 리터럴 유니온이다. 호출부는 업로드된 파일의 MIME
// 문자열을 그대로 넘기므로, 여기서 하나로 좁혀 SDK 타입과 맞춘다.
type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function toImageMediaType(mediaType: string): ImageMediaType {
  const known: ImageMediaType[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  return (known as string[]).includes(mediaType) ? (mediaType as ImageMediaType) : "image/jpeg";
}

export type VisionConfidence = "high" | "medium" | "low";

/**
 * 좋아요 목록·검색 결과 같은 **그리드 화면**에서 읽은 상품 한 칸 (docs/06 §4.6).
 *
 * 상세 페이지보다 읽히는 것이 적다 — 품번은 아예 안 보이고, 정가도 대개 없다(화면에는
 * "5% 312,550원"처럼 할인율과 지금 가격만 찍힌다). 정가를 312550/0.95로 되계산하지 않는다:
 * 화면에 없는 값을 만들어내지 않는다는 규칙(§4.1)이 여기도 그대로 적용된다.
 */
export interface VisionGridItem {
  brand: string | null;
  productName: string | null;
  /** 화면에 가장 크게 찍힌 지금 가격 — 원 단위 정수 */
  salePrice: number | null;
  /** 가격 앞에 붙은 할인율(%) */
  discountRateShown: number | null;
  soldOut: boolean | null;
}

export interface VisionExtractResult {
  /** 상품 페이지 상단(브랜드·상품명·가격이 보이는 화면)인가 — 아니면 장바구니·옵션 시트·홈 등 */
  isProductPage: boolean;
  /**
   * 그리드 화면(좋아요 목록·검색 결과)에서 읽은 상품들. 상품 상세 화면이면 null이다.
   * null과 빈 배열은 뜻이 다르다 — null은 "그리드가 아님", []는 "그리드인데 한 칸도 못 읽음".
   */
  gridItems: VisionGridItem[] | null;
  brand: string | null;
  productName: string | null;
  /** 품번 — 작은 글씨라 압축된 스크린샷에서는 자주 null이 된다 (docs/06 §4.4) */
  styleCode: string | null;
  /** 정가(취소선·"정가" 표기) — 원 단위 정수 */
  listPrice: number | null;
  /** 판매가·할인가(화면에서 가장 크게 표시된 현재가) — 원 단위 정수 */
  salePrice: number | null;
  /** 쿠폰 적용가·최대혜택가. 로그인 상태 화면값이라 등급할인이 섞여 있을 수 있다 (docs/06 §4.1) */
  couponPrice: number | null;
  /** 화면에 찍힌 할인율(%). 기준가 대비 실할인율과는 다르다 — 그건 price-analysis.ts가 별도로 계산한다 */
  discountRateShown: number | null;
  soldOut: boolean | null;
  confidence: VisionConfidence;
  /** 애매한 점 — 예: "가격이 두 개 보임" */
  notes: string | null;
}

let client: Anthropic | null | undefined;

function getClient(): Anthropic | null {
  if (client !== undefined) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  client = apiKey ? new Anthropic({ apiKey }) : null;
  return client;
}

const SYSTEM_PROMPT = `너는 무신사(Musinsa) 패션 앱 스크린샷을 읽는 추출기다.

읽어야 하는 화면은 두 종류다:
(A) 상품 상세 페이지 상단 — 상품 하나의 브랜드·상품명·가격이 크게 보이는 화면
(B) 상품 목록 그리드 — 좋아요(찜) 목록·검색 결과처럼 작은 카드가 여러 줄로 깔린 화면.
    카드 한 칸에 보통 [사진 / 브랜드 / 상품명 / 할인율+가격 / 좋아요 수·별점]이 들어 있다.

규칙:
- 화면에 실제로 보이는 값만 추출한다. 보이지 않는 가격·이름·재고 상태를 추측하거나 지어내지 마라.
- **정가를 되계산하지 마라.** 그리드에 "5% 312,550원"만 보이면 salePrice=312550, discountRateShown=5이고
  정가는 모르는 것이다. 329000처럼 나눠서 만들어내지 마라.
- 가격은 한국 원화 정수만 쓴다. 쉼표·"원" 접미사·통화 기호를 넣지 마라 (예: 53400, "53,400원" 아님).
- (B) 그리드면 isProductPage를 false로 하고 gridItems 배열을 채운다. 화면에 보이는 칸은 **빠짐없이**
  담되, 잘려서 브랜드나 가격을 못 읽는 맨 아래 줄은 넣지 마라.
- (A) 상세면 gridItems를 null로 두고 나머지 필드를 채운다.
- 둘 다 아니면 — 장바구니·홈 피드·옵션 선택 시트 — isProductPage를 false, gridItems를 null로 하고
  나머지 필드도 전부 null로 둔다.
- 오직 JSON 객체 하나만 응답한다. 마크다운 코드펜스·설명·인사말을 붙이지 마라.`;

/**
 * 폰 화면 하나로 상품명·이미지와 가격이 다 안 담기는 경우, 사용자가 위/아래로 나눠 여러 장을
 * 찍어 한 번에 올릴 수 있다 (docs/06 §4.4). 그럴 땐 모델에게 "따로 판단할
 * 여러 장면"이 아니라 "한 화면을 나눠 찍은 조각들"이라는 것을 명시해야 한다 — 안 그러면
 * 한 장만 보고 답하거나, 장마다 다른 상품으로 오인할 수 있다.
 */
function buildUserPrompt(imageCount: number): string {
  const multiImageNote =
    imageCount > 1
      ? `이 ${imageCount}장은 같은 상품 페이지 하나를 위/아래로 나눠 찍은 스크린샷이다(한 화면에 다 안 담겨서). ` +
        `장마다 다른 상품으로 보지 말고, 전부 종합해서 필드를 채워라 — 예를 들어 한 장엔 브랜드·상품명·이미지만, ` +
        `다른 장엔 가격·쿠폰가만 보일 수 있다.\n\n`
      : "";
  return `${multiImageNote}이 스크린샷에서 아래 필드를 정확히 이 이름으로 채운 JSON 객체 하나만 응답해라. 다른 텍스트는 절대 넣지 마라.

{
  "isProductPage": boolean,
  "gridItems": null | [{ "brand": string|null, "productName": string|null, "salePrice": number|null, "discountRateShown": number|null, "soldOut": boolean|null }],
  "brand": string|null,
  "productName": string|null,
  "styleCode": string|null,
  "listPrice": number|null,
  "salePrice": number|null,
  "couponPrice": number|null,
  "discountRateShown": number|null,
  "soldOut": boolean|null,
  "confidence": "high"|"medium"|"low",
  "notes": string|null
}`;
}

/** JSON 코드펜스로 감싸 응답하는 경우가 있어 방어적으로 벗겨낸다 — 실패해도 원문을 그대로 넘긴다 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : trimmed;
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 화면에 찍힌 원화 가격만 받는다 — 문자열("약 5만원" 등)이나 0/음수는 신뢰하지 않고 null로 떨어뜨린다 */
function toNullablePriceInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

/** 할인율(%) — 0~100 범위를 벗어나면 오독으로 보고 null 처리한다 */
function toNullablePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 100) return null;
  return Math.round(value);
}

function toNullableBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function toConfidence(value: unknown): VisionConfidence {
  return value === "high" || value === "medium" || value === "low" ? value : "low";
}

/**
 * 그리드 배열을 검증한다. 배열이 아니면 null(= 그리드가 아님)이고, 브랜드·상품명이 둘 다 없거나
 * 가격이 없는 칸은 버린다 — 그런 칸은 담아 봤자 "(브랜드 미입력)" 상품만 늘린다.
 * 한 장에 실제로 들어가는 칸 수보다 넉넉한 상한을 둔다: 모델이 같은 상품을 반복해 뱉는 사고를 막는다.
 */
const MAX_GRID_ITEMS = 60;

function toGridItems(value: unknown): VisionGridItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: VisionGridItem[] = [];
  for (const raw of value.slice(0, MAX_GRID_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const brand = toNullableString(obj.brand);
    const productName = toNullableString(obj.productName);
    const salePrice = toNullablePriceInt(obj.salePrice);
    // 이름도 가격도 없는 칸은 기록할 사실이 없다.
    if ((brand === null && productName === null) || salePrice === null) continue;
    items.push({
      brand,
      productName,
      salePrice,
      discountRateShown: toNullablePercent(obj.discountRateShown),
      soldOut: toNullableBool(obj.soldOut),
    });
  }
  return items;
}

/**
 * 모델이 뱉은 raw JSON을 VisionExtractResult로 변환한다.
 * isProductPage가 없거나 boolean이 아니면 응답 자체를 신뢰할 수 없다고 보고 null을 반환한다
 * (요구사항 4: "JSON that's missing the isProductPage field" → null).
 */
function toResult(raw: unknown): VisionExtractResult | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.isProductPage !== "boolean") return null;

  return {
    isProductPage: obj.isProductPage,
    gridItems: toGridItems(obj.gridItems),
    brand: toNullableString(obj.brand),
    productName: toNullableString(obj.productName),
    styleCode: toNullableString(obj.styleCode),
    listPrice: toNullablePriceInt(obj.listPrice),
    salePrice: toNullablePriceInt(obj.salePrice),
    couponPrice: toNullablePriceInt(obj.couponPrice),
    discountRateShown: toNullablePercent(obj.discountRateShown),
    soldOut: toNullableBool(obj.soldOut),
    confidence: toConfidence(obj.confidence),
    notes: toNullableString(obj.notes),
  };
}

/** 다운로드해 메모리에 들고 있는 스크린샷 1장 — 디스크·DB 경유 없이 바로 API로 간다 */
export interface ScreenshotImage {
  data: string; // base64
  mediaType: string;
}

/**
 * 스크린샷 1장(또는 같은 상품 페이지를 나눠 찍은 여러 장)에서 상품 필드를 추출한다.
 * 실패 시(키 없음/타임아웃/API 에러/비-JSON 응답/필수 필드 누락) null을 반환하며,
 * 이는 오류가 아니라 정상적인 폴백 경로다 —
 * 호출부는 null을 "빈 카드 + 직접 입력"으로 처리한다 (docs/06 §3.3).
 *
 * 이미지 원본은 이 함수를 벗어나 저장되지 않는다 — 호출부도 응답을 받은 뒤 base64를 버려야 한다.
 */
export async function extractFromScreenshot(
  images: ScreenshotImage[]
): Promise<VisionExtractResult | null> {
  if (images.length === 0) return null;

  const anthropic = getClient();
  if (!anthropic) {
    console.warn("[vision-extract] ANTHROPIC_API_KEY가 설정되지 않아 추출을 시도하지 않습니다.");
    return null;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const imageBlocks = images.map((img) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: toImageMediaType(img.mediaType),
        data: img.data,
      },
    }));

    const response = await anthropic.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // 추출은 깊은 사고가 필요 없다 (docs/06 §4.1) — effort를 낮춰 응답 속도를 우선한다.
        output_config: { effort: "low" },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            // 이미지 블록들이 텍스트 지시보다 먼저 온다 (Anthropic vision 컨벤션).
            content: [...imageBlocks, { type: "text", text: buildUserPrompt(images.length) }],
          },
        ],
      },
      { signal: controller.signal }
    );
    clearTimeout(timer);

    const block = response.content.find((c) => c.type === "text");
    if (!block || block.type !== "text") {
      console.warn("[vision-extract] 응답에 텍스트 블록이 없습니다.", {
        stopReason: response.stop_reason,
      });
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(block.text));
    } catch {
      // 마크다운 설명이 섞이는 등 비-JSON 응답 — 카드는 빈 값으로 폴백한다.
      // block.text는 모델이 뱉은 텍스트일 뿐 이미지가 아니다 — 원인 진단용으로 로그에 남긴다.
      console.warn("[vision-extract] JSON 파싱 실패 — 응답 원문(앞 300자):", block.text.slice(0, 300));
      return null;
    }

    const result = toResult(parsed);
    if (!result) {
      console.warn("[vision-extract] isProductPage 필드가 없거나 형식이 잘못됨:", parsed);
    }
    return result;
  } catch (err) {
    // 네트워크 오류·타임아웃·레이트리밋·인증 실패 등 — 전부 동일하게 "추출 실패"로 처리하되,
    // 원인 없이 조용히 삼키면 API 키 누락 같은 흔한 설정 오류를 진단할 방법이 없다.
    console.error("[vision-extract] Claude 호출 실패 (네트워크·타임아웃·API 오류):", err);
    return null;
  }
}
