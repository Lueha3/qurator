// 스크린샷 테스트 데이터 전량 삭제 (CLI) — 규칙은 src/lib/purge-screenshot-data.ts에 있다.
//
//   npm run db:purge-screenshots            무엇이 지워질지 보여주기만 한다 (아무것도 바꾸지 않는다)
//   npm run db:purge-screenshots -- --apply 실제로 지운다 — 되돌릴 수 없다
//
// 같은 일을 앱의 /purge-test-data 화면으로도 할 수 있다(어디에도 링크되지 않은 1회용 페이지).
// 이 스크립트는 PC에서 .env의 DATABASE_URL로 직접 돌리고 싶을 때의 보조 경로다.

import { db } from "../src/lib/db";
import { applyPurge, planPurge } from "../src/lib/purge-screenshot-data";

function maskedHost(url: string | undefined): string {
  if (!url) return "(미설정 — .env의 DATABASE_URL을 확인하세요)";
  try {
    return new URL(url).hostname;
  } catch {
    return "(파싱 실패)";
  }
}

async function main() {
  const apply = process.argv.includes("--apply");

  console.log(`[purge] 대상 DB: ${maskedHost(process.env.DATABASE_URL)}`);
  console.log(apply ? "[purge] 실제 삭제 모드 — 되돌릴 수 없습니다" : "[purge] 미리보기 — 아무것도 지우지 않습니다\n");

  const plan = await planPurge();

  if (plan.productCount === 0) {
    console.log("[purge] 지울 스크린샷 테스트 데이터가 없습니다.");
    return;
  }

  for (const p of plan.products) {
    console.log(`  ${p.brandName} · ${p.productName} — 딜 ${p.dealCount}개`);
  }
  console.log(
    `\n[purge] 상품 ${plan.productCount}개 · 딜 ${plan.dealCount}개 · 가격기록 ${plan.priceSnapshotCount}건 · ` +
      `지켜보는 중 ${plan.watchItemCount}건 · 큐레이터링크 ${plan.curatorLinkCount}개 · ` +
      `발행문구 ${plan.contentCardCount}개 · 발행이력 ${plan.postCount}건 · 숏링크 ${plan.shortLinkCount}개 · 클릭기록 ${plan.clickEventCount}건`
  );

  if (apply) {
    await applyPurge();
    console.log(`\n[purge] 상품 ${plan.productCount}개와 딸린 데이터를 전부 지웠습니다.`);
  } else {
    console.log("\n[purge] 실제로 지우려면: npm run db:purge-screenshots -- --apply");
  }
}

main()
  .catch((err) => {
    console.error("[purge] 실패", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
