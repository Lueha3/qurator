import { describe, expect, it } from "vitest";
import { DISCLOSURE } from "../disclosure";
import { ALL_CHANNELS, renderAllChannels, renderCard, type DealFacts } from "../renderer";

const baseFacts: DealFacts = {
  brand: "쿠어",
  productName: "오버핏 맨투맨",
  styleCode: "CO-123",
  listPrice: 89000,
  salePrice: 53400,
  discountRate: 40,
  couponCode: "HONEY10",
  couponDesc: "큐레이터 전용 10%",
  finalPrice: 48060,
  endsAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
  hookLine: "이 가격에 S부터 품절각",
  curatorNote: "168/62 M 정사이즈",
  links: [
    { label: "크림", url: "https://www.musinsa.com/products/1?variant=cream" },
    { label: "차콜", url: "https://www.musinsa.com/products/1?variant=charcoal" },
  ],
};

describe("renderCard — 고지 불변식", () => {
  it("모든 채널에서 고지문이 항상 정확히 첫 줄에 온다", () => {
    for (const channel of ALL_CHANNELS) {
      const result = renderCard(channel, baseFacts);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.card.bodyText.startsWith(DISCLOSURE[channel])).toBe(true);
      expect(result.card.disclosureOk).toBe(true);
    }
  });

  it("hookLine이 없어도(AI 장애 상황) 렌더가 성립한다", () => {
    const result = renderCard("THREADS", { ...baseFacts, hookLine: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.disclosureOk).toBe(true);
    expect(result.card.aiGeneratedFields).toEqual([]);
  });

  it("hookSource='ai'일 때만 aiGeneratedFields에 hookLine이 표시된다", () => {
    const aiResult = renderCard("THREADS", { ...baseFacts, hookSource: "ai" });
    expect(aiResult.ok).toBe(true);
    if (aiResult.ok) expect(aiResult.card.aiGeneratedFields).toEqual(["hookLine"]);

    const humanResult = renderCard("THREADS", { ...baseFacts, hookSource: "human" });
    expect(humanResult.ok).toBe(true);
    if (humanResult.ok) expect(humanResult.card.aiGeneratedFields).toEqual([]);
  });

  it("링크가 0개면 NO_LIVE_LINK로 실패한다 (발행되지 않음)", () => {
    const result = renderCard("KAKAO_OPEN", { ...baseFacts, links: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NO_LIVE_LINK");
  });

  it("마감 시각이 지난 딜은 EXPIRED로 실패한다", () => {
    const result = renderCard("THREADS", {
      ...baseFacts,
      endsAt: new Date(Date.now() - 1000),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EXPIRED");
  });
});

describe("renderCard — 채널별 글자수 하드 제약 (docs/02 §4.3)", () => {
  it("스레드는 480자를 넘지 않도록 자동 축약하고 고지문은 보존한다", () => {
    const longFacts: DealFacts = {
      ...baseFacts,
      hookLine:
        "이건 진짜 역대급 딜이라서 지금 안 사면 평생 후회하는 각인데 사이즈 S랑 M이 벌써 빠른 속도로 빠지고 있고 재입고 기약도 없어서 오늘 자정 쿠폰까지 적용하면 이번 시즌 최저가 갱신이니까 무조건 서둘러야 함 진심으로 이건 놓치면 안 되는 딜입니다 정말로 다시는 안 올 것 같은 가격대라서 재고 확인하고 바로 결제하시는 걸 추천드립니다 사이즈 재입고는 기대 안 하시는 게 마음 편해요",
      links: [
        { label: "크림", url: "https://www.musinsa.com/products/1?variant=cream" },
        { label: "차콜", url: "https://www.musinsa.com/products/1?variant=charcoal" },
        { label: "베이지", url: "https://www.musinsa.com/products/1?variant=beige" },
      ],
    };
    const result = renderCard("THREADS", longFacts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.bodyText.length).toBeLessThanOrEqual(480);
    expect(result.card.bodyText.startsWith(DISCLOSURE.THREADS)).toBe(true);
    expect(result.card.truncated).toBe(true);
  });

  it("카톡·노션은 Phase 0에서 길이 제약이 없다 (memo API 미도입)", () => {
    const result = renderCard("KAKAO_OPEN", baseFacts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.truncated).toBe(false);
  });

  it("인스타 고정댓글에 해시태그가 있으면 경고를 남긴다 (금지 규칙, 하드 차단은 아님)", () => {
    const result = renderCard("INSTAGRAM_COMMENT", {
      ...baseFacts,
      hookLine: "이건 #꿀템 각",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.warnings.length).toBeGreaterThan(0);
  });
});

describe("renderCard — 조건부 섹션", () => {
  it("쿠폰이 없으면 쿠폰 블록 전체가 생략된다", () => {
    const result = renderCard("KAKAO_OPEN", {
      ...baseFacts,
      couponCode: null,
      couponDesc: null,
      finalPrice: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.bodyText).not.toContain("쿠폰");
  });

  it("색상 링크가 1개뿐이면 라벨 없이 URL만 노출한다", () => {
    const result = renderCard("KAKAO_OPEN", {
      ...baseFacts,
      links: [{ label: "대표 링크", url: "https://www.musinsa.com/products/1" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.bodyText).toContain("https://www.musinsa.com/products/1");
    expect(result.card.bodyText).not.toContain("대표 링크 →");
  });
});

describe("renderAllChannels", () => {
  it("4개 채널 전부를 렌더링한다", () => {
    const results = renderAllChannels(baseFacts);
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
