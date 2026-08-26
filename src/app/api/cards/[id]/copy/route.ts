import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

// 웹 대시보드에서 카드를 클립보드로 복사한 직후 호출된다.
// docs/02-architecture.md §3.2: 반자동 채널은 "복사 시점을 presumed_done으로 간주" —
// 별도 확인 탭을 요구하지 않는다.
//
// 이 경로는 middleware.ts의 인증 뒤에 있다(=/api/copy/* 는 공개 예외가 아니다).
// 텔레그램에서 열리는 복사 웹뷰는 세션이 없으므로 이 라우트가 아니라
// src/app/copy/[cardId]/actions.ts 의 서버 액션(서명 토큰 검증)을 쓴다.

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const card = await db.contentCard.findUnique({ where: { id } });
  if (!card) {
    return NextResponse.json({ error: "카드를 찾을 수 없습니다." }, { status: 404 });
  }

  // 고지문 검증 실패 카드는 어떤 경로로도 나가지 않는다 (docs/03 §1 불변식 I-3).
  // 복사도 발행 경로이므로 여기서도 막는다.
  if (!card.disclosureOk) {
    await audit({
      actor: "SYSTEM",
      action: "publish.blocked_disclosure",
      approvalRef: card.dealId,
      channel: card.channel,
      detail: "복사 API에서 차단",
    });
    return NextResponse.json(
      { error: "고지문 검증에 실패한 카드는 복사할 수 없습니다." },
      { status: 422 }
    );
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

  await audit({
    actor: "HUMAN",
    action: "card.copied",
    approvalRef: card.dealId,
    channel: card.channel,
    detail: "웹 대시보드에서 클립보드로 복사",
  });

  return NextResponse.json({ postId: post.id }, { status: 201 });
}
