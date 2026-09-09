import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ai-hook과 마찬가지로 lazy singleton(getClient)이 모듈 로드 시점이 아니라 첫 호출 시점에
// GEMINI_API_KEY를 읽으므로, 각 테스트가 process.env를 직접 조작해 그 분기를 검증할 수 있다.
const generateContent = vi.fn();

vi.mock("@google/genai", () => ({
  // 화살표 함수는 절대 생성자가 될 수 없다(JS 사양) — vision-extract.ts가 `new GoogleGenAI(...)`로
  // 부르는 순간 "is not a constructor"로 깨진다. 일반 함수 표현식이어야 new가 통과한다.
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return { models: { generateContent } };
  }),
}));

const { extractFromScreenshot } = await import("../vision-extract");

const ORIGINAL_KEY = process.env.GEMINI_API_KEY;

function textResponse(text: string) {
  return { text };
}

describe("extractFromScreenshot", () => {
  beforeEach(() => {
    generateContent.mockReset();
    process.env.GEMINI_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env.GEMINI_API_KEY = ORIGINAL_KEY;
  });

  it("필드가 전부 채워진 유효한 JSON 응답을 VisionExtractResult로 그대로 옮긴다", async () => {
    generateContent.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          isProductPage: true,
          brand: "쿠어",
          productName: "스탠다드 오버셔츠",
          styleCode: "COAT-001",
          listPrice: 89000,
          salePrice: 53400,
          couponPrice: 45000,
          discountRateShown: 40,
          soldOut: false,
          confidence: "high",
          notes: null,
        })
      )
    );

    const result = await extractFromScreenshot("base64data", "image/jpeg");

    expect(result).toEqual({
      isProductPage: true,
      brand: "쿠어",
      productName: "스탠다드 오버셔츠",
      styleCode: "COAT-001",
      listPrice: 89000,
      salePrice: 53400,
      couponPrice: 45000,
      discountRateShown: 40,
      soldOut: false,
      confidence: "high",
      notes: null,
    });

    // 이미지 파트가 텍스트 지시보다 먼저 온다 (기존 구현의 컨벤션을 유지)
    const call = generateContent.mock.calls[0][0];
    expect(call.model).toBe("gemini-2.5-flash");
    expect(call.config.responseMimeType).toBe("application/json");
    const parts = call.contents[0].parts;
    expect(parts[0].inlineData).toEqual({ data: "base64data", mimeType: "image/jpeg" });
    expect(typeof parts[1].text).toBe("string");
  });

  it("코드펜스로 감싼 JSON도 벗겨서 파싱한다", async () => {
    generateContent.mockResolvedValueOnce(
      textResponse("```json\n" + JSON.stringify({ isProductPage: false }) + "\n```")
    );

    const result = await extractFromScreenshot("base64data", "image/png");
    expect(result?.isProductPage).toBe(false);
    expect(result?.confidence).toBe("low"); // 값이 없으면 방어적으로 low로 떨어진다
  });

  it("가격 필드에 숫자가 아닌 값(환각)이 오면 그 필드만 null로 떨어진다", async () => {
    generateContent.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          isProductPage: true,
          brand: "쿠어",
          productName: "오버셔츠",
          listPrice: "약 5만원", // 환각 — 숫자가 아니다
          salePrice: -100, // 음수 — 무효
          discountRateShown: 200, // 범위 밖 — 무효
          confidence: "unknown", // 셋 중 하나가 아님 — low로 폴백
        })
      )
    );

    const result = await extractFromScreenshot("base64data", "image/jpeg");
    expect(result).not.toBeNull();
    expect(result?.listPrice).toBeNull();
    expect(result?.salePrice).toBeNull();
    expect(result?.discountRateShown).toBeNull();
    expect(result?.confidence).toBe("low");
  });

  it("비-JSON/깨진 응답은 예외 없이 null을 반환한다", async () => {
    generateContent.mockResolvedValueOnce(textResponse("죄송하지만 이 이미지를 분석할 수 없습니다."));

    const result = await extractFromScreenshot("base64data", "image/jpeg");
    expect(result).toBeNull();
  });

  it("isProductPage 필드가 없는 응답은 null을 반환한다", async () => {
    generateContent.mockResolvedValueOnce(
      textResponse(JSON.stringify({ brand: "쿠어", productName: "오버셔츠" }))
    );

    const result = await extractFromScreenshot("base64data", "image/jpeg");
    expect(result).toBeNull();
  });

  it("응답에 텍스트가 없으면(undefined) null을 반환한다", async () => {
    generateContent.mockResolvedValueOnce({ text: undefined });

    const result = await extractFromScreenshot("base64data", "image/jpeg");
    expect(result).toBeNull();
  });

  it("API 호출이 예외를 던져도(네트워크/타임아웃) null로 처리하며 throw하지 않는다", async () => {
    generateContent.mockRejectedValueOnce(new Error("network error"));

    const result = await extractFromScreenshot("base64data", "image/jpeg");
    expect(result).toBeNull();
  });

  it("GEMINI_API_KEY가 없으면 클라이언트를 만들지도, API를 호출하지도 않고 즉시 null을 반환한다", async () => {
    delete process.env.GEMINI_API_KEY;
    // getClient()는 lazy singleton이라 모듈 내부 캐시가 이전 테스트의 "키 있음" 상태를 들고 있을 수
    // 있다 — 이 테스트만을 위해 모듈을 새로 불러와 캐시가 비어있는 상태에서 검증한다.
    vi.resetModules();
    const fresh = await import("../vision-extract");

    const result = await fresh.extractFromScreenshot("base64data", "image/jpeg");

    expect(result).toBeNull();
    expect(generateContent).not.toHaveBeenCalled();
  });
});
