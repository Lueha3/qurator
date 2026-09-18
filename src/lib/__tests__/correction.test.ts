import { describe, expect, it } from "vitest";
import { correctionText } from "../correction";

// 팔로워가 읽는 글이다 — 사유를 잘못 말하면 거짓 공지가 된다 (docs/08 §4.0.7).

describe("품절 안내문", () => {
  it("품절은 품절이라고 말한다", () => {
    const text = correctionText("쿠어", "오버셔츠", "SOLDOUT");
    expect(text).toContain("[품절 안내]");
    expect(text).toContain("쿠어 오버셔츠");
    expect(text).toContain("품절되었습니다");
  });

  it("쿠폰만 끝났으면 품절이라고 하지 않는다 — 상품은 아직 팔린다", () => {
    const text = correctionText("쿠어", "오버셔츠", "COUPON_EXPIRED");
    expect(text).toContain("[쿠폰 종료 안내]");
    expect(text).toContain("쿠폰이 끝났습니다");
    expect(text).not.toContain("품절");
  });

  it("상품 페이지가 내려간 경우는 아는 것만 말한다(품절인지 모른다)", () => {
    const text = correctionText("쿠어", "오버셔츠", "DEAD");
    expect(text).toContain("[판매 종료 안내]");
    expect(text).toContain("내려갔습니다");
    expect(text).not.toContain("품절");
  });

  it("사유를 주지 않으면 품절로 본다 — 사람이 [품절로 표시하기]를 누른 경우", () => {
    expect(correctionText("쿠어", "오버셔츠")).toContain("[품절 안내]");
  });
});
