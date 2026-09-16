// 중복 후보 카드 정리 (CLI) — 규칙은 src/lib/dedupe.ts에 있다. 여기서는 보여주고 물어보기만 한다.
//
//   npm run db:dedupe            무엇을 닫을지 보여주기만 한다 (아무것도 바꾸지 않는다)
//   npm run db:dedupe -- --apply 실제로 닫는다
//
// 같은 일을 **설정 탭의 [중복 카드 정리] 버튼**으로도 할 수 있다. 그쪽은 앱이 이미 들고 있는
// DB 연결을 쓰므로 .env를 맞출 필요가 없다 — 이 스크립트는 PC에서 돌리고 싶을 때의 보조 경로다.

import { db } from "../src/lib/db";
import { applyDedupe, planDedupe } from "../src/lib/dedupe";

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

  console.log(`[dedupe] 대상 DB: ${maskedHost(process.env.DATABASE_URL)}`);
  console.log(apply ? "[dedupe] 실제 정리 모드" : "[dedupe] 미리보기 — 아무것도 바꾸지 않습니다\n");

  const plan = await planDedupe();

  for (const group of plan.groups) {
    const total = 1 + group.close.length + group.manual.length;
    console.log(`\n${group.productLabel} — 열린 카드 ${total}장`);
    console.log(`  남김: ${group.keep.stageLabel} (${group.keep.when})`);
    for (const card of group.manual) {
      console.log(
        `  건너뜀: ${card.stageLabel} (${card.when}) — 링크 ${card.links}개·카드 ${card.cards}개가 붙어 있어 사람이 직접 판단해야 합니다`
      );
    }
    for (const card of group.close) {
      console.log(`  닫음: ${card.stageLabel} (${card.when})`);
    }
  }

  if (apply) {
    const { closed } = await applyDedupe();
    console.log(`\n[dedupe] 상품 ${plan.groups.length}개에서 ${closed}장을 닫았습니다.`);
  } else {
    console.log(
      `\n[dedupe] 상품 ${plan.groups.length}개에서 ${plan.closeCount}장을 닫을 예정입니다.`
    );
    if (plan.closeCount > 0) {
      console.log("[dedupe] 실제로 정리하려면: npm run db:dedupe -- --apply");
    }
  }

  if (plan.manualCount > 0) {
    console.log(`[dedupe] 사람 판단이 필요한 ${plan.manualCount}장은 그대로 뒀습니다.`);
  }
  if (plan.closeCount === 0 && plan.manualCount === 0) {
    console.log("[dedupe] 정리할 중복이 없습니다.");
  }
}

main()
  .catch((err) => {
    console.error("[dedupe] 실패", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
