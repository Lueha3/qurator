// 스크린샷 Vision 추출 — docs/06-screenshot-capture.md §4.1 정본 구현.
//
// ai-hook.ts와 동일한 그레이스풀 디그레이드 규율을 따른다:
//   1. 실패해도(키 없음/타임아웃/네트워크 오류/비-JSON 응답/필수 필드 누락) 절대 throw하지 않고
//      null을 반환한다 — 호출부(캡처 핸들러)는 null을 "빈 카드 + 직접 입력"으로 처리한다.
//   2. 응답은 `responseMimeType: "application/json"`으로 JSON만 뱉게 강제하되, 정식 스키마
//      바인딩(responseSchema)까지는 쓰지 않고 텍스트 → JSON.parse만 쓴다 — 모델이 스키마 안에서도
//      환각을 낼 수 있으므로 아래 3번 방어 재검증이 항상 최종 방어선이다.
//   3. 모델이 화면에 없는 값을 지어낼 수 있으므로("약 5만원" 같은 문자열이 가격 필드에 들어오는 등)
//      모든 필드를 방어적으로 재검증한다 — 타입이 안 맞으면 그 필드만 null로 떨어뜨리고,
//      절대 caller를 향해 예외를 던지지 않는다.
//
// 이미지는 이 함수 안에서만 잠깐 base64로 들고 있다가 Gemini에 보내고 버린다 — 디스크·DB·로그에
// 쓰지 않는다(docs/06 §4.3). 호출부도 같은 원칙을 지켜야 한다: 응답을 받은 뒤 원본 base64를 저장하지 말 것.
//
// ai-hook.ts(카피라이팅, claude-haiku-4-5)와는 별개 기능이다 — 여기는 Vision 추출만 Gemini로
// 옮긴 것이고, ai-hook.ts는 그대로 Anthropic을 쓴다. ANTHROPIC_API_KEY는 그 용도로 계속 필요하다.

import { GoogleGenAI } from "@google/genai";

// 2026-09 기준 안정 버전. Google이 2026-10-16 이후 gemini-2.5-flash를 단계적으로
// 종료할 예정이라 공지했다 — 그 전에 후속 모델(가용 목록은 Google AI Studio 콘솔에서 확인)로
// 교체해야 한다.
const MODEL = "gemini-2.5-flash";
// 텍스트 훅 생성(ai-hook.ts, 10초)보다 넉넉히 잡는다 — 이미지 토큰 처리가 텍스트만 보낼 때보다 오래 걸린다.
const TIMEOUT_MS = 20_000;

// 텔레그램이 알려주는 MIME 문자열을 그대로 신뢰하지 않고 알려진 이미지 타입으로만 좁힌다.
const KNOWN_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function toImageMediaType(mediaType: string): string {
  return KNOWN_IMAGE_MEDIA_TYPES.includes(mediaType) ? mediaType : "image/jpeg";
}

export type VisionConfidence = "high" | "medium" | "low";

export interface VisionExtractResult {
  /** 상품 페이지 상단(브랜드·상품명·가격이 보이는 화면)인가 — 아니면 장바구니·옵션 시트·홈 등 */
  isProductPage: boolean;
  brand: string | null;
  productName: string | null;
  /** 품번 — 작은 글씨라 텔레그램 압축 사진에서는 자주 null이 된다 (docs/06 §4.4) */
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

let client: GoogleGenAI | null | undefined;

function getClient(): GoogleGenAI | null {
  if (client !== undefined) return client;
  const apiKey = process.env.GEMINI_API_KEY;
  client = apiKey ? new GoogleGenAI({ apiKey }) : null;
  return client;
}

const SYSTEM_PROMPT = `너는 무신사(Musinsa) 패션 앱 상품 페이지 스크린샷을 읽는 추출기다.

규칙:
- 화면에 실제로 보이는 값만 추출한다. 보이지 않는 가격·이름·재고 상태를 추측하거나 지어내지 마라.
- 이 화면이 상품 페이지 상단(브랜드·상품명·가격이 보이는 화면)이 아니면 — 예: 장바구니, 홈 피드,
  옵션 선택 시트 — isProductPage를 false로 하고 다른 필드는 전부 null로 둔다.
- 가격은 한국 원화 정수만 쓴다. 쉼표·"원" 접미사·통화 기호를 넣지 마라 (예: 53400, "53,400원" 아님).
- 오직 JSON 객체 하나만 응답한다. 마크다운 코드펜스·설명·인사말을 붙이지 마라.`;

function buildUserPrompt(): string {
  return `이 스크린샷에서 아래 필드를 정확히 이 이름으로 채운 JSON 객체 하나만 응답해라. 다른 텍스트는 절대 넣지 마라.

{
  "isProductPage": boolean,
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

/**
 * 스크린샷 1장에서 상품 필드를 추출한다. 실패 시(키 없음/타임아웃/API 에러/비-JSON 응답/
 * 필수 필드 누락) null을 반환하며, 이는 오류가 아니라 정상적인 폴백 경로다 —
 * 호출부는 null을 "빈 카드 + 직접 입력"으로 처리한다 (docs/06 §3.3).
 *
 * 이미지 원본은 이 함수를 벗어나 저장되지 않는다 — 호출부도 응답을 받은 뒤 base64를 버려야 한다.
 */
export async function extractFromScreenshot(
  imageBase64: string,
  mediaType: string
): Promise<VisionExtractResult | null> {
  const gemini = getClient();
  if (!gemini) {
    console.warn("[vision-extract] GEMINI_API_KEY가 설정되지 않아 추출을 시도하지 않습니다.");
    return null;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await gemini.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            // 이미지 파트가 텍스트 지시보다 먼저 온다 (기존 구현의 컨벤션을 유지).
            {
              inlineData: { data: imageBase64, mimeType: toImageMediaType(mediaType) },
            },
            { text: buildUserPrompt() },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        abortSignal: controller.signal,
      },
    });
    clearTimeout(timer);

    const text = response.text;
    if (!text) {
      console.warn("[vision-extract] 응답에 텍스트가 없습니다.");
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(text));
    } catch {
      // 마크다운 설명이 섞이는 등 비-JSON 응답 — 카드는 빈 값으로 폴백한다.
      // text는 모델이 뱉은 텍스트일 뿐 이미지가 아니다 — 원인 진단용으로 로그에 남긴다.
      console.warn("[vision-extract] JSON 파싱 실패 — 응답 원문(앞 300자):", text.slice(0, 300));
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
    console.error("[vision-extract] Gemini 호출 실패 (네트워크·타임아웃·API 오류):", err);
    return null;
  }
}
