// 큐레이터 링크 파서.
//
// 중요: 이 모듈은 **네트워크를 절대 건드리지 않는다.** 큐레이터 링크는 커미션 링크이고,
// 우리가 방문하는 순간 현표 자신의 클릭이 실적으로 기록될 수 있다(docs/03 §5.4 불변식).
// 그래서 여기서는 문자열만 파싱한다 — 링크 유효성 확인조차 하지 않는다.
//
// 링크 생성은 사람이 큐레이터센터에서 한다(무신사에 링크 생성 API가 없고, 있더라도
// 계정 자동화는 약관 위반이다). 우리는 현표가 붙여넣은 것을 받아 적을 뿐이다.

export interface ParsedCuratorLink {
  /** 붙여넣은 원본 그대로. 발행 시 이 URL을 무변조로 사용한다. */
  rawUrl: string;
  /** utm_term에 담긴 큐레이터 실적 매칭 키 (정산 대조용) */
  ulid: string | null;
  /** 링크가 가리키는 상품 번호 — 딜의 상품과 일치하는지 확인하는 데 쓴다 */
  goodsNo: string | null;
  /** 커미션 파라미터가 실제로 붙어 있는가. 없으면 "큐레이터 링크가 맞는지" 사람에게 확인해야 한다. */
  hasCommissionParams: boolean;
}

export type CuratorLinkResult =
  | { ok: true; link: ParsedCuratorLink }
  | { ok: false; reason: string };

/**
 * 붙여넣은 텍스트에서 큐레이터 링크를 파싱한다.
 * 사람이 링크만 딱 보내지 않고 앞뒤에 말을 붙이는 경우가 흔하므로 텍스트에서 URL을 찾아낸다.
 */
export function parseCuratorLink(text: string): CuratorLinkResult {
  const found = text.match(/https?:\/\/[^\s<>"']+/);
  if (!found) {
    return { ok: false, reason: "메시지에서 링크를 찾지 못했습니다." };
  }

  let url: URL;
  try {
    url = new URL(found[0]);
  } catch {
    return { ok: false, reason: "링크 형식이 올바르지 않습니다." };
  }

  const host = url.hostname.toLowerCase();
  if (!host.endsWith("musinsa.com")) {
    return { ok: false, reason: `무신사 링크가 아닙니다 (${host}).` };
  }

  const ulid = url.searchParams.get("utm_term");
  const goodsNo =
    url.pathname.match(/^\/products\/(\d+)/)?.[1] ??
    url.pathname.match(/^\/app\/goods\/(\d+)/)?.[1] ??
    null;

  const hasCommissionParams =
    url.searchParams.has("utm_term") ||
    url.searchParams.get("utm_source") === "curator" ||
    url.searchParams.has("af_dp");

  return {
    ok: true,
    link: {
      rawUrl: found[0], // 원본 무변조 — 링크 변조 금지 조항 준수 (docs/03 §5.2)
      ulid,
      goodsNo,
      hasCommissionParams,
    },
  };
}
