// URL 하드 가드 — Fetch Gateway의 불변식을 담은 순수 모듈 (I/O 없음 → 전량 단위 테스트 가능).
//
// docs/03-account-safety.md §5.4의 불변식을 코드로 강제한다:
//   "크롤러·헬스체커는 ULID/utm 파라미터가 포함된 URL을 절대 방문하지 않는다.
//    자기 클릭이 어뷰징 실적으로 잡히는 사고 원천 차단."
//
// 방어는 2중이다:
//   ① canonicalize — 네트워크로 나가기 전에 커미션·추적 파라미터를 **제거**한다(정규 상품 URL만 남긴다).
//   ② assertFetchable — 그럼에도 커미션 마커가 남아 있으면 하드 abort. ①의 버그를 잡는 안전망.

/** 무신사 정규 상품 URL 호스트. 이 목록 밖은 어떤 이유로도 fetch하지 않는다. */
const ALLOWED_HOSTS = new Set([
  "www.musinsa.com",
  "musinsa.com",
  "store.musinsa.com", // 구 상품 URL — canonicalize가 www로 바꾼다
  // 무신사 앱 "공유하기" 버튼이 실제로 만드는 링크(AppsFlyer OneLink, 실측 확인).
  // 상품 데이터는 없고 www.musinsa.com/products/{번호}로 302 리다이렉트만 한다 —
  // 게이트웨이가 그 리다이렉트를 따라가려면 첫 홉으로 이 호스트가 허용돼 있어야 한다.
  "musinsa.onelink.me",
]);

/**
 * 커미션/추적 마커. 이 파라미터가 붙은 URL은 큐레이터 링크일 수 있고,
 * 우리가 방문하는 순간 현표 자신의 실적으로 클릭이 기록될 수 있다.
 */
const COMMISSION_PARAM_PREFIXES = ["utm_", "af_", "af-", "pid", "c_id", "click_id", "gclid", "fbclid"];

export function isCommissionParam(name: string): boolean {
  const lower = name.toLowerCase();
  return COMMISSION_PARAM_PREFIXES.some((p) => lower === p || lower.startsWith(p));
}

/**
 * 커미션/추적 파라미터만 제거한다 (호스트·경로는 건드리지 않는다).
 * canonicalizeMusinsaUrl은 사용자가 처음 던진 URL 1회에만 적용되는데, 리다이렉트 홉(예: 공유
 * 링크가 302로 넘겨주는 실제 상품 URL)에도 AppsFlyer 자체 첨부 파라미터(af_dp, pid 등)가
 * 흔히 붙는다. 이걸 벗기지 않고 assertFetchable에 그대로 넣으면 큐레이터 커미션 링크와
 * 구분이 안 돼 하드 abort된다 — 게이트웨이가 매 홉마다 이 함수로 먼저 씻어낸 뒤 재검증한다.
 */
export function stripTrackingParams(url: URL): URL {
  const cleaned = new URL(url.toString());
  const kept = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (!isCommissionParam(k)) kept.append(k, v);
  }
  cleaned.search = kept.toString();
  return cleaned;
}

export type UrlRejection =
  | { code: "NOT_A_URL"; reason: string }
  | { code: "BAD_PROTOCOL"; reason: string }
  | { code: "HOST_NOT_ALLOWED"; reason: string }
  | { code: "URL_HAS_CREDENTIALS"; reason: string }
  | { code: "COMMISSION_URL"; reason: string };

export type UrlCheck<T> = { ok: true; value: T } | { ok: false; error: UrlRejection };

/**
 * 사용자가 던진 원본 URL을 "네트워크로 내보내도 되는 정규 URL"로 바꾼다.
 * 추적·커미션 파라미터를 전부 제거하고, 구 store.musinsa.com 형식을 현행으로 정규화한다.
 * 커미션 파라미터가 있었다는 사실 자체는 에러가 아니다 — 제거하면 되기 때문.
 */
export function canonicalizeMusinsaUrl(raw: string): UrlCheck<string> {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, error: { code: "NOT_A_URL", reason: "URL 형식이 아닙니다." } };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      error: { code: "BAD_PROTOCOL", reason: `지원하지 않는 프로토콜입니다: ${parsed.protocol}` },
    };
  }
  // user:pass@host 형태는 SSRF·파서 혼동 공격의 고전적 벡터다.
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error: { code: "URL_HAS_CREDENTIALS", reason: "URL에 인증 정보가 포함되어 있습니다." },
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    return {
      ok: false,
      error: {
        code: "HOST_NOT_ALLOWED",
        reason: `무신사 상품 페이지 주소만 받습니다 (받은 호스트: ${host}).`,
      },
    };
  }

  // 구 형식: store.musinsa.com/app/goods/{번호} → www.musinsa.com/products/{번호}
  const legacy = parsed.pathname.match(/^\/app\/goods\/(\d+)/);
  const goodsNo = legacy ? legacy[1] : parsed.pathname.match(/^\/products\/(\d+)/)?.[1];

  // musinsa.com 계열(www/구.store)만 www.musinsa.com으로 합친다. onelink.me는 무신사 도메인이
  // 아니라 AppsFlyer가 운영하는 별도 리다이렉터이므로 호스트를 바꾸면 존재하지 않는 주소가 된다 —
  // 원래 호스트를 그대로 둬야 게이트웨이가 실제로 그 주소를 열어 리다이렉트를 받아낼 수 있다.
  const canonicalHost = host === "musinsa.onelink.me" ? host : "www.musinsa.com";
  const canonical = new URL(`https://${canonicalHost}`);
  if (goodsNo) {
    canonical.pathname = `/products/${goodsNo}`;
  } else {
    // 상품 상세가 아닌 무신사 공개 페이지(기획전 등)도 허용하되 경로는 그대로 두고 파라미터만 턴다.
    canonical.pathname = parsed.pathname;
    for (const [k, v] of parsed.searchParams) {
      if (!isCommissionParam(k)) canonical.searchParams.append(k, v);
    }
  }
  // 프래그먼트는 서버로 전송되지 않지만 로그 위생을 위해 버린다.
  return { ok: true, value: canonical.toString() };
}

/**
 * 최종 안전망: 네트워크 호출 직전에 호출한다. 커미션 파라미터가 하나라도 남아 있으면 하드 abort.
 * canonicalize가 올바르면 여기서 걸릴 일이 없다 — 걸린다면 그것은 우리 쪽 버그이고, 버그가
 * 계정 리스크로 번지기 전에 멈추는 것이 이 함수의 존재 이유다.
 */
export function assertFetchable(url: string): UrlCheck<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: { code: "NOT_A_URL", reason: "URL 형식이 아닙니다." } };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: { code: "BAD_PROTOCOL", reason: "https만 허용합니다." } };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error: { code: "URL_HAS_CREDENTIALS", reason: "URL에 인증 정보가 포함되어 있습니다." },
    };
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    return {
      ok: false,
      error: { code: "HOST_NOT_ALLOWED", reason: `허용되지 않은 호스트: ${parsed.hostname}` },
    };
  }
  for (const [k] of parsed.searchParams) {
    if (isCommissionParam(k)) {
      return {
        ok: false,
        error: {
          code: "COMMISSION_URL",
          reason: `커미션 파라미터가 포함된 URL은 절대 방문하지 않습니다 (${k}).`,
        },
      };
    }
  }
  return { ok: true, value: parsed };
}

// ── SSRF: 사설/특수 IP 대역 차단 ─────────────────────────────────────────
// 호스트 화이트리스트가 1차 방어지만, DNS가 사설 IP를 가리키는 경우(내부망 노출)를 위한 2차 방어.
//
// 손으로 짠 비트마스크 테이블은 구멍이 나기 쉽다(링크로컬 fe80::/10 중 fe80만 잡거나,
// 압축 hex 형태의 IPv4-mapped(::ffff:0a00:0001)를 놓치거나, NAT64·6to4·Teredo가 사설 v4를
// 임베드하는 경우를 놓치는 등). 그래서 화이트리스트 방식으로 뒤집는다:
// ipaddr.js가 'unicast'(= 공인 라우팅 가능)로 분류한 주소만 통과시키고 나머지는 전부 차단한다.

import ipaddr from "ipaddr.js";

/** 이 주소로는 절대 연결하지 않는다. 판정 불가한 형식도 안전하게 true(차단)로 본다. */
export function isBlockedAddress(ip: string): boolean {
  const raw = ip.trim();
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    if (raw.includes(":")) {
      addr = ipaddr.IPv6.parse(raw);
    } else {
      // 레거시 축약 표기("1.2.3" → 1.2.0.3, 8진수/16진수 옥텟 등)는 파서마다 해석이 달라
      // 검증과 실제 연결이 서로 다른 주소를 볼 수 있다. 엄격한 4-part 십진 표기만 허용한다.
      if (!ipaddr.IPv4.isValidFourPartDecimal(raw)) return true;
      addr = ipaddr.IPv4.parse(raw);
    }
  } catch {
    return true; // 파싱 불가 → 차단이 안전
  }

  // IPv4-mapped/변환 계열(::ffff:10.0.0.1, NAT64 등)은 내부의 v4 주소로 재판정한다.
  // 압축 hex 표기(::ffff:0a00:0001)도 여기서 정확히 잡힌다 — 문자열 정규식으로는 놓치는 경로.
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return isBlockedAddress(v6.toIPv4Address().toString());
    }
  }

  // 'unicast' 외의 모든 분류(loopback, private, linkLocal, uniqueLocal, multicast,
  // reserved, carrierGradeNat, 6to4, teredo, rfc6052, broadcast, unspecified…)를 차단한다.
  return addr.range() !== "unicast";
}
