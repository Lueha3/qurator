import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../../proxy";

// 웹 표면 전체의 자물쇠다. 여기가 뚫리면 커미션 링크가 통째로 공개된다 —
// 그래서 "열리는 경우"보다 **"열리지 않아야 하는 경우"**를 더 많이 본다.

const TOKEN = "test-token-0123456789";
const original = process.env.APP_ACCESS_TOKEN;

function request(path: string, init?: { headers?: Record<string, string>; method?: string }) {
  return new NextRequest(`https://qurator.example.com${path}`, {
    method: init?.method ?? "GET",
    headers: init?.headers,
  });
}

beforeEach(() => {
  process.env.APP_ACCESS_TOKEN = TOKEN;
});

afterEach(() => {
  if (original === undefined) delete process.env.APP_ACCESS_TOKEN;
  else process.env.APP_ACCESS_TOKEN = original;
});

describe("접근 게이트", () => {
  it("토큰이 없으면 통째로 막는다 (fail closed)", () => {
    delete process.env.APP_ACCESS_TOKEN;
    expect(proxy(request("/")).status).toBe(503);
  });

  it("인증 없는 요청은 401", () => {
    expect(proxy(request("/deals")).status).toBe(401);
  });

  it("팔로워가 클릭하는 지면은 공개다", () => {
    for (const path of ["/hub", "/l/abc1234", "/expired/abc1234"]) {
      expect(proxy(request(path)).status).toBe(200);
    }
  });

  it("어떤 응답에도 noindex가 붙는다 — 커미션 링크가 색인되면 안 된다", () => {
    expect(proxy(request("/deals")).headers.get("X-Robots-Tag")).toContain("noindex");
    expect(proxy(request("/hub")).headers.get("X-Robots-Tag")).toContain("noindex");
  });

  it("x-app-token 헤더로 온 업로드는 리다이렉트 없이 통과한다 (아이폰 단축어 경로)", () => {
    const res = proxy(
      request("/api/capture", { method: "POST", headers: { "x-app-token": TOKEN } })
    );
    expect(res.status).toBe(200); // NextResponse.next() — 라우트로 넘어간다
    // 쿠키를 심지 않는다: 그 요청 하나만 통과시킨다
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("틀린 헤더 토큰은 401", () => {
    const res = proxy(
      request("/api/capture", { method: "POST", headers: { "x-app-token": "wrong-token-value" } })
    );
    expect(res.status).toBe(401);
  });

  it("길이가 같고 값만 다른 토큰도 막는다", () => {
    const sameLength = "x".repeat(TOKEN.length);
    expect(proxy(request("/", { headers: { "x-app-token": sameLength } })).status).toBe(401);
  });

  it("?k= 는 쿠키를 심고 토큰을 주소에서 지운다", () => {
    const res = proxy(request(`/?k=${TOKEN}`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).not.toContain("k=");
    expect(res.headers.get("set-cookie")).toContain("qurator_session");
  });

  it("쿠키가 있으면 통과한다", () => {
    const res = proxy(request("/deals", { headers: { cookie: `qurator_session=${TOKEN}` } }));
    expect(res.status).toBe(200);
  });
});
