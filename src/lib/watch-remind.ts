// 크롤리스 리마인더 — docs/05-price-watch.md §3.4.
//
// robots.txt가 우리 UA(HoneyFlowBot)를 전 경로 차단한다는 사실이 §9.1에서 실측 확정됐다.
// 그래서 워치의 기본 운영 모드는 자동 수집이 아니라 **사람에게 알리는 것**이다:
//
//   "오늘 가격을 기록할 상품 N개 — 앱에서 열고 봇에 다시 던져주세요"
//
// 사람이 링크를 탭해서 여는 것은 봇 트래픽이 아니다. 그렇게 던져진 링크는 기존 USER_URL 경로를
// 그대로 타고 스냅샷이 되므로(docs/05 §4.3 ①) **우리 게이트웨이의 추가 요청 0건**으로 기준가가 쌓인다.
// 뚫지 않는다는 원칙(Never List #7)을 지키면서 10/1 기준가 수집 데드라인을 지키는 유일한 길이라,
// 이건 임시방편이 아니라 지금의 정규 경로다.
//
// ⚠️ 실행 위치가 워치 러너와 **반대**다.
//    러너(scripts/watch.ts)는 VPS 전용이고 플랫폼 토큰을 일절 갖지 않는다(docs/03 §4.1, docs/05 §5.2).
//    리마인더는 TELEGRAM_BOT_TOKEN이 필요하므로 **봇 호스트**에서 돈다. 나가는 요청은 텔레그램뿐이고
//    무신사로는 한 건도 나가지 않으므로, 현표의 회선에서 돌아도 물리 격리 원칙에 저촉되지 않는다.

import { db } from "./db";
import { audit } from "./audit";
import { escapeHtml, sendMessage, MESSAGE_TEXT_LIMIT } from "./telegram/client";
import { formatRelativeFromNow } from "./format";
import { watchCadence } from "./watch";

/** 한 메시지에 담을 최대 상품 수. 4096자 한도와 별개로, 사람이 한 번에 처리할 수 있는 양의 상한이다. */
const MAX_ITEMS_PER_MESSAGE = 10;

/** 텔레그램 4096자 한도에 여유를 둔다 — HTML 엔티티가 계산보다 길어질 수 있다. */
const TEXT_BUDGET = MESSAGE_TEXT_LIMIT - 256;

export interface ReminderItem {
  productId: string;
  brandName: string;
  productName: string;
  canonicalUrl: string;
  /** 마지막으로 가격이 기록된 시각. null이면 아직 한 번도 없다 */
  lastSnapshotAt: Date | null;
}

export interface ReminderResult {
  /** 전송한 텔레그램 메시지 수 */
  sent: number;
  /** 안내한 상품 수 */
  items: number;
  /** 보내지 않았다면 그 이유 */
  skipped: "NO_ITEMS" | "NO_CHANNEL" | "ALREADY_SENT" | null;
}

/**
 * 오늘 사람 손이 필요한 워치 항목.
 *
 * 자동 사이클과 달리 `lastCheckedAt`이 아니라 **스냅샷 유무**를 기준으로 삼는다.
 * 크롤리스 모드에서는 러너가 아무것도 조회하지 않아 `lastCheckedAt`이 영원히 그대로이고,
 * 정작 값이 쌓이는 경로는 현표가 링크를 던진 USER_URL 스냅샷이기 때문이다.
 * 즉 "오늘 이미 던진 상품"은 다시 조르지 않는다 — 조르는 알림은 몇 번 무시되면 전부 무시된다.
 */
export async function dueForReminder(now: Date = new Date()): Promise<ReminderItem[]> {
  const { intervalMs } = await watchCadence(now);
  const since = new Date(now.getTime() - intervalMs);

  const watches = await db.watchItem.findMany({
    where: { active: true, expiresAt: { gt: now } },
    include: { product: true },
    orderBy: { createdAt: "asc" },
  });
  if (watches.length === 0) return [];

  const productIds = watches.map((w) => w.productId);
  // 상품별 마지막 스냅샷을 한 번에 — 30건짜리 목록에 N+1 쿼리를 돌릴 이유가 없다.
  const latest = await db.priceSnapshot.groupBy({
    by: ["productId"],
    where: { productId: { in: productIds } },
    _max: { capturedAt: true },
  });
  const lastByProduct = new Map<string, Date | null>(
    latest.map((row) => [row.productId, row._max.capturedAt ?? null])
  );

  return watches
    .filter((w) => {
      const last = lastByProduct.get(w.productId) ?? null;
      return last === null || last <= since;
    })
    .map((w) => ({
      productId: w.productId,
      brandName: w.product.brandName,
      productName: w.product.productName,
      canonicalUrl: w.product.canonicalUrl,
      lastSnapshotAt: lastByProduct.get(w.productId) ?? null,
    }));
}

/**
 * 리마인더 본문. 상품이 많으면 여러 통으로 나눈다 —
 * 잘린 목록을 보내면 뒤쪽 상품은 영영 기록되지 않는다.
 */
export function buildReminderMessages(
  items: ReminderItem[],
  eventTag: string | null,
  now: Date = new Date()
): string[] {
  if (items.length === 0) return [];

  const chunks: ReminderItem[][] = [];
  for (let i = 0; i < items.length; i += MAX_ITEMS_PER_MESSAGE) {
    chunks.push(items.slice(i, i + MAX_ITEMS_PER_MESSAGE));
  }

  const messages: string[] = [];
  chunks.forEach((chunk, page) => {
    const pageNote = chunks.length > 1 ? ` (${page + 1}/${chunks.length})` : "";
    const head =
      `📌 <b>오늘의 BF 가격 기록</b> — ${items.length}개${pageNote}\n` +
      (eventTag ? `<i>행사 기간(${escapeHtml(eventTag)}) — 하루 2회 기록합니다.</i>\n` : "") +
      `링크를 눌러 앱에서 연 다음, <b>공유 → 이 봇</b>으로 다시 던져주세요.\n` +
      `던지는 순간 가격이 기록됩니다 (자동 수집은 하지 않습니다 — docs/05 §3.4).\n`;

    const lines = chunk.map((item, i) => {
      const n = page * MAX_ITEMS_PER_MESSAGE + i + 1;
      const last = item.lastSnapshotAt
        ? `마지막 기록 ${formatRelativeFromNow(item.lastSnapshotAt, now)}`
        : "아직 기록 없음";
      return (
        `${n}. <a href="${escapeHtml(item.canonicalUrl)}">` +
        `${escapeHtml(item.brandName)} ${escapeHtml(item.productName)}</a>\n` +
        `   <i>${last}</i>`
      );
    });

    // 한도를 넘으면 뒤에서부터 덜어내고, 덜어낸 만큼은 다음 통으로 넘기지 않고 다음 사이클에 맡긴다
    // (같은 상품이 두 통에 중복 등장하는 편이 혼란스럽다).
    let text = `${head}\n${lines.join("\n")}`;
    while (text.length > TEXT_BUDGET && lines.length > 1) {
      lines.pop();
      text = `${head}\n${lines.join("\n")}\n<i>…나머지는 다음 알림에서</i>`;
    }
    messages.push(text);
  });

  return messages;
}

/** 알림을 받을 채널. 화이트리스트가 비어 있으면 보내지 않는다(health-notify와 같은 규칙). */
function reminderChatId(): string | null {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  const ids = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids[0] ?? null;
}

/**
 * 리마인더 한 사이클. 크론이 하루 1회 부르지만, 두 번 불려도 두 번 조르지 않는다 —
 * 재조회 간격과 같은 창 안에 이미 보냈으면 건너뛴다. 빈도 규율은 자동이든 수동이든 하나여야 한다.
 */
export async function sendWatchReminder(now: Date = new Date()): Promise<ReminderResult> {
  const chatId = reminderChatId();
  if (!chatId) return { sent: 0, items: 0, skipped: "NO_CHANNEL" };

  const { intervalMs, eventTag } = await watchCadence(now);
  const recentlyReminded = await db.auditLog.findFirst({
    where: { action: "watch.reminded", ts: { gt: new Date(now.getTime() - intervalMs) } },
    orderBy: { ts: "desc" },
  });
  if (recentlyReminded) return { sent: 0, items: 0, skipped: "ALREADY_SENT" };

  const items = await dueForReminder(now);
  if (items.length === 0) return { sent: 0, items: 0, skipped: "NO_ITEMS" };

  const messages = buildReminderMessages(items, eventTag, now);
  let sent = 0;
  for (const text of messages) {
    try {
      await sendMessage({ chatId, text });
      sent++;
    } catch (err) {
      console.error("[remind] 리마인더 전송 실패", err);
    }
  }

  // 한 통도 못 보냈으면 기록하지 않는다 — 기록해버리면 다음 사이클까지 조용히 건너뛴다.
  if (sent > 0) {
    await audit({
      actor: "SYSTEM",
      action: "watch.reminded",
      detail: `크롤리스 리마인더 ${items.length}건 안내 (메시지 ${sent}통)${eventTag ? ` · ${eventTag}` : ""}`,
    });
  }

  return { sent, items: items.length, skipped: null };
}
