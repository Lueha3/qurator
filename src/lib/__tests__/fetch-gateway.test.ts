import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 실사용에서 발견된 회귀: 무신사 앱 "공유하기" 버튼이 만드는 링크(musinsa.onelink.me,
// AppsFlyer OneLink)는 상품 데이터가 없고 www.musinsa.com으로 302 리다이렉트만 한다.
// 게이트웨이가 리다이렉트를 따라가는 건 원래도 됐지만(홉마다 가드 재실행), 리다이렉트가
// 넘겨주는 실제 상품 URL에 AppsFlyer가 붙인 af_dp·pid 같은 파라미터가 남아 있으면
// 큐레이터 커미션 링크와 구분이 안 돼 assertFetchable이 하드 abort했다 — 정상적인
// 공유 링크 흐름 자체가 항상 실패하는 결과였다. 이 테스트는 매 홉마다 트래킹 파라미터를
// 씻어낸 뒤 재검증하는 수정이 실제로 동작하는지 검증한다.
//
// 페이싱(최소 요청 간격)은 이 테스트의 관심사가 아니다 — 실제로는 5~10초를 기다려야 하고
// (robots.txt 조회도 "네트워크로 나간 요청"으로 세므로, 새 호스트를 처음 건드릴 때마다
// robots 조회 직후의 실제 요청이 그 지연을 그대로 맞는다. 의도된 동작이다), 리다이렉트
// 검증 로직과는 무관한 대기이므로 policy를 모킹해 0으로 고정한다.

vi.mock("../policy", () => ({
  getLimits: vi.fn(async () => ({
    dailyMax: 600,
    hourlyMax: 60,
    minIntervalMs: 0,
    jitterMaxMs: 0,
    maxBytes: 3_000_000,
    timeoutMs: 12_000,
    maxRedirects: 3,
  })),
  isKillSwitchOn: vi.fn(async () => false),
}));

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
}));

const fetchMock = vi.fn();

async function resetGatewayState() {
  const { db } = await import("../db");
  await db.fetchLog.deleteMany();
  await db.circuitState.deleteMany();
}

describe("Fetch Gateway — 공유 링크 리다이렉트", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    await resetGatewayState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("onelink.me 리다이렉트를 따라가고, 대상 URL의 트래킹 파라미터는 벗겨서 재검증한다", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname === "/robots.txt") {
        return new Response("", { status: 404 });
      }
      if (url.hostname === "musinsa.onelink.me") {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://www.musinsa.com/products/1234567?af_dp=musinsa%3A%2F%2F&pid=onelink",
          },
        });
      }
      if (url.hostname === "www.musinsa.com") {
        // 트래킹 파라미터가 안 벗겨졌다면 여기 도달하기 전에 COMMISSION_URL로 abort됐을 것이다.
        return new Response("<html>ok</html>", { status: 200 });
      }
      throw new Error(`예상치 못한 fetch 호출: ${String(input)}`);
    });

    const { gatewayFetch } = await import("../fetch-gateway");
    const result = await gatewayFetch({
      url: "https://musinsa.onelink.me/PvkC/mq1u9fu0",
      trigger: "USER_URL",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.finalUrl).toBe("https://www.musinsa.com/products/1234567");
    expect(result.body).toContain("ok");
  });

  it("리다이렉트 대상이 무신사 외 호스트면 여전히 차단한다 (onelink.me 허용이 우회로가 되지 않는다)", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      if (url.hostname === "musinsa.onelink.me") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.com/phish" },
        });
      }
      throw new Error(`예상치 못한 fetch 호출: ${String(input)}`);
    });

    const { gatewayFetch } = await import("../fetch-gateway");
    const result = await gatewayFetch({
      url: "https://musinsa.onelink.me/PvkC/mq1u9fu0",
      trigger: "USER_URL",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("BLOCKED_POLICY");
  });
});
