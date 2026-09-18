import type { NextResponse } from "next/server";

// 세션 쿠키 한 벌. proxy.ts(게이트)와 패스키 로그인 라우트가 **같은 정의**를 쓴다 —
// 두 벌이면 한쪽만 고쳐지는 날이 오고, 그 날 보안 속성 하나가 조용히 빠진다.
//
// Edge 런타임(proxy)에서도 import되므로 여기에 node·DB 의존을 들이지 않는다.

export const SESSION_COOKIE = "qurator_session";

/** 쿠키 수명. 슬라이딩이라 이 값은 "마지막으로 앱을 연 뒤" 방치할 수 있는 시간이다. */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 90;

export function setSessionCookie(res: NextResponse, token: string, secure: boolean): void {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, // 스크립트가 못 읽는다 — 쿠키 값이 곧 토큰이라 이게 중요하다
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}
