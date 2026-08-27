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

export async function GET(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;

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
