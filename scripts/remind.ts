// 크롤리스 리마인더 러너 — docs/05-price-watch.md §3.4.
//
//   npm run remind          오늘 기록이 필요한 워치 상품을 텔레그램으로 안내
//   npm run remind -- --dry 대상만 출력하고 메시지는 보내지 않는다
//
// ⚠️ 실행 위치가 워치 러너와 반대다: 이건 **봇 호스트**에서 돈다(TELEGRAM_BOT_TOKEN이 필요).
//    무신사로 나가는 요청은 0건이므로 현표의 회선에서 돌아도 docs/03 §4.1 물리 격리에 저촉되지 않는다.
//    VPS에는 플랫폼 토큰을 주입하지 않으므로 거기서는 돌릴 수 없다(docs/05 §5.2).
//
// 크론 예: 매일 오전 10시 — 사람이 실제로 폰을 볼 시간대에 보낸다.
//   0 10 * * *  cd /path/to/qurator && npm run remind >> ~/remind.log 2>&1

import { db } from "../src/lib/db";
import { isCrawlessMode } from "../src/lib/policy";
import { dueForReminder, buildReminderMessages, sendWatchReminder } from "../src/lib/watch-remind";
import { watchCadence } from "../src/lib/watch";

const SKIP_REASON: Record<string, string> = {
  NO_ITEMS: "오늘 기록이 필요한 상품이 없습니다 (전부 최근에 기록됨)",
  NO_CHANNEL: "TELEGRAM_BOT_TOKEN 또는 TELEGRAM_ALLOWED_CHAT_IDS가 비어 있습니다",
  ALREADY_SENT: "이번 주기에 이미 보냈습니다 — 같은 목록으로 두 번 조르지 않습니다",
};

async function dryRun() {
  const [items, { eventTag }] = await Promise.all([dueForReminder(), watchCadence()]);
  console.log(`[remind] --dry: 안내 대상 ${items.length}건 (메시지를 보내지 않습니다)`);
  for (const item of items) {
    const last = item.lastSnapshotAt ? item.lastSnapshotAt.toISOString() : "기록 없음";
    console.log(`  · ${item.brandName} ${item.productName}\n    ${item.canonicalUrl}\n    마지막 기록 ${last}`);
  }
  for (const text of buildReminderMessages(items, eventTag)) {
    console.log("\n--- 보낼 메시지 ---\n" + text);
  }
}

async function once() {
  // 크롤리스가 꺼져 있다면 자동 수집이 정상 동작 중이라는 뜻이다. 그때도 리마인더를 보내면
  // 이미 기록된 상품을 사람에게 또 시키는 꼴이라, 안내하고 아무것도 하지 않는다.
  if (!(await isCrawlessMode())) {
    console.log("[remind] 크롤리스 모드가 꺼져 있습니다 — 자동 수집(npm run watch)이 담당합니다.");
    return;
  }

  const result = await sendWatchReminder();
  if (result.skipped) {
    console.log(`[remind] 보내지 않음: ${SKIP_REASON[result.skipped] ?? result.skipped}`);
    return;
  }
  console.log(`[remind] 상품 ${result.items}건 안내 · 메시지 ${result.sent}통 전송`);
}

async function main() {
  if (process.argv.includes("--dry")) await dryRun();
  else await once();
  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
