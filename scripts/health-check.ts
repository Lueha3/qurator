// 헬스체크 러너. 크론이나 워커가 주기적으로 호출한다.
//
//   npm run health          한 사이클 실행
//   npm run health -- --loop   6시간 간격 반복 (롱리빙 프로세스로 돌릴 때)
//
// 게이트웨이가 예산·페이싱·차단감지를 담당하므로 이 스크립트는 사이클을 돌리기만 한다.
// 차단이 감지되면 게이트웨이가 서킷을 열고, 이 러너는 조용히 아무것도 하지 않게 된다
// (자동으로 뚫으려 시도하지 않는다 — 해제는 npm run gateway resume).

import { db } from "../src/lib/db";
import { runHealthCheck } from "../src/lib/health-check";
import { notifyDeadLinks } from "../src/lib/health-notify";

const LOOP_INTERVAL_MS = 6 * 3_600_000;

async function once() {
  const started = Date.now();
  const result = await runHealthCheck();
  const seconds = Math.round((Date.now() - started) / 1000);

  console.log(
    `[health] 점검 ${result.checked}건 · 품절 확정 ${result.died.length}건 · 판정보류 ${result.frozen}건 (${seconds}초)`
  );

  if (result.died.length > 0) {
    await notifyDeadLinks(result.died);
    console.log(`[health] 품절 알림 ${result.died.length}건 전송`);
  }
  if (result.frozen > 0) {
    console.log("[health] ⚠️ 판정보류가 있습니다 — 파서가 깨졌을 수 있으니 확인하세요.");
  }
}

async function main() {
  const loop = process.argv.includes("--loop");

  if (!loop) {
    await once();
    await db.$disconnect();
    return;
  }

  console.log(`[health] 반복 모드 (${LOOP_INTERVAL_MS / 3_600_000}시간 간격, Ctrl+C로 종료)`);
  let stopping = false;
  process.on("SIGINT", () => {
    console.log("\n[health] 종료 중…");
    stopping = true;
  });

  while (!stopping) {
    try {
      await once();
    } catch (err) {
      console.error("[health] 사이클 실패", err);
    }
    // 종료 신호를 빠르게 받도록 잘게 나눠 잔다
    for (let slept = 0; slept < LOOP_INTERVAL_MS && !stopping; slept += 5000) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
