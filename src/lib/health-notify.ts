// 죽은 링크를 발견했을 때 현표에게 알리고 정정문을 만들어 준다.
//
// 자동으로 처리되는 곳(링크허브·노션)과 사람이 손대야 하는 곳(카톡 오픈채팅)을 구분하는 것이 핵심이다.
// 카톡은 이미 나간 메시지를 수정할 수 없으므로, 정정 메시지를 붙여넣을 수 있게 완성본을 준다.

import { db } from "./db";
import { escapeHtml, sendMessage } from "./telegram/client";
import { formatKRW } from "./format";

/** 카톡에 붙여넣을 정정 공지. 원문과 같은 고지 원칙을 따른다. */
export function correctionText(brand: string, productName: string): string {
  return `[품절 안내] ${brand} ${productName} 은(는) 품절되었습니다. 링크를 눌러도 구매할 수 없어요. 새 아이템으로 다시 찾아뵙겠습니다!`;
}

export async function notifyDeadLinks(dealIds: string[]): Promise<void> {
  if (dealIds.length === 0) return;

  const chatIds = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (chatIds.length === 0 || !process.env.TELEGRAM_BOT_TOKEN) return;

  const deals = await db.deal.findMany({
    where: { id: { in: dealIds } },
    include: { product: true },
  });

  for (const deal of deals) {
    const price = deal.finalPrice ?? deal.salePrice ?? deal.product.listPrice;
    const correction = correctionText(deal.product.brandName, deal.product.productName);

    const text =
      `🔴 <b>품절 확인</b>\n` +
      escapeHtml(`${deal.product.brandName} · ${deal.product.productName}`) +
      (price > 0 ? `\n${escapeHtml(formatKRW(price))}` : "") +
      `\n\n✅ 링크허브·노션에서는 자동으로 내렸습니다.\n` +
      `📋 카톡 오픈채팅에는 아래 정정 공지를 붙여넣어 주세요.\n\n` +
      `<pre>${escapeHtml(correction)}</pre>`;

    try {
      await sendMessage({
        chatId: chatIds[0],
        text,
        // 카톡 정정문이 짧으므로 원탭 복사 버튼을 붙일 수 있다
        keyboard: [[{ text: "📋 정정 공지 복사", copy_text: { text: correction } }]],
      });
    } catch (err) {
      console.error("[health] 품절 알림 전송 실패", deal.id, err);
    }
  }
}
