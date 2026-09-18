import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, setSessionCookie } from "@/lib/session";

// 웹 표면 접근 통제 — docs/03-account-safety.md §5.4. (Next.js 16: middleware → proxy)
//
// 대시보드·API·서버 액션은 카드 본문(bodyText)을 서빙하고, 그 안에는 큐레이터 링크가 원본 그대로
// 들어 있다(utm_term ULID 포함). 인증 없이 열어두면 커미션 키가 인터넷에 공개되어, 우리가
// 게이트웨이에서 그토록 막은 "제3자가 현표 실적으로 클릭을 쌓는" 사고가 훨씬 큰 규모로 일어난다.
// 서버 액션은 페이지 경로로 POST되므로 같은 게이트 뒤에 있다.

/**
 * 쿠키 대신 토큰을 직접 싣는 헤더. 아이폰 단축어처럼 **쿠키를 들고 다닐 수 없는 클라이언트**가
 * `/api/capture`에 바로 올리기 위한 경로다 (docs/06 §4.5).
 *
 * `?k=`를 쓰지 않는 이유: 그 경로는 쿠키를 심고 리다이렉트하는데, 업로드 POST를 리다이렉트에
 * 태우면 본문이 어떻게 되는지가 클라이언트 구현에 달린다. 헤더는 한 번에 끝난다.
 * 덤으로 토큰이 주소·리퍼러·서버 로그의 URL에 남지 않고, 크로스사이트 폼은 커스텀 헤더를
 * 붙일 수 없어 CSRF 표면도 쿠키보다 좁다.
 */
const TOKEN_HEADER = "x-app-token";

// 공개 경로. 팔로워가 클릭하는 지면만 여기 들어간다:
//   /l/       — 숏링크 리다이렉트. 팔로워가 클릭하는 지면이라 공개여야 한다
//   /expired/ — 죽은 링크 안내(비커미션)
//   /hub      — 링크허브. 프로필 링크로 공개되는 것이 존재 이유다
// 이 경로들은 전부 noindex를 달아 검색봇이 커미션 링크를 따라가지 못하게 한다.
const PUBLIC_PREFIXES = ["/l/", "/expired/", "/hub"];

/**
 * 정확히 일치할 때만 여는 경로. 패스키 로그인은 **로그인하기 전에** 닿아야 하므로 열려 있다.
 * 여기서 나가는 것은 챌린지(무작위 문자열)와 성공 여부뿐이고, 통과 조건은 기기 안 개인키의
 * 서명이라 열려 있어도 열쇠가 되지 않는다. prefix가 아니라 완전 일치인 이유는
 * `/login`으로 시작하는 다른 경로까지 딸려 열리는 것을 막기 위해서다.
 */
const PUBLIC_PATHS = new Set(["/login", "/api/auth/passkey/login"]);

export function proxy(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  const isPublic =
    PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
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

  // Vercel Cron은 우리 쿠키도 x-app-token도 실을 수 없다 — 대신 Vercel이 크론 요청에
  // `Authorization: Bearer <CRON_SECRET>`을 붙여준다. 그래서 크론 경로에 한해 그 헤더를
  // 또 하나의 자격증명으로 인정한다. 경로를 공개(PUBLIC_PREFIXES)로 여는 것과는 다르다 —
  // 토큰 없이는 여전히 못 들어온다. 못 맞추면 아래 일반 게이트로 떨어진다(현표가 앱에서
  // 직접 열어볼 수 있게). 라우트 자신도 같은 검사를 한 번 더 한다.
  if (pathname.startsWith("/api/cron/")) {
    const cronSecret = process.env.CRON_SECRET;
    const auth = req.headers.get("authorization");
    if (cronSecret && auth && safeEqual(auth, `Bearer ${cronSecret}`)) {
      return withNoIndex(NextResponse.next());
    }
  }

  // 헤더로 온 토큰은 리다이렉트도 쿠키도 없이 그 요청 하나만 통과시킨다.
  const viaHeader = req.headers.get(TOKEN_HEADER);
  if (viaHeader && safeEqual(viaHeader, expected)) {
    return withNoIndex(NextResponse.next());
  }

  // ?k=<토큰>으로 한 번 들어오면 쿠키를 심어 이후 요청은 그냥 통과시킨다(북마크 편의).
  const viaQuery = searchParams.get("k");
  if (viaQuery && safeEqual(viaQuery, expected)) {
    const url = req.nextUrl.clone();
    url.searchParams.delete("k"); // 토큰이 주소창·리퍼러에 남지 않게 즉시 제거
    const res = NextResponse.redirect(url);
    setSessionCookie(res, expected, isHttps(req));
    return withNoIndex(res);
  }

  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  if (cookie && safeEqual(cookie, expected)) {
    // 쓸 때마다 만료 시계를 되감는다(슬라이딩 만료). 고정 만료였을 때는 잘 쓰고 있는데도
    // 어느 날 갑자기 "unauthorized" 흰 화면을 만나게 된다 — 로그인이 필요한 순간이
    // 하필 급할 때 온다는 뜻이다. 계속 쓰는 한 다시 로그인할 일이 없어야 한다.
    const res = NextResponse.next();
    setSessionCookie(res, expected, isHttps(req));
    return withNoIndex(res);
  }

  return withNoIndex(unauthorizedPage());
}

function isHttps(req: NextRequest): boolean {
  return req.nextUrl.protocol === "https:";
}

/**
 * 막을 때도 **다음에 뭘 해야 하는지는 알려준다.** 예전에는 흰 화면에 "unauthorized" 한 줄이라,
 * 막혔다는 것만 알 뿐 되돌아갈 길이 안 보였다.
 *
 * 토큰은 여기 적지 않는다(적으면 이 페이지가 곧 토큰 유출 경로가 된다). 어디서 찾는지만 말한다.
 */
function unauthorizedPage(): NextResponse {
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>로그인이 필요합니다</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100dvh; display:flex; align-items:center; justify-content:center;
    padding:24px; background:#faf9f7; color:#1a1714;
    font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",Pretendard,"Noto Sans KR",sans-serif; }
  main { max-width:30rem; }
  h1 { font-size:1.125rem; margin:0 0 .75rem; }
  p, li { font-size:.875rem; line-height:1.7; color:#6d6355; margin:0 0 .75rem; }
  ol { padding-left:1.25rem; margin:0; }
  b { color:#1a1714; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; background:#f0ece5;
    padding:.1em .35em; border-radius:.25em; color:#1a1714; }
  .cta { display:block; text-align:center; text-decoration:none; background:#9a5a00; color:#fff;
    font-weight:600; padding:.75rem 1rem; border-radius:.75rem; margin:0 0 1rem; }
  @media (prefers-color-scheme: dark) {
    body { background:#16130f; color:#efe9df; }
    p, li { color:#a99e8d; } b { color:#efe9df; }
    code { background:#2a251e; color:#efe9df; }
    .cta { background:#f2ae3f; color:#231a0b; }
  }
</style></head>
<body><main>
  <h1>🔒 로그인이 필요합니다</h1>
  <p>이 주소는 커미션 링크가 들어 있는 작업 화면이라 아무나 열 수 없습니다.</p>
  <p><a class="cta" href="/login">🔓 Face ID로 열기</a></p>
  <ol>
    <li>위 버튼이 안 되면 <b>홈 화면에 추가한 앱 아이콘</b>으로 열어보세요.</li>
    <li>그래도 이 화면이면 <code>?k=</code> 주소로 <b>한 번만</b> 열면 됩니다. 그 뒤로는
      주소만 쳐도 들어와집니다(90일, 쓸 때마다 갱신).</li>
  </ol>
  <p><b>Safari에서 방금 이 화면을 보셨다면</b> 그게 정상입니다 — 아이폰은 홈 화면 앱과 Safari가
    로그인을 따로 기억합니다. 두 곳에서 다 쓰시려면 각각 한 번씩 <code>?k=</code>로 열어주세요.</p>
</main></body></html>`;
  return new NextResponse(html, {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
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
