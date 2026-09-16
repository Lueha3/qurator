// 중복 후보 카드 정리 — 같은 상품에 열려 있는 딜이 여러 장이면 하나만 남기고 닫는다.
//
// 왜 필요한가: 2026-09-16 이전의 캡처는 찍을 때마다 새 딜을 만들었다. 홈 리마인더가 매일
// "다시 찍어 올려주세요"라고 조르는 구조라([05 §3.4]) 같은 상품의 후보 카드가 하루 한 장씩
// 쌓였다. 캡처 쪽은 이미 고쳤지만([06 §4.1.1]), 그 전에 쌓인 카드는 한 번 걷어내야 한다.
//
// 설정 탭의 버튼과 `npm run db:dedupe` 스크립트가 **같은 이 함수**를 쓴다 —
// 정리 규칙이 두 벌이면 둘이 달라지는 날이 온다.
//
// 안전 규칙 세 가지:
//   1. **지우지 않는다.** '기록 완료'(SKIPPED)로 바꿀 뿐이다 — 가격 기록도, 딜 행도 그대로 남는다.
//   2. **사람 손이 닿은 카드는 건드리지 않는다.** 큐레이터 링크나 완성된 카드가 붙어 있으면
//      자동으로 닫지 않고 목록에만 띄운다. 링크를 만드는 데 든 시간이 이 정리보다 비싸다.
//   3. **남길 카드는 가장 앞서 나간 것.** 승인 대기 > 링크 대기 > 후보 순, 같으면 최신.
//      진행 중이던 판단을 되돌리지 않기 위해서다.

import type { ApprovalStage } from "@prisma/client";
import { db } from "./db";
import { audit } from "./audit";

const OPEN_STAGES: ApprovalStage[] = ["CANDIDATE", "AWAITING_LINK", "READY_TO_PUBLISH"];

const STAGE_RANK: Record<string, number> = {
  READY_TO_PUBLISH: 3,
  AWAITING_LINK: 2,
  CANDIDATE: 1,
};

export const STAGE_LABEL: Record<string, string> = {
  READY_TO_PUBLISH: "승인 대기",
  AWAITING_LINK: "링크 대기",
  CANDIDATE: "후보",
};

export interface DedupeCard {
  dealId: string;
  stageLabel: string;
  /** "9. 12. 12:57" — 서버에서 확정한 문자열 (클라이언트가 다시 계산하지 않는다) */
  when: string;
  /** 사람 손이 닿았다는 근거 — 링크·카드 수 */
  links: number;
  cards: number;
}

export interface DedupeGroup {
  productLabel: string;
  keep: DedupeCard;
  /** 닫을 카드 */
  close: DedupeCard[];
  /** 사람이 직접 판단해야 하는 카드 (링크·카드가 붙어 있다) */
  manual: DedupeCard[];
}

export interface DedupePlan {
  groups: DedupeGroup[];
  closeCount: number;
  manualCount: number;
}

function when(date: Date): string {
  return date.toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 무엇을 닫을지 계산한다 — **아무것도 바꾸지 않는다.**
 * 적용할 때도 이 함수를 다시 불러 계산한다: 클라이언트가 보낸 id 목록을 믿지 않는다.
 */
export async function planDedupe(): Promise<DedupePlan> {
  const deals = await db.deal.findMany({
    where: { approvalStage: { in: OPEN_STAGES } },
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

  const toCard = (deal: (typeof deals)[number]): DedupeCard => ({
    dealId: deal.id,
    stageLabel: STAGE_LABEL[deal.approvalStage] ?? deal.approvalStage,
    when: when(deal.createdAt),
    links: deal.curatorLinks.length,
    cards: deal.contentCards.length,
  });

  const groups: DedupeGroup[] = [];
  for (const group of byProduct.values()) {
    if (group.length < 2) continue;

    const sorted = [...group].sort((a, b) => {
      const rank = STAGE_RANK[b.approvalStage] - STAGE_RANK[a.approvalStage];
      return rank !== 0 ? rank : b.createdAt.getTime() - a.createdAt.getTime();
    });
    const [keep, ...rest] = sorted;

    const close: DedupeCard[] = [];
    const manual: DedupeCard[] = [];
    for (const deal of rest) {
      const touched = deal.curatorLinks.length > 0 || deal.contentCards.length > 0;
      (touched ? manual : close).push(toCard(deal));
    }

    // 닫을 것도 없고 알릴 것도 없으면 목록에 올리지 않는다(사람이 볼 이유가 없다).
    if (close.length === 0 && manual.length === 0) continue;

    groups.push({
      productLabel: `${keep.product.brandName} · ${keep.product.productName}`,
      keep: toCard(keep),
      close,
      manual,
    });
  }

  return {
    groups,
    closeCount: groups.reduce((n, g) => n + g.close.length, 0),
    manualCount: groups.reduce((n, g) => n + g.manual.length, 0),
  };
}

/** 계획을 실제로 적용한다. 계획은 여기서 **다시 계산한다** — 그 사이 바뀌었을 수 있다. */
export async function applyDedupe(): Promise<{ closed: number }> {
  const plan = await planDedupe();
  let closed = 0;

  for (const group of plan.groups) {
    for (const card of group.close) {
      await db.deal.update({
        where: { id: card.dealId },
        data: { approvalStage: "SKIPPED" },
      });
      await audit({
        actor: "HUMAN",
        action: "deal.deduped",
        approvalRef: card.dealId,
        detail: `${group.productLabel} — 같은 상품의 중복 후보를 일괄 정리 (남긴 딜 ${group.keep.dealId})`,
      });
      closed++;
    }
  }

  return { closed };
}
