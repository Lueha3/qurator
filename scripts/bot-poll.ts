// 로컬 개발용 폴링 러너.
//
// 텔레그램은 같은 봇 토큰에서 webhook과 getUpdates를 동시에 허용하지 않는다(409 Conflict).
// 그래서 시작할 때 deleteWebhook을 먼저 호출한다 — 프로덕션 webhook이 걸려 있으면 폴링이 안 된다.
//
// 실행: npm run bot
// 프로덕션에서는 이 스크립트 대신 /api/telegram/webhook 라우트를 쓴다.

import { callMethod } from "../src/lib/telegram/client";
import { handleUpdate, type TgUpdate } from "../src/lib/telegram/handler";

const LONG_POLL_TIMEOUT_S = 30;

async function main() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN이 없습니다. .env를 확인하세요.");
    process.exit(1);
  }
  if (!process.env.TELEGRAM_ALLOWED_CHAT_IDS) {
    console.error(
      "TELEGRAM_ALLOWED_CHAT_IDS가 없습니다. 화이트리스트가 비면 봇은 모든 메시지를 거부합니다.\n" +
        "봇에게 아무 메시지나 보낸 뒤 https://api.telegram.org/bot<TOKEN>/getUpdates 로 chat id를 확인하세요."
    );
    process.exit(1);
  }

  // webhook이 걸려 있으면 폴링이 409로 실패한다. 로컬 개발 시작 시 해제한다.
  await callMethod("deleteWebhook", { drop_pending_updates: false });

  const me = await callMethod<{ username: string }>("getMe");
  console.log(`[bot] @${me.username} 폴링 시작 (Ctrl+C로 종료)`);

  let offset = 0;
  let stopping = false;
  process.on("SIGINT", () => {
    console.log("\n[bot] 종료 중…");
    stopping = true;
  });

  while (!stopping) {
    try {
      const updates = await callMethod<TgUpdate[]>("getUpdates", {
        offset,
        timeout: LONG_POLL_TIMEOUT_S,
        allowed_updates: ["message", "callback_query"],
      });

      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1); // 처리 완료를 텔레그램에 알리는 커서
        try {
          await handleUpdate(update);
        } catch (err) {
          console.error("[bot] 업데이트 처리 실패", update.update_id, err);
        }
      }
    } catch (err) {
      console.error("[bot] 폴링 오류 — 3초 후 재시도", err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
