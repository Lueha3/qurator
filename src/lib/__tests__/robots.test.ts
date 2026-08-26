import { describe, expect, it } from "vitest";
import { decideByOutcome, isAllowed, parseRobots, productToken } from "../robots";

const UA = "HoneyFlowBot/1.0 (+https://honeyflow.tools/bot)";

describe("robots.txt 파싱과 판정", () => {
  it("Disallow된 경로를 막고 그 외는 허용한다", () => {
    const rules = parseRobots(`
User-agent: *
Disallow: /admin/
Disallow: /api/
`);
    expect(isAllowed(rules, UA, "/admin/users")).toBe(false);
    expect(isAllowed(rules, UA, "/api/v1")).toBe(false);
    expect(isAllowed(rules, UA, "/products/123")).toBe(true);
  });

  it("규칙이 없으면 전체 허용", () => {
    expect(isAllowed(parseRobots(""), UA, "/products/1")).toBe(true);
  });

  it("빈 Disallow는 전체 허용을 뜻한다", () => {
    const rules = parseRobots(`
User-agent: *
Disallow:
`);
    expect(isAllowed(rules, UA, "/anything")).toBe(true);
  });

  it("Allow가 더 구체적이면 Disallow를 이긴다", () => {
    const rules = parseRobots(`
User-agent: *
Disallow: /products/
Allow: /products/public/
`);
    expect(isAllowed(rules, UA, "/products/123")).toBe(false);
    expect(isAllowed(rules, UA, "/products/public/123")).toBe(true);
  });

  it("같은 길이면 Allow가 이긴다 (RFC 9309)", () => {
    const rules = parseRobots(`
User-agent: *
Disallow: /x
Allow: /x
`);
    expect(isAllowed(rules, UA, "/x/y")).toBe(true);
  });

  it("구체적인 User-agent 그룹이 '*'보다 우선한다", () => {
    const rules = parseRobots(`
User-agent: *
Disallow: /

User-agent: honeyflowbot
Allow: /products/
Disallow: /admin/
`);
    expect(isAllowed(rules, UA, "/products/1")).toBe(true);
    expect(isAllowed(rules, UA, "/admin/x")).toBe(false);
    // 다른 봇에게는 '*' 그룹이 적용되어 전면 차단
    expect(isAllowed(rules, "SomeOtherBot/2.0", "/products/1")).toBe(false);
  });

  it("와일드카드와 종료 앵커를 처리한다", () => {
    const rules = parseRobots(`
User-agent: *
Disallow: /*.json$
Disallow: /search?*
`);
    expect(isAllowed(rules, UA, "/data/file.json")).toBe(false);
    expect(isAllowed(rules, UA, "/data/file.json.html")).toBe(true); // 앵커 때문에 미매치
    expect(isAllowed(rules, UA, "/search?q=1")).toBe(false);
    expect(isAllowed(rules, UA, "/products/1")).toBe(true);
  });

  it("주석과 대소문자 혼용 필드명을 처리한다", () => {
    const rules = parseRobots(`
# 주석
USER-AGENT: *
DISALLOW: /admin/   # 관리자
`);
    expect(isAllowed(rules, UA, "/admin/x")).toBe(false);
  });

  it("연속된 User-agent 줄은 같은 규칙 그룹을 공유한다", () => {
    const rules = parseRobots(`
User-agent: botA
User-agent: botB
Disallow: /blocked/
`);
    expect(isAllowed(rules, "botA/1.0", "/blocked/x")).toBe(false);
    expect(isAllowed(rules, "botB/1.0", "/blocked/x")).toBe(false);
  });
});

describe("RFC 9309 준수: 놓치기 쉬운 지점들", () => {
  it("경로 매칭에 쿼리스트링을 포함한다 (pathname만 넘기면 규칙을 놓친다)", () => {
    const rules = parseRobots(`
User-agent: *
Disallow: /*?
`);
    // 쿼리가 있는 경로는 차단되어야 한다
    expect(isAllowed(rules, UA, "/products/1?color=red")).toBe(false);
    // 쿼리가 없으면 허용
    expect(isAllowed(rules, UA, "/products/1")).toBe(true);
  });

  it("UA 그룹 매칭은 접두사 기준이다 (includes()면 짧은 토큰에 잘못 편입된다)", () => {
    const rules = parseRobots(`
User-agent: bot
Disallow: /

User-agent: *
Allow: /
`);
    // 'honeyflowbot'은 'bot'으로 시작하지 않으므로 'bot' 그룹에 속하지 않는다.
    // includes() 구현이었다면 여기서 전면 차단되어 제품이 동작하지 않았을 것이다.
    expect(isAllowed(rules, UA, "/products/1")).toBe(true);
    // 진짜 'bot'으로 시작하는 UA는 그 그룹에 속한다
    expect(isAllowed(rules, "bot/1.0", "/products/1")).toBe(false);
  });

  it("제품 토큰을 UA 문자열에서 정확히 뽑는다", () => {
    expect(productToken("HoneyFlowBot/1.0 (+https://x/bot)")).toBe("honeyflowbot");
    expect(productToken("SomeBot")).toBe("somebot");
  });

  it("robots.txt 조회 실패(5xx)는 전면 금지, 부재(4xx)는 전면 허용", () => {
    // 이것이 RFC 9309 §2.3.1의 규칙이며 직관과 반대다 —
    // "못 가져왔으니 그냥 진행"이 표준 위반이다.
    expect(decideByOutcome({ kind: "unavailable" }, UA, "/products/1")).toBe(false);
    expect(decideByOutcome({ kind: "absent" }, UA, "/products/1")).toBe(true);

    const rules = parseRobots("User-agent: *\nDisallow: /admin/");
    expect(decideByOutcome({ kind: "parsed", rules }, UA, "/admin/x")).toBe(false);
    expect(decideByOutcome({ kind: "parsed", rules }, UA, "/products/1")).toBe(true);
  });
});
