// 중복 후보 카드 정리 — 같은 상품에 열려 있는 딜이 여러 장이면 하나만 남기고 닫는다.
//
// 왜 필요한가: 2026-09-16 이전의 캡처는 찍을 때마다 새 딜을 만들었다. 홈 리마인더가 매일
// "다시 찍어 올려주세요"라고 조르는 구조라([05 §3.4]) 같은 상품의 후보 카드가 하루 한 장씩
// 쌓였다. 캡처 쪽은 이미 고쳤지만([06 §4.1.1]), 그 전에 쌓인 카드는 손으로 닫아야 한다.
//
//   npm run db:dedupe            무엇을 닫을지 보여주기만 한다 (아무것도 바꾸지 않는다)
//   npm run db:dedupe -- --apply 실제로 닫는다
//
// 안전 규칙 세 가지:
//   1. **지우지 않는다.** '기록 완료'(SKIPPED)로 바꿀 뿐이다 — 가격 기록도, 딜 행도 그대로 남는다.
//   2. **사람 손이 닿은 카드는 건드리지 않는다.** 큐레이터 링크나 완성된 카드가 붙어 있으면
//      자동으로 닫지 않고 목록에만 띄운다. 링크를 만드는 데 든 시간이 이 스크립트보다 비싸다.
//   3. **남길 카드는 가장 앞서 나간 것.** 승인 대기 > 링크 대기 > 후보 순, 같으면 최신.
//      진행 중이던 판단을 되돌리지 않기 위해서다.

import { db } from "../src/lib/db";
import { audit } from "../src/lib/audit";

const OPEN_STAGES = ["CANDIDATE", "AWAITING_LINK", "READY_TO_PUBLISH"] as const;
const STAGE_RANK: Record<string, number> = {
  READY_TO_PUBLISH: 3,
  AWAITING_LINK: 2,
  CANDIDATE: 1,
};

function maskedHost(url: string | undefined): string {
  if (!url) return "(미설정)";
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

  const deals = await db.deal.findMany({
    where: { approvalStage: { in: [...OPEN_STAGES] } },
    include: {
      product: { select: { brandName: true, productName: true } },
      curatorLinks: { select: { id: true } },
      contentCards: { select: { id: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const byProduct = new Map<string, typeof deals>();
  for (const deal of deals) {
    const list = byProduct.get(deal.productId);
    if (list) list.push(deal);
    else byProduct.set(deal.productId, [deal]);
  }

  let closed = 0;
  let kept = 0;
  let manual = 0;

  for (const group of byProduct.values()) {
    if (group.length < 2) continue;

    // 가장 앞서 나간 카드를 남긴다 (같은 단계면 최신).
    const sorted = [...group].sort((a, b) => {
      const rank = STAGE_RANK[b.approvalStage] - STAGE_RANK[a.approvalStage];
      return rank !== 0 ? rank : b.createdAt.getTime() - a.createdAt.getTime();
    });
    const [keep, ...rest] = sorted;
    const label = `${keep.product.brandName} · ${keep.product.productName}`;
    kept++;

    console.log(`\n${label} — 열린 카드 ${group.length}장`);
    console.log(`  남김: ${keep.approvalStage} (${keep.createdAt.toISOString().slice(0, 16)})`);

    for (const deal of rest) {
      const touched = deal.curatorLinks.length > 0 || deal.contentCards.length > 0;
      const when = deal.createdAt.toISOString().slice(0, 16);

      if (touched) {
        manual++;
        console.log(
          `  건너뜀: ${deal.approvalStage} (${when}) — 링크 ${deal.curatorLinks.length}개·카드 ${deal.contentCards.length}개가 붙어 있어 사람이 직접 판단해야 합니다`
        );
        continue;
      }

      console.log(`  닫음: ${deal.approvalStage} (${when})`);
      if (apply) {
        await db.deal.update({ where: { id: deal.id }, data: { approvalStage: "SKIPPED" } });
        await audit({
          actor: "HUMAN",
          action: "deal.deduped",
          approvalRef: deal.id,
          detail: `${label} — 같은 상품의 중복 후보를 일괄 정리 (남긴 딜 ${keep.id})`,
        });
      }
      closed++;
    }
  }

  console.log(
    `\n[dedupe] 상품 ${kept}개에서 ${closed}장을 ${apply ? "닫았습니다" : "닫을 예정입니다"}.` +
      (manual > 0 ? ` 사람 판단이 필요한 ${manual}장은 그대로 뒀습니다.` : "")
  );
  if (!apply && closed > 0) {
    console.log("[dedupe] 실제로 정리하려면: npm run db:dedupe -- --apply");
  }
  if (closed === 0 && manual === 0) {
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
