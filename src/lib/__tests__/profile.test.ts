import { describe, expect, it } from "vitest";
import { validateCuratorShopUrl } from "../profile";

// 이 값은 공개 허브에 링크로 실린다. 검증이 뚫리면 팔로워가 누르는 링크가 오염된다.

describe("큐레이션 샵 주소 검증", () => {
  it("무신사 https 주소를 통과시킨다", () => {
    const result = validateCuratorShopUrl("https://www.musinsa.com/curator/s/jenflox");
    expect(result).toEqual({ ok: true, value: "https://www.musinsa.com/curator/s/jenflox" });
  });

  it("비우면 '미설정'으로 저장한다", () => {
    expect(validateCuratorShopUrl("   ")).toEqual({ ok: true, value: null });
  });

  it("javascript: 스킴을 막는다", () => {
    expect(validateCuratorShopUrl("javascript:alert(1)").ok).toBe(false);
  });

  it("http는 막는다 — 공개 지면의 링크는 https만", () => {
    expect(validateCuratorShopUrl("http://www.musinsa.com/curator/s/x").ok).toBe(false);
  });

  it("무신사가 아닌 도메인을 막는다", () => {
    expect(validateCuratorShopUrl("https://evil.example.com/musinsa.com").ok).toBe(false);
    // 도메인 끝이 musinsa.com인 척하는 주소도 막힌다
    expect(validateCuratorShopUrl("https://musinsa.com.evil.example").ok).toBe(false);
  });

  it("서브도메인은 허용한다", () => {
    expect(validateCuratorShopUrl("https://store.musinsa.com/app").ok).toBe(true);
  });

  it("주소 형식이 아니면 막는다", () => {
    expect(validateCuratorShopUrl("무신사 샵 주소").ok).toBe(false);
  });
});
