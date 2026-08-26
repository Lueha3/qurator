import { NextRequest, NextResponse } from "next/server";

// 웹 표면 접근 통제 — docs/03-account-safety.md §5.4.
//
// 대시보드와 API는 카드 본문(bodyText)을 서빙하고, 그 안에는 큐레이터 링크가 원본 그대로 들어 있다
// (utm_term ULID 포함). 인증 없이 열어두면 커미션 키가 인터넷에 공개되어, 우리가 게이트웨이에서
// 그토록 막은 "제3자가 현표 실적으로 클릭을 쌓는" 사고가 훨씬 큰 규모로 일어난다.
//
// 예외는 /copy/* 하나뿐이다. 텔레그램 버튼으로 열려 세션 쿠키가 없으므로,
// 그 경로는 URL에 실린 HMAC 서명 토큰으로 스스로를 방어한다(src/lib/signed-link.ts).

const COOKIE_NAME = "qurator_session";
const PUBLIC_PREFIXES = ["/copy/", "/api/telegram/"];

export function middleware(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  const isPublic = PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
  if (isPublic) return withNoIndex(NextResponse.next());

  const expected = process.env.APP_ACCESS_TOKEN;
  if (!expected) {
    // 미설정 시 전면 거부(fail closed). 설정을 깜빡한 채 배포해 전부 공개되는 것이
    // 이 미들웨어가 막으려는 바로 그 사고다.
    return withNoIndex(
      new NextResponse(
        "APP_ACCESS_TOKEN이 설정되지 않아 접근이 차단되었습니다. .env를 확인하세요.",
        { status: 503 }
      )
    );
  }

  // ?k=<토큰>으로 한 번 들어오면 쿠키를 심어 이후 요청은 그냥 통과시킨다(북마크 편의).
  const viaQuery = searchParams.get("k");
  if (viaQuery && safeEqual(viaQuery, expected)) {
    const url = req.nextUrl.clone();
    url.searchParams.delete("k"); // 토큰이 주소창·리퍼러에 남지 않게 즉시 제거
    const res = NextResponse.redirect(url);
    res.cookies.set(COOKIE_NAME, expected, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return withNoIndex(res);
  }

  const cookie = req.cookies.get(COOKIE_NAME)?.value;
  if (cookie && safeEqual(cookie, expected)) {
    return withNoIndex(NextResponse.next());
  }

  return withNoIndex(new NextResponse("unauthorized", { status: 401 }));
}

/** 길이가 달라도 조기 반환하지 않도록 상수시간에 가깝게 비교한다. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 어떤 응답도 색인되지 않게 한다 — 커미션 링크가 검색 결과에 남는 것을 막는 마지막 방어선. */
function withNoIndex(res: NextResponse): NextResponse {
  res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return res;
}

export const config = {
  // 정적 자산과 Next 내부 경로는 제외
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
