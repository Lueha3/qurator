"use server";

import { db } from "@/lib/db";
import { verifyCardToken } from "@/lib/signed-link";
import { audit } from "@/lib/audit";

/**
 * 복사 웹뷰에서 "복사됨"을 기록한다.
 *
 * 서버 액션으로 둔 이유: /copy/*는 미들웨어 인증 예외(텔레그램 인앱 브라우저에는 세션이 없다)라서,
 * 별도 API 라우트를 만들면 그 라우트도 공개해야 한다. 서버 액션은 같은 경로로 POST되므로
 * 새 공개 표면을 만들지 않고, 액션 자신이 서명 토큰을 다시 검증한다.
 */
export async function recordCopy(token: string): Promise<void> {
  const checked = verifyCardToken(token);
  if (!checked.ok) return;

  const card = await db.contentCard.findUnique({ where: { id: checked.cardId } });
  if (!card) return;

  // 고지문 검증 실패 카드는 복사 사실조차 기록하지 않는다 — 애초에 페이지가 본문을 렌더하지 않는다.
  if (!card.disclosureOk) return;

  await db.post.create({
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
    detail: "복사 웹뷰에서 클립보드로 복사",
  });
}
