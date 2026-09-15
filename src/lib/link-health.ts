// 사람이 표시하는 품절 — docs/05 §3.4의 크롤리스 원칙을 링크 건강에도 적용한 것.
//
// 왜 필요한가: 링크 건강을 판정하는 코드는 `health-check.ts` 하나뿐인데, 그건 무신사 상품
// 페이지를 내려받아야 하고 robots가 우리 UA를 전 경로에서 막는다([05 §9.1]). 게다가 지금은
// 그걸 돌릴 VPS도 크론도 없다. 그래서 **운영에서는 어떤 링크도 죽었다고 표시되지 않았고**,
// 링크허브가 "품절된 상품은 목록에서 내려갑니다"라고 써 놓고도 실제로는 아무것도 내려가지
// 않았다 — 팔로워에게 한 약속이 지켜지지 않는 상태였다.
//
// 해법은 스크린샷 캡처와 같다: **사람이 본 것을 도구가 기록한다.** 현표는 매일 무신사를 보고
// 품절을 가장 먼저 아는 사람이다. 버튼 한 번이면 기계가 못 하는 일이 끝난다.
//
// 표시했을 때 일어나는 일은 헬스체커가 품절을 확정했을 때와 **완전히 같다**:
//   - 큐레이터 링크 health = SOLDOUT  → 허브 목록에서 빠진다
//   - 딜의 숏링크 전부 state = DEAD   → 이미 나간 카톡·노션 글의 링크까지 한 번에 구제된다
//     (게시물을 소급 수정하지 않고 착지점만 비커미션 안내로 바꾼다 — docs/03 불변식 I-5)
//   - 홈에 "정정 공지" 블록이 떠서 카톡에 붙여넣을 문구를 원탭으로 준다

import { db } from "./db";
import { audit } from "./audit";

export type LinkHealthResult = { ok: true; links: number } | { ok: false; reason: string };

async function loadDealWithLinks(dealId: string) {
  return db.deal.findUnique({
    where: { id: dealId },
    include: { product: true, curatorLinks: { select: { id: true } } },
  });
}

/** 품절로 표시한다. 되돌릴 수 있다(restoreDeal). */
export async function markSoldOut(dealId: string, now: Date = new Date()): Promise<LinkHealthResult> {
  const deal = await loadDealWithLinks(dealId);
  if (!deal) return { ok: false, reason: "딜을 찾을 수 없습니다." };
  if (deal.curatorLinks.length === 0) {
    return { ok: false, reason: "붙어 있는 큐레이터 링크가 없습니다." };
  }

  await db.$transaction([
    db.curatorLink.updateMany({
      where: { dealId },
      data: { health: "SOLDOUT", healthCheckedAt: now },
    }),
    db.shortLink.updateMany({ where: { dealId }, data: { state: "DEAD" } }),
  ]);

  await audit({
    actor: "HUMAN",
    action: "health.soldout_marked",
    approvalRef: dealId,
    detail: `${deal.product.brandName} ${deal.product.productName} — 사람이 품절로 표시`,
  });
  return { ok: true, links: deal.curatorLinks.length };
}

/** 잘못 표시했을 때 되돌린다. */
export async function restoreDeal(dealId: string, now: Date = new Date()): Promise<LinkHealthResult> {
  const deal = await loadDealWithLinks(dealId);
  if (!deal) return { ok: false, reason: "딜을 찾을 수 없습니다." };

  await db.$transaction([
    // OK가 아니라 UNCHECKED로 돌린다 — 우리는 "살아있다"를 확인한 적이 없다.
    // 허브는 OK와 UNCHECKED를 모두 노출하므로 목록에는 다시 올라온다.
    db.curatorLink.updateMany({
      where: { dealId },
      data: { health: "UNCHECKED", healthCheckedAt: now, soldoutStreak: 0 },
    }),
    db.shortLink.updateMany({ where: { dealId }, data: { state: "ACTIVE" } }),
  ]);

  await audit({
    actor: "HUMAN",
    action: "health.restored",
    approvalRef: dealId,
    detail: `${deal.product.brandName} ${deal.product.productName} — 품절 표시 해제`,
  });
  return { ok: true, links: deal.curatorLinks.length };
}
