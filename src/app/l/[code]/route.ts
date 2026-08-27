import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { classifyUserAgent } from "@/lib/shortlink";

// 숏링크 리다이렉트. 이 파일이 docs/03-account-safety.md 불변식 I-5의 집행 지점이다.
//
// 절대 규칙: **자동 302의 최종 목적지는 큐레이터 링크 원본, 오직 그것뿐이다.**
// 링크가 죽었을 때 '비슷한 다른 상품'으로 자동으로 보내고 싶은 유혹이 크지만, 그 순간
// 무신사 로그에는 "사용자가 A를 클릭했는데 B의 커미션 실적이 찍혔다"만 남는다 —
// 링크 스왑/트래픽 전용 패턴과 로그상 구분되지 않고, 큐레이터 자격 상실 직행 경로다.
// 죽은 링크는 반드시 비커미션 안내 페이지에 착지시키고, 대안은 사람이 눌러야 이동한다.

export const dynamic = "force-dynamic";

/**
 * 프리페치·프리렌더 요청인가.
 *
 * 이 가드가 없으면 링크가 실린 페이지를 **여는 것만으로** 뷰포트 안의 모든 숏링크가 실행된다:
 * 브라우저·프레임워크가 미리 당겨오면서 클릭이 기록되고 커미션 URL로 302가 나간다.
 * 그러면 숏링크의 존재 이유인 클릭 계측이 통째로 오염되고, 현표가 자기 허브를 확인만 해도
 * 자기 링크에 클릭이 쌓인다 — 게이트웨이에서 그토록 막은 자기 클릭이 프론트로 우회해 들어오는 셈이다.
 *
 * 1차 방어는 페이지 쪽에서 <a>를 쓰는 것이고(next/link의 자동 프리페치를 피한다),
 * 이 헤더 가드는 프레임워크가 바뀌어도 남는 2차 방어다.
 */
function isPrefetch(req: NextRequest): boolean {
  const h = req.headers;
  // Next.js App Router의 프리페치 마커
  if (h.get("next-router-prefetch") === "1") return true;
  if (h.get("rsc") === "1") return true;
  // 표준 (Chrome/Safari의 speculation rules, <link rel=prefetch/prerender>)
  const purpose = `${h.get("sec-purpose") ?? ""} ${h.get("purpose") ?? ""} ${h.get("x-purpose") ?? ""}`.toLowerCase();
  return purpose.includes("prefetch") || purpose.includes("prerender");
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;

  // 사람이 실제로 누른 것이 아니면 아무 일도 하지 않는다 — 클릭도 기록하지 않고 302도 내보내지 않는다.
  if (isPrefetch(req)) {
    return new NextResponse(null, {
      status: 204,
      headers: { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" },
    });
  }

  const link = await db.shortLink.findUnique({ where: { code } });
  if (!link) {
    return NextResponse.redirect(new URL("/expired/unknown", req.nextUrl.origin), 302);
  }

  const uaClass = classifyUserAgent(req.headers.get("user-agent"));

  // 클릭 기록. IP는 저장하지 않는다(봇 판정에만 쓰고 버린다).
  // 기록 실패가 리다이렉트를 막지는 않는다 — 사용자를 상품 페이지로 보내는 것이 우선이다.
  try {
    await db.clickEvent.create({
      data: {
        shortLinkId: link.id,
        referer: req.headers.get("referer")?.slice(0, 500) ?? null,
        uaClass,
        country: req.headers.get("x-vercel-ip-country") ?? null,
      },
    });
  } catch (err) {
    console.error("[shortlink] 클릭 기록 실패", code, err);
  }

  if (link.state === "DEAD") {
    // 커미션 링크가 아닌 자체 안내 페이지로. 여기서 대안을 보여주되 이동은 사용자 클릭으로만.
    return NextResponse.redirect(new URL(`/expired/${code}`, req.nextUrl.origin), 302);
  }

  // 원형 무변조. 파라미터를 붙이거나 빼면 링크 변조 금지 조항 위반이다(docs/03 §5.2).
  const res = NextResponse.redirect(link.targetUrl, 302);
  // 검색봇이 커미션 링크를 따라가 실적을 오염시키지 않도록.
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}
