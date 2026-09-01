import { describe, expect, it } from "vitest";
import {
  assertFetchable,
  canonicalizeMusinsaUrl,
  isBlockedAddress,
  isCommissionParam,
  stripTrackingParams,
} from "../url-guard";

// 이 파일의 테스트는 docs/03-account-safety.md의 불변식을 코드로 고정한다.
// 여기가 깨지면 현표의 큐레이터 자격이 위험해진다 — 실패 시 절대 테스트를 수정해서 통과시키지 말 것.

describe("불변식: 커미션 URL은 절대 fetch되지 않는다 (docs/03 §5.4)", () => {
  const curatorLink =
    "https://www.musinsa.com/products/1234567?utm_source=curator&utm_term=01HZX8QK9M&af_dp=musinsa%3A%2F%2F";

  it("큐레이터 링크를 정규화하면 커미션 파라미터가 전부 제거된다", () => {
    const result = canonicalizeMusinsaUrl(curatorLink);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("https://www.musinsa.com/products/1234567");
    expect(result.value).not.toContain("utm_");
    expect(result.value).not.toContain("af_dp");
  });

  it("정규화 결과는 항상 assertFetchable을 통과한다", () => {
    const result = canonicalizeMusinsaUrl(curatorLink);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(assertFetchable(result.value).ok).toBe(true);
  });

  it("커미션 파라미터가 남은 URL은 assertFetchable이 하드 abort한다 (정규화 버그 안전망)", () => {
    for (const bad of [
      "https://www.musinsa.com/products/1?utm_term=01HZX8QK9M",
      "https://www.musinsa.com/products/1?utm_source=curator",
      "https://www.musinsa.com/products/1?af_dp=x",
      "https://www.musinsa.com/products/1?gclid=x",
      "https://www.musinsa.com/products/1?fbclid=x",
    ]) {
      const result = assertFetchable(bad);
      expect(result.ok, `${bad} 가 차단되지 않았습니다`).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("COMMISSION_URL");
    }
  });

  it("커미션 파라미터 판정은 대소문자를 가리지 않는다", () => {
    expect(isCommissionParam("UTM_Term")).toBe(true);
    expect(isCommissionParam("utm_source")).toBe(true);
    expect(isCommissionParam("af_dp")).toBe(true);
    expect(isCommissionParam("size")).toBe(false);
  });
});

describe("불변식: 허용된 호스트 외에는 나가지 않는다", () => {
  it("무신사가 아닌 호스트를 거부한다", () => {
    for (const bad of [
      "https://evil.example.com/products/1",
      "https://www.musinsa.com.evil.example/products/1",
      "https://localhost/products/1",
      "https://169.254.169.254/latest/meta-data/", // 클라우드 메타데이터
    ]) {
      const result = canonicalizeMusinsaUrl(bad);
      expect(result.ok, `${bad} 가 차단되지 않았습니다`).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("HOST_NOT_ALLOWED");
    }
  });

  it("URL에 인증 정보가 있으면 거부한다", () => {
    const result = canonicalizeMusinsaUrl("https://user:pass@www.musinsa.com/products/1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("URL_HAS_CREDENTIALS");
  });

  it("assertFetchable은 https만 허용한다", () => {
    const result = assertFetchable("http://www.musinsa.com/products/1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("BAD_PROTOCOL");
  });

  it("URL이 아닌 문자열을 거부한다", () => {
    for (const bad of ["그냥 텍스트", "", "javascript:alert(1)"]) {
      expect(canonicalizeMusinsaUrl(bad).ok, `${bad}`).toBe(false);
    }
  });
});

describe("정규화: 구 URL 형식과 모바일 공유 링크", () => {
  it("구 store.musinsa.com/app/goods/{번호}를 현행 형식으로 바꾼다", () => {
    const result = canonicalizeMusinsaUrl("https://store.musinsa.com/app/goods/1234567?foo=bar");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("https://www.musinsa.com/products/1234567");
  });

  it("http로 들어와도 https 정규 URL로 승격한다", () => {
    const result = canonicalizeMusinsaUrl("http://www.musinsa.com/products/1234567");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.startsWith("https://")).toBe(true);
  });

  it("상품 상세가 아닌 공개 페이지는 경로를 보존하되 추적 파라미터만 턴다", () => {
    const result = canonicalizeMusinsaUrl(
      "https://www.musinsa.com/campaign/sale?utm_source=curator&tab=outer"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain("/campaign/sale");
    expect(result.value).toContain("tab=outer");
    expect(result.value).not.toContain("utm_source");
  });

  // 실측 회귀: 무신사 앱 "공유하기" 버튼이 실제로 만드는 링크는 www.musinsa.com이 아니라
  // musinsa.onelink.me(AppsFlyer OneLink)였다 — 이걸 허용하지 않으면 "모바일 공유시트"라는
  // 1급 입력 경로 자체가 실사용에서 100% 거부된다.
  it("무신사 앱 공유 링크(musinsa.onelink.me)를 허용하고 호스트를 그대로 보존한다", () => {
    const result = canonicalizeMusinsaUrl("https://musinsa.onelink.me/PvkC/mq1u9fu0");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // musinsa.com 계열과 달리 onelink.me는 www.musinsa.com으로 합쳐지면 안 된다 —
    // 실존하지 않는 www.musinsa.com/PvkC/... 가 되어 리다이렉트를 아예 받을 수 없게 된다.
    expect(new URL(result.value).hostname).toBe("musinsa.onelink.me");
    expect(result.value).toBe("https://musinsa.onelink.me/PvkC/mq1u9fu0");
  });

  it("onelink.me를 사칭하는 호스트는 여전히 거부한다", () => {
    for (const bad of [
      "https://musinsa.onelink.me.evil.example/PvkC/x",
      "https://evil-onelink.me/PvkC/x",
    ]) {
      const result = canonicalizeMusinsaUrl(bad);
      expect(result.ok, `${bad} 가 차단되지 않았습니다`).toBe(false);
    }
  });
});

describe("stripTrackingParams — 리다이렉트 홉마다 재사용하는 세척기", () => {
  it("커미션·추적 파라미터를 제거하고 일반 파라미터는 남긴다", () => {
    const result = stripTrackingParams(
      new URL("https://www.musinsa.com/products/1?af_dp=musinsa%3A%2F%2F&pid=onelink&size=M")
    );
    expect(result.toString()).toBe("https://www.musinsa.com/products/1?size=M");
  });

  it("파라미터가 전부 커미션 마커면 물음표까지 깨끗이 사라진다", () => {
    const result = stripTrackingParams(new URL("https://www.musinsa.com/products/1?af_dp=x&pid=y"));
    expect(result.toString()).toBe("https://www.musinsa.com/products/1");
  });

  it("호스트·경로는 건드리지 않는다", () => {
    const result = stripTrackingParams(new URL("https://musinsa.onelink.me/PvkC/mq1u9fu0?utm_source=app"));
    expect(result.hostname).toBe("musinsa.onelink.me");
    expect(result.pathname).toBe("/PvkC/mq1u9fu0");
  });
});

describe("불변식: SSRF — 사설·특수 IP 대역 차단", () => {
  it("사설·루프백·링크로컬 주소를 차단한다", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // AWS/GCP 메타데이터 엔드포인트
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:10.0.0.1", // IPv4-mapped 사설 주소
    ]) {
      expect(isBlockedAddress(ip), `${ip} 가 차단되지 않았습니다`).toBe(true);
    }
  });

  it("공인 주소는 통과시킨다", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "104.18.0.1", "2606:4700::1"]) {
      expect(isBlockedAddress(ip), `${ip} 가 잘못 차단되었습니다`).toBe(false);
    }
  });

  // 아래는 손으로 짠 비트마스크 구현에서 실제로 뚫렸던 경로들이다 (리서치 지적 반영).
  it("링크로컬 fe80::/10 전체를 차단한다 (fe80 접두사만 보면 뚫린다)", () => {
    for (const ip of ["fe80::1", "fe90::1", "fea0::1", "feb0::1", "febf::1"]) {
      expect(isBlockedAddress(ip), `${ip} 가 차단되지 않았습니다`).toBe(true);
    }
  });

  it("압축 hex 표기의 IPv4-mapped 사설 주소를 차단한다", () => {
    // ::ffff:0a00:0001 == ::ffff:10.0.0.1 — 점 표기 정규식으로는 놓치는 형태
    expect(isBlockedAddress("::ffff:0a00:0001")).toBe(true);
    expect(isBlockedAddress("::ffff:7f00:0001")).toBe(true); // 127.0.0.1
    expect(isBlockedAddress("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254 메타데이터
  });

  it("전환 계열(6to4·Teredo·NAT64)과 문서용 대역을 차단한다", () => {
    for (const ip of [
      "2002::1", // 6to4
      "2001::1", // Teredo
      "64:ff9b::1", // NAT64
      "192.0.2.1", // TEST-NET-1
      "198.51.100.1", // TEST-NET-2
      "203.0.113.1", // TEST-NET-3
      "255.255.255.255", // broadcast
    ]) {
      expect(isBlockedAddress(ip), `${ip} 가 차단되지 않았습니다`).toBe(true);
    }
  });

  it("파싱할 수 없는 주소는 차단 쪽으로 판정한다", () => {
    for (const ip of ["", "999.1.1.1", "not-an-ip", "1.2.3"]) {
      expect(isBlockedAddress(ip), `${ip}`).toBe(true);
    }
  });
});
