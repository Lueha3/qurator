import { describe, expect, it } from "vitest";
import { firstCheckAt, judgeAvailability, nextCheckInterval } from "../health-check";
import { classifyUserAgent, usesShortLink } from "../shortlink";

function pageWithOffers(offers: unknown, extra = "") {
  return `<html><head><script type="application/ld+json">
  ${JSON.stringify({ "@type": "Product", name: "맨투맨", brand: { name: "쿠어" }, offers })}
  </script></head><body>${extra}${"본문 ".repeat(2000)}</body></html>`;
}

function productPage(availability: string | null, extra = "") {
  return pageWithOffers(
    availability
      ? { "@type": "Offer", price: "53400", availability }
      : { "@type": "Offer", price: "53400" },
    extra
  );
}

describe("헬스 판정 — 의심스러우면 유지한다", () => {
  it("InStock을 살아있음으로 판정한다", () => {
    expect(judgeAvailability(200, productPage("https://schema.org/InStock")).kind).toBe("ok");
  });

  it("전 옵션 OutOfStock을 품절로 판정한다", () => {
    expect(judgeAvailability(200, productPage("https://schema.org/OutOfStock")).kind).toBe(
      "soldout"
    );
  });

  it("파싱이 안 되면 상태를 바꾸지 않고 동결한다 (파서가 깨져도 살아있는 링크를 죽이지 않는다)", () => {
    expect(judgeAvailability(200, "<html><body>알 수 없는 페이지</body></html>").kind).toBe(
      "frozen"
    );
  });

  it("가격은 읽혔지만 재고 표기가 없으면 판단하지 않는다", () => {
    expect(judgeAvailability(200, productPage(null)).kind).toBe("frozen");
  });
});

// 리뷰가 잡아낸 결함의 회귀 테스트.
// 예전 구현은 HTML 전문에서 "outofstock" 부분문자열을 찾아, 사이즈 하나 품절인
// 잘 팔리는 상품이 18시간 만에 DEAD로 확정되고 허브에서 사라졌다.
describe("회귀: 옵션 일부 품절은 품절이 아니다", () => {
  it("사이즈 하나만 품절이면 살아있음으로 판정한다", () => {
    const html = pageWithOffers([
      { "@type": "Offer", price: "53400", availability: "https://schema.org/OutOfStock" },
      { "@type": "Offer", price: "53400", availability: "https://schema.org/InStock" },
      { "@type": "Offer", price: "53400", availability: "https://schema.org/InStock" },
    ]);
    const verdict = judgeAvailability(200, html);
    expect(verdict.kind).toBe("ok");
    if (verdict.kind === "ok") expect(verdict.detail).toContain("3개 옵션 중 2개");
  });

  it("전 옵션이 품절일 때만 품절로 확정한다", () => {
    const html = pageWithOffers([
      { "@type": "Offer", price: "53400", availability: "https://schema.org/OutOfStock" },
      { "@type": "Offer", price: "53400", availability: "https://schema.org/OutOfStock" },
    ]);
    const verdict = judgeAvailability(200, html);
    expect(verdict.kind).toBe("soldout");
    if (verdict.kind === "soldout") expect(verdict.detail).toContain("2개 옵션 전부");
  });

  it("본문 다른 곳(추천상품 등)의 품절 표기에 영향받지 않는다", () => {
    const html = pageWithOffers(
      { "@type": "Offer", price: "53400", availability: "https://schema.org/InStock" },
      // 연관상품 블록이 함께 실린 상황 — 문자열 스캔이었다면 여기서 품절로 판정됐다
      `<div data-related='{"availability":"https://schema.org/OutOfStock"}'>추천상품</div>`
    );
    expect(judgeAvailability(200, html).kind).toBe("ok");
  });

  it("AggregateOffer만 있으면 재고를 알 수 없으므로 동결한다", () => {
    const html = pageWithOffers({
      "@type": "AggregateOffer",
      lowPrice: "39000",
      highPrice: "59000",
    });
    expect(judgeAvailability(200, html).kind).toBe("frozen");
  });
});

describe("HTTP 상태 기반 판정", () => {
  it("404·410은 상품이 사라진 것으로 본다", () => {
    expect(judgeAvailability(404, "").kind).toBe("gone");
    expect(judgeAvailability(410, "").kind).toBe("gone");
  });

  it("그 외 오류 상태는 판정하지 않는다 (일시 장애로 링크를 죽이지 않는다)", () => {
    expect(judgeAvailability(500, "").kind).toBe("frozen");
    expect(judgeAvailability(503, "").kind).toBe("frozen");
  });
});

describe("점검 주기 티어", () => {
  const now = new Date("2026-03-01T00:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * 24 * 3_600_000);

  it("발행 직후는 촘촘히, 오래될수록 뜸하게 본다", () => {
    expect(nextCheckInterval(ago(1), now)).toBe(6 * 3_600_000);
    expect(nextCheckInterval(ago(7), now)).toBe(12 * 3_600_000);
    expect(nextCheckInterval(ago(20), now)).toBe(24 * 3_600_000);
  });

  it("30일이 지나면 점검을 종료한다 (무한히 무신사를 두드리지 않는다)", () => {
    expect(nextCheckInterval(ago(40), now)).toBeNull();
  });
});

describe("첫 점검 시각 — 발행 시각과 동기화되지 않는다", () => {
  it("항상 1~6시간 뒤로 잡힌다", () => {
    const base = new Date("2026-03-01T00:00:00Z");
    for (let i = 0; i < 50; i++) {
      const at = firstCheckAt(base).getTime() - base.getTime();
      expect(at).toBeGreaterThanOrEqual(1 * 3_600_000);
      expect(at).toBeLessThanOrEqual(6 * 3_600_000);
    }
  });

  it("호출마다 값이 달라진다 (고정 오프셋이면 지문이 그대로 남는다)", () => {
    const base = new Date("2026-03-01T00:00:00Z");
    const samples = new Set(Array.from({ length: 20 }, () => firstCheckAt(base).getTime()));
    expect(samples.size).toBeGreaterThan(1);
  });
});

describe("숏링크 모드 — safe가 기본값", () => {
  it("safe 모드에서는 자기 소유 지면만 숏링크를 쓴다", () => {
    expect(usesShortLink("safe", "hub")).toBe(true);
    expect(usesShortLink("safe", "notion")).toBe(true);
    // 무신사 서면 확인 전에는 카톡·스레드에 미확인 리다이렉트를 뿌리지 않는다
    expect(usesShortLink("safe", "kakao_open")).toBe(false);
    expect(usesShortLink("safe", "threads")).toBe(false);
  });

  it("full 모드에서는 전 채널이 숏링크를 쓴다", () => {
    expect(usesShortLink("full", "kakao_open")).toBe(true);
    expect(usesShortLink("full", "threads")).toBe(true);
  });
});

describe("봇 판정 — 봇 클릭을 성과로 세지 않는다", () => {
  it("알려진 봇 UA를 걸러낸다", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "facebookexternalhit/1.1",
      "curl/8.4.0",
      "python-requests/2.31.0",
      "Mozilla/5.0 ... HeadlessChrome/120",
    ]) {
      expect(classifyUserAgent(ua), ua).toBe("bot");
    }
  });

  it("빈 UA·너무 짧은 UA도 봇으로 본다", () => {
    expect(classifyUserAgent(null)).toBe("bot");
    expect(classifyUserAgent("x")).toBe("bot");
  });

  it("실제 모바일 브라우저는 사람으로 판정한다", () => {
    expect(
      classifyUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      )
    ).toBe("human");
  });
});
