import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ai-hook과 마찬가지로 lazy singleton(getClient)이 모듈 로드 시점이 아니라 첫 호출 시점에
// ANTHROPIC_API_KEY를 읽으므로, 각 테스트가 process.env를 직접 조작해 그 분기를 검증할 수 있다.
const create = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  // 화살표 함수는 절대 생성자가 될 수 없다(JS 사양) — vision-extract.ts가 `new Anthropic(...)`로
  // 부르는 순간 "is not a constructor"로 깨진다. 일반 함수 표현식이어야 new가 통과한다.
  default: vi.fn().mockImplementation(function () {
    return { messages: { create } };
  }),
}));

const { extractFromScreenshot } = await import("../vision-extract");
import type { VisionExtractResult, VisionFailure } from "../vision-extract";

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

function textResponse(text: string) {
  return { content: [{ type: "text", text }] };
}

/** 짧게 쓰기 위한 헬퍼 — extractFromScreenshot은 이미지 "배열"을 받는다(여러 장 병합 지원). */
function img(data: string, mediaType = "image/jpeg") {
  return { data, mediaType };
}

/** 성공을 단언하며 타입을 좁힌다 — 실패하면 이유를 그대로 보여줘 진단이 빨라진다. */
function succeeds(result: VisionExtractResult | VisionFailure): VisionExtractResult {
  if ("failed" in result) throw new Error(`추출이 실패했다: ${result.reason}`);
  return result;
}

describe("extractFromScreenshot", () => {
  beforeEach(() => {
    create.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  });

  it("필드가 전부 채워진 유효한 JSON 응답을 VisionExtractResult로 그대로 옮긴다", async () => {
    create.mockResolvedValueOnce(
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

    const result = await extractFromScreenshot([img("base64data")]);

    expect(result).toEqual({
      isProductPage: true,
      // 상세 페이지 응답에는 그리드가 없다 — null과 []는 뜻이 다르다(docs/06 §4.6)
      gridItems: null,
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

    // 이미지 블록이 텍스트 지시보다 먼저 온다 (Anthropic vision 컨벤션, docs/06 §4.1 요구사항 5)
    const call = create.mock.calls[0][0];
    expect(call.model).toBe("claude-sonnet-5");
    expect(call.thinking).toEqual({ type: "disabled" });
    const content = call.messages[0].content;
    expect(content[0].type).toBe("image");
    expect(content[0].source).toEqual({
      type: "base64",
      media_type: "image/jpeg",
      data: "base64data",
    });
    expect(content[1].type).toBe("text");
  });

  it("이미지 여러 장을 보내면 전부 이미지 블록으로 담고, 프롬프트에 '나눠 찍은 것'이라고 명시한다", async () => {
    create.mockResolvedValueOnce(textResponse(JSON.stringify({ isProductPage: true })));

    await extractFromScreenshot([img("top-half", "image/jpeg"), img("bottom-half", "image/png")]);

    const call = create.mock.calls[0][0];
    const content = call.messages[0].content;
    // 이미지 블록 2개 + 텍스트 블록 1개 — 이미지가 전부 텍스트보다 먼저 온다
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "top-half" },
    });
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "bottom-half" },
    });
    expect(content[2].type).toBe("text");
    expect(content[2].text).toContain("2장");
    expect(content[2].text).toContain("나눠 찍은");
  });

  it("이미지가 1장이면 '나눠 찍은' 안내 문구를 넣지 않는다", async () => {
    create.mockResolvedValueOnce(textResponse(JSON.stringify({ isProductPage: true })));

    await extractFromScreenshot([img("base64data")]);

    const content = create.mock.calls[0][0].messages[0].content;
    expect(content[1].text).not.toContain("나눠 찍은");
  });

  it("이미지 배열이 비어 있으면 API를 부르지 않고 즉시 실패를 반환한다", async () => {
    const result = await extractFromScreenshot([]);
    expect(result).toEqual({ failed: true, reason: "no-images" });
    expect(create).not.toHaveBeenCalled();
  });

  it("코드펜스로 감싼 JSON도 벗겨서 파싱한다", async () => {
    create.mockResolvedValueOnce(
      textResponse("```json\n" + JSON.stringify({ isProductPage: false }) + "\n```")
    );

    const result = succeeds(await extractFromScreenshot([img("base64data", "image/png")]));
    expect(result.isProductPage).toBe(false);
    expect(result.confidence).toBe("low"); // 값이 없으면 방어적으로 low로 떨어진다
  });

  it("가격 필드에 숫자가 아닌 값(환각)이 오면 그 필드만 null로 떨어진다", async () => {
    create.mockResolvedValueOnce(
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

    const result = succeeds(await extractFromScreenshot([img("base64data")]));
    expect(result.listPrice).toBeNull();
    expect(result.salePrice).toBeNull();
    expect(result.discountRateShown).toBeNull();
    expect(result.confidence).toBe("low");
  });

  it("비-JSON/깨진 응답은 예외 없이 bad-response로 떨어진다", async () => {
    create.mockResolvedValueOnce(textResponse("죄송하지만 이 이미지를 분석할 수 없습니다."));

    const result = await extractFromScreenshot([img("base64data")]);
    expect(result).toEqual({ failed: true, reason: "bad-response" });
  });

  it("isProductPage 필드가 없는 응답은 bad-response로 떨어진다", async () => {
    create.mockResolvedValueOnce(
      textResponse(JSON.stringify({ brand: "쿠어", productName: "오버셔츠" }))
    );

    const result = await extractFromScreenshot([img("base64data")]);
    expect(result).toEqual({ failed: true, reason: "bad-response" });
  });

  it("API 호출이 예외를 던져도 throw하지 않고 api-error로 떨어진다", async () => {
    create.mockRejectedValueOnce(new Error("network error"));

    const result = await extractFromScreenshot([img("base64data")]);
    expect(result).toEqual({ failed: true, reason: "api-error" });
  });

  // 이 구분이 이 변경의 핵심이다 — 화면에서 "서버에 AI 설정이 없어요"와
  // "사진을 못 읽었어요"를 가르는 유일한 근거다.
  it("max_tokens에 걸려 잘리면 bad-response가 아니라 truncated로 구분한다", async () => {
    create.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"isProductPage":true,"brand":"쿠' }],
      stop_reason: "max_tokens",
      usage: { output_tokens: 16000 },
    });

    const result = await extractFromScreenshot([img("base64data")]);
    expect(result).toEqual({ failed: true, reason: "truncated" });
  });

  it("ANTHROPIC_API_KEY가 없으면 클라이언트를 만들지도, API를 호출하지도 않고 즉시 null을 반환한다", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    // getClient()는 lazy singleton이라 모듈 내부 캐시가 이전 테스트의 "키 있음" 상태를 들고 있을 수
    // 있다 — 이 테스트만을 위해 모듈을 새로 불러와 캐시가 비어있는 상태에서 검증한다.
    vi.resetModules();
    const fresh = await import("../vision-extract");

    const result = await fresh.extractFromScreenshot([img("base64data")]);

    expect(result).toEqual({ failed: true, reason: "no-api-key" });
    expect(create).not.toHaveBeenCalled();
  });
});
