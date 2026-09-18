// 패스키 실패를 사람이 읽는 한 줄로 — docs/03 §7.1.
//
// 처음엔 실패를 조용히 삼켰다("취소한 경우도 여기로 온다"). 그 결과 버튼을 눌러도 **아무 일도
// 일어나지 않는 화면**이 됐고, 고장인지 취소인지 설정이 틀렸는지 알 길이 없었다.
// 취소를 겁주지 않으려다 정작 필요한 정보를 전부 버린 셈이다.
//
// 그래서 원인별로 말한다. 특히 rpID 불일치(PUBLIC_BASE_URL이 실제 주소와 다름)는
// 이 기능이 실패하는 가장 흔한 이유라 **무엇을 어떻게 고쳐야 하는지까지** 적는다.

interface CodedError {
  code?: string;
  name?: string;
  message?: string;
  cause?: { name?: string; message?: string };
}

export function passkeyErrorMessage(error: unknown, action: "등록" | "로그인"): string {
  const e = (error ?? {}) as CodedError;

  switch (e.code) {
    case "ERROR_CEREMONY_ABORTED":
      return `${action}을 취소했습니다. 다시 누르시면 됩니다.`;

    case "ERROR_INVALID_RP_ID":
      return (
        `앱 주소 설정이 지금 주소와 달라 기기가 거부했습니다. ` +
        `Vercel 환경변수 PUBLIC_BASE_URL을 "${currentOrigin()}"로 맞춰주세요.`
      );

    case "ERROR_INVALID_DOMAIN":
      return "이 주소에서는 패스키를 쓸 수 없습니다(https가 아니거나 유효하지 않은 도메인).";

    case "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED":
      return "이 기기는 이미 등록되어 있습니다. 목록에서 확인해주세요.";

    case "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT":
    case "ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT":
      return "이 기기는 Face ID/Touch ID 패스키를 지원하지 않습니다.";

    case "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY":
      return `${action}하지 못했습니다 (${e.cause?.name ?? "알 수 없는 오류"}). 다시 시도해주세요.`;
  }

  // SimpleWebAuthn이 알려진 코드로 못 묶은 순수 NotAllowedError. 취소일 수도 있지만,
  // 인앱 브라우저(카톡 등)가 Face ID 접근 자체를 거부한 경우도 똑같이 이 이름으로 온다 —
  // 화면에서 detectInAppBrowser()로 먼저 걸러지지 않았다면(모르는 앱이라서) 여기서 짚어준다.
  if (e.name === "NotAllowedError" && !e.code) {
    return (
      `${action}이 거부됐습니다. 카카오톡·인스타그램처럼 앱 안에서 뜨는 브라우저라면 ` +
      `Face ID를 쓸 수 없습니다 — 더보기(⋯) 메뉴에서 "Safari로 열기"를 선택해 다시 시도해주세요. ` +
      `직접 취소하셨다면 무시하셔도 됩니다.`
    );
  }

  // 라이브러리를 거치지 않은 오류(네트워크 등)도 이름만은 보여준다 —
  // "아무 일도 안 일어남"보다 무엇이든 단서가 있는 편이 낫다.
  const label = e.code ?? e.name ?? "알 수 없는 오류";
  return `${action}하지 못했습니다 (${label}).`;
}

/** 서버가 기대하는 도메인과 지금 보고 있는 주소가 다르면, 브라우저가 창을 띄우기도 전에 거부한다. */
export function rpIdMismatch(options: unknown): string | null {
  if (typeof window === "undefined") return null;
  const rpID = (options as { rp?: { id?: string } })?.rp?.id;
  if (!rpID || rpID === window.location.hostname) return null;

  return (
    `서버 설정(PUBLIC_BASE_URL)은 "${rpID}"인데 지금 주소는 "${window.location.hostname}"입니다. ` +
    `Vercel 환경변수를 "${currentOrigin()}"로 맞춰주세요.`
  );
}

function currentOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}
