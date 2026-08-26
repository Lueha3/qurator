import { describe, expect, it } from "vitest";
import {
  approvalCard,
  candidateCard,
  CB,
  kakaoDeliveryMessage,
  parseCallbackData,
  type CardDeal,
} from "../cards";
import { assertCallbackDataFits, escapeHtml, html, COPY_TEXT_LIMIT } from "../client";

const DEAL: CardDeal = {
  id: "11111111-2222-3333-4444-555555555555",
  brand: "쿠어",
  productName: "오버핏 맨투맨",
  styleCode: "CO-123",
  listPrice: 89000,
  salePrice: 53400,
  finalPrice: 48060,
  discountRate: 40,
  couponDesc: "큐레이터 전용 10%",
  hookLine: "이 가격에 S부터 품절각",
  parseSource: "json-ld",
  linkCount: 1,
};

describe("callback_data — 64바이트 한도 (텔레그램 하드 제약)", () => {
  it("모든 액션의 callback_data가 한도 안에 들어간다", () => {
    for (const make of [CB.interested, CB.skip, CB.approve, CB.rehook, CB.manual]) {
      const data = make(DEAL.id);
      expect(() => assertCallbackDataFits(data)).not.toThrow();
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    }
  });

  it("한도를 넘기면 명확히 실패한다 (조용히 400 나는 것을 방지)", () => {
    // 한글은 글자당 3바이트 — 22자면 한도를 넘는다
    expect(() => assertCallbackDataFits("한글".repeat(20))).toThrow(/64바이트/);
  });

  it("생성한 callback_data를 다시 파싱할 수 있다 (왕복)", () => {
    const parsed = parseCallbackData(CB.approve(DEAL.id));
    expect(parsed).toEqual({ action: "apv", dealId: DEAL.id });
  });

  it("알 수 없거나 손상된 callback_data는 null을 반환한다", () => {
    for (const bad of ["", "garbage", "v2:apv:x", "v1:xxx:" + DEAL.id, "v1:apv:not-a-uuid"]) {
      expect(parseCallbackData(bad), bad).toBeNull();
    }
  });
});

describe("HTML 이스케이프 (MarkdownV2 대신 HTML을 택한 이유)", () => {
  it("3개 특수문자만 이스케이프한다", () => {
    expect(escapeHtml('<b>&"x"</b>')).toBe("&lt;b&gt;&amp;\"x\"&lt;/b&gt;");
  });

  it("가격·할인 문자열이 이스케이프 없이 그대로 통과한다", () => {
    // MarkdownV2였다면 - ( ) . ! 를 전부 이스케이프해야 했고, 하나만 빠져도 메시지가 통째로 유실된다.
    const price = "89,000원 → 53,400원 (40%) - 오늘까지!";
    expect(escapeHtml(price)).toBe(price);
  });

  it("태그드 템플릿은 보간값만 이스케이프하고 정적 태그는 보존한다", () => {
    const evil = "<script>alert(1)</script>";
    const out = html`<b>${evil}</b>`;
    expect(out).toBe("<b>&lt;script&gt;alert(1)&lt;/script&gt;</b>");
  });
});

describe("카드 렌더링", () => {
  it("후보 카드에 브랜드·가격과 액션 버튼이 담긴다", () => {
    const card = candidateCard(DEAL);
    expect(card.text).toContain("쿠어");
    expect(card.text).toContain("89,000원");
    expect(card.keyboard.flat().some((b) => b.callback_data === CB.interested(DEAL.id))).toBe(true);
  });

  it("파싱 실패 시 직접 입력을 안내한다", () => {
    const card = candidateCard({ ...DEAL, parseSource: "none" });
    expect(card.text).toContain("읽지 못했습니다");
  });

  it("승인 카드는 발행될 내용을 <pre>로 그대로 보여준다 (본 것 = 나가는 것)", () => {
    const preview = "(광고) 아래 링크로 구매 시 수수료를 받습니다\n\n쿠어 · 오버핏 맨투맨";
    const card = approvalCard(DEAL, preview);
    expect(card.text).toContain("<pre>");
    expect(card.text).toContain("(광고) 아래 링크로 구매 시 수수료를 받습니다");
  });
});

describe("카톡 전달 메시지 — copy_text 256자 한도", () => {
  it("짧은 문구에는 copy_text 버튼을 붙인다", () => {
    const short = "짧은 문구";
    const msg = kakaoDeliveryMessage(short, null);
    const copyBtn = msg.keyboard.flat().find((b) => b.copy_text);
    expect(copyBtn?.copy_text?.text).toBe(short);
  });

  it("256자를 넘으면 copy_text 버튼을 붙이지 않는다 (붙이면 메시지 전체가 400 실패)", () => {
    const long = "가".repeat(COPY_TEXT_LIMIT + 1);
    const msg = kakaoDeliveryMessage(long, null);
    expect(msg.keyboard.flat().some((b) => b.copy_text)).toBe(false);
  });

  it("긴 문구에는 웹뷰 링크를 폴백으로 제공한다", () => {
    const long = "가".repeat(500);
    const msg = kakaoDeliveryMessage(long, "https://example.com/copy/abc");
    expect(msg.keyboard.flat().some((b) => b.url === "https://example.com/copy/abc")).toBe(true);
  });

  it("본문은 <pre>로 감싸 줄바꿈이 보존되고 URL이 자동 링크화되지 않는다", () => {
    // 자동 링크화되면 텔레그램이 프리뷰 생성을 위해 큐레이터 링크를 방문할 수 있다.
    const body = "(광고) 문구\n\nhttps://www.musinsa.com/products/1?utm_term=ABC";
    const msg = kakaoDeliveryMessage(body, null);
    expect(msg.text.startsWith("<pre>")).toBe(true);
    expect(msg.text).toContain("utm_term=ABC");
  });
});
