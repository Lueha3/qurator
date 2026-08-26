import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// 클라이언트가 클립보드 복사에 성공한 직후 호출한다. docs/02-architecture.md §3.2:
// 반자동 채널은 "복사 시점을 presumed_done으로 간주" — 별도 확인 탭을 요구하지 않는다.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const card = await db.contentCard.findUnique({ where: { id } });
  if (!card) {
    return NextResponse.json({ error: "카드를 찾을 수 없습니다." }, { status: 404 });
  }

  const post = await db.post.create({
    data: {
      contentCardId: card.id,
      dealId: card.dealId,
      channel: card.channel,
      mode: "SEMI_COPIED",
      status: "SENT",
      publishedAt: new Date(),
    },
  });

  return NextResponse.json({ postId: post.id }, { status: 201 });
}
