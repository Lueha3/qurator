import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "../../proxy";

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

  it("쓸 때마다 쿠키 만료 시계를 되감는다 — 잘 쓰는 중에 갑자기 로그아웃되지 않게", () => {
    const res = proxy(request("/deals", { headers: { cookie: `qurator_session=${TOKEN}` } }));
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("qurator_session");
    expect(setCookie).toContain(`Max-Age=${60 * 60 * 24 * 90}`);
    expect(setCookie).toContain("HttpOnly"); // 쿠키 값이 곧 토큰이다 — 스크립트가 못 읽어야 한다
  });

  it("막을 때도 다음에 뭘 해야 하는지 알려준다", async () => {
    const res = proxy(request("/deals"));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Face ID로 열기");
    expect(body).toContain("등록 링크");
    expect(body).toContain("홈 화면");
  });

  it("사람이 주소를 열면(문서 요청) 401 대신 로그인 화면으로 보내고, 원래 가려던 곳을 기억한다", () => {
    const res = proxy(request("/deals?f=saved", { headers: { "sec-fetch-dest": "document" } }));
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("next")).toBe("/deals?f=saved");
  });

  it("RSC·fetch 요청은 리다이렉트하지 않고 401이다", () => {
    expect(proxy(request("/deals", { headers: { rsc: "1", accept: "text/x-component" } })).status).toBe(401);
    expect(proxy(request("/api/deals", { headers: { accept: "application/json" } })).status).toBe(401);
  });

  it("막힌 화면에 토큰이 들어 있지 않다 — 안내가 유출 경로가 되면 안 된다", async () => {
    const body = await proxy(request("/deals")).text();
    expect(body).not.toContain(TOKEN);
  });
});

// 크론 경로 — V2-G. Vercel Cron은 우리 쿠키도 x-app-token도 실을 수 없어서
// Bearer CRON_SECRET을 또 하나의 자격증명으로 받는다. **공개 경로가 아니다**:
// 비밀이 틀리면 일반 게이트로 떨어져 401이어야 한다.
describe("크론 게이트", () => {
  const CRON = "cron-secret-0123456789";
  const originalCron = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = CRON;
  });

  afterEach(() => {
    if (originalCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCron;
  });

  it("Vercel이 붙인 Bearer 비밀은 통과한다", () => {
    const res = proxy(
      request("/api/cron/digest", { headers: { authorization: `Bearer ${CRON}` } })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull(); // 크론에 세션을 주지 않는다
  });

  it("인증 없는 크론 호출은 401 — 누구나 부를 수 있으면 알림이 스팸이 된다", () => {
    expect(proxy(request("/api/cron/digest")).status).toBe(401);
  });

  it("틀린 비밀은 401", () => {
    expect(
      proxy(request("/api/cron/digest", { headers: { authorization: "Bearer wrong-secret-here" } }))
        .status
    ).toBe(401);
  });

  it("CRON_SECRET이 없으면 크론 경로도 열리지 않는다", () => {
    delete process.env.CRON_SECRET;
    expect(
      proxy(request("/api/cron/digest", { headers: { authorization: "Bearer " } })).status
    ).toBe(401);
  });

  it("크론 비밀은 크론 경로에서만 통한다", () => {
    const res = proxy(request("/deals", { headers: { authorization: `Bearer ${CRON}` } }));
    expect(res.status).toBe(401);
  });

  it("앱 토큰으로도 크론 주소를 열 수 있다 (현표가 직접 확인)", () => {
    const res = proxy(request("/api/cron/digest", { headers: { "x-app-token": TOKEN } }));
    expect(res.status).toBe(200);
  });
});

// 로그인 화면(/login)은 게이트 앞이다. 그런데 <head>의 매니페스트·아이콘 링크는 브라우저가
// **어느 페이지에서든** 자동으로 요청한다 — 이 파일들이 게이트 뒤에 있으면 로그인 화면
// 자체가 401 리소스를 참조하게 된다(2026-09-18, 실사용 중 콘솔 에러로 발견).
// matcher 제외는 Next.js가 라우팅 단계에서 적용하므로 proxy() 호출로는 재현되지 않는다 —
// 여기서는 설정 자체가 되돌려지지 않는지를 지킨다.
describe("정적 자산은 게이트를 타지 않는다", () => {
  it("매니페스트·아이콘이 matcher에서 빠져 있다", () => {
    const pattern = config.matcher[0];
    for (const asset of ["apple-icon.png", "icon.png", "manifest.webmanifest"]) {
      expect(pattern).toContain(asset);
    }
  });
});
