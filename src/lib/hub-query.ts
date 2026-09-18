import type { Prisma } from "@prisma/client";

/**
 * "지금 살 수 있는 딜"의 조건 — 허브(/hub)와 만료 안내(/expired)가 같은 것을 쓴다.
 * 두 페이지가 각자 where를 갖고 있으면, 한쪽만 고쳐져 만료 안내가 죽은 링크를 "살 수 있는 다른 꿀매"로
 * 내미는 날이 온다(감사에서 실제로 그렇게 어긋나 있었다).
 */
export function liveHubDealsWhere(now: Date): Prisma.DealWhereInput {
  return {
    status: "PUBLISHED",
    curatorLinks: { some: { health: { in: ["OK", "UNCHECKED"] } } },
    shortLinks: { some: { state: "ACTIVE", surface: "hub" } },
    OR: [{ endsAt: null }, { endsAt: { gt: now } }],
  };
}
