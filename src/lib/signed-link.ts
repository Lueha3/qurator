// 복사 웹뷰 링크 서명 — docs/03-account-safety.md §5.4·§4.1.
//
// 왜 서명이 필요한가:
// 카드 본문(bodyText)에는 큐레이터 링크가 **원본 무변조로** 들어 있고(§5.2 링크 변조 금지),
// 거기엔 현표의 커미션 실적 키인 utm_term ULID가 살아 있다. 이 URL이 인터넷에 그냥 열려 있으면
// 검색봇·스크래퍼가 현표 실적으로 클릭을 쌓고, 무신사 로그에는 "데이터센터 IP에서 동일 ULID로
// 들어오는 비정상 클릭"만 남는다 → 어뷰징 판정. 게이트웨이를 아무리 잠가도 링크를 공개하면 무의미하다.
//
// 복사 웹뷰는 텔레그램 버튼으로 열리므로 세션 쿠키를 쓸 수 없다. 그래서 URL 자체에
// HMAC 서명 + 만료를 실어 "봇이 발급한 링크"만 열리게 한다.

import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 24 * 3_600_000;

function secret(): string {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "APP_SECRET이 없거나 너무 짧습니다(16자 이상). 복사 링크 서명에 필요합니다 — .env를 확인하세요."
    );
  }
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** cardId를 서명된 토큰으로 만든다. 형식: {cardId}.{만료ms}.{서명} */
export function signCardToken(cardId: string, ttlMs = DEFAULT_TTL_MS): string {
  const expiresAt = Date.now() + ttlMs;
  const payload = `${cardId}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

export type TokenCheck =
  | { ok: true; cardId: string }
  | { ok: false; reason: "malformed" | "expired" | "bad_signature" };

export function verifyCardToken(token: string): TokenCheck {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [cardId, expiresRaw, provided] = parts;

  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: "malformed" };

  const expected = sign(`${cardId}.${expiresRaw}`);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // 서명 검증을 만료 검사보다 먼저 한다 — 위조 토큰에 대해 만료 여부를 알려주지 않기 위해.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  if (Date.now() > expiresAt) return { ok: false, reason: "expired" };

  return { ok: true, cardId };
}
