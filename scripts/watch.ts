// BF 가격 워치 러너 — docs/05-price-watch.md §3.2·§5.
//
//   npm run watch           한 사이클 실행 (크론/systemd 타이머가 하루 1회 호출)
//   npm run watch -- --dry  대상만 출력하고 요청은 보내지 않는다 (게이트 통과 전 점검용)
//
// ⚠️ 실행 위치 규율 (docs/03 §4.1):
//   이 러너는 **VPS 등 현표의 기기·IP와 분리된 인프라에서만** 돌린다.
//   현표가 무신사에 로그인하는 회선에서 자동 반복 요청이 나가면 계정과 봇 트래픽이
//   같은 출처로 묶인다 — 이 프로젝트가 막으려는 바로 그 사고다.
//
// ⚠️ 가동 전 필수 게이트 (docs/05 §3.3):
//   VPS IP에서 robots.txt와 저빈도 단건 fetch를 실측하고 그 결과를 docs/05 §9에 기록하기 전에는
//   가동하지 않는다. 막히면 뚫지 않고 크롤리스 모드로 확정한다.
//
// 스케줄 규율: 헬스체크(npm run health)와 **다른 시간대**에 배치한다.
//   호스트당 시간당 60건 캡을 공유하므로 겹치면 한쪽이 BLOCKED_BUDGET으로 조기 종료된다.

import { db } from "../src/lib/db";
import { listActiveWatches, runWatchCycle } from "../src/lib/watch";
import { getWatchLimits } from "../src/lib/policy";

async function dryRun() {
  const [items, limits] = await Promise.all([listActiveWatches(), getWatchLimits()]);
  console.log(
    `[watch] --dry: 활성 워치 ${items.length}/${limits.itemsMax}건 (요청을 보내지 않습니다)`
  );
  for (const item of items) {
    const last = item.lastCheckedAt ? item.lastCheckedAt.toISOString() : "미조회";
    console.log(
      `  · ${item.product.brandName} ${item.product.productName}\n` +
        `    ${item.product.canonicalUrl}\n` +
        `    마지막 조회 ${last} · 만료 ${item.expiresAt.toISOString().slice(0, 10)}`
    );
  }
}

async function once() {
  const started = Date.now();
  const result = await runWatchCycle();
  const seconds = Math.round((Date.now() - started) / 1000);

  const eventNote = result.eventTag ? ` · 행사 창 ${result.eventTag}(하루 2회)` : "";
  console.log(
    `[watch] 조회 ${result.checked}건 · 스냅샷 ${result.recorded}건 · ` +
      `파싱실패 ${result.parseFailed}건 · 만료해제 ${result.expired}건 (${seconds}초)${eventNote}`
  );

  // 조기 종료를 조용히 넘기지 않는다 — 몇 주째 아무것도 수집하지 않는데
  // 로그가 "조회 0건"만 찍고 있으면 BF가 지나가버린다.
  if (result.stoppedEarly) {
    console.warn(`[watch] ⚠️ 사이클이 조기 종료됐습니다: ${result.stoppedEarly}`);
    console.warn("[watch]    상태 확인: npm run gateway status");
    process.exitCode = 1; // 크론이 실패를 감지할 수 있게
  }
  if (result.parseFailed > 0) {
    console.warn("[watch] ⚠️ 가격을 못 읽은 상품이 있습니다 — 파서 점검이 필요할 수 있습니다.");
  }
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
