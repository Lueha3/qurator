// 크롤리스 리마인더 — docs/05-price-watch.md §3.4.
//
// robots.txt가 우리 UA(HoneyFlowBot)를 전 경로 차단한다는 사실이 §9.1에서 실측 확정됐다.
// 그래서 워치의 기본 운영 모드는 자동 수집이 아니라 **사람에게 알리는 것**이다:
//
//   "오늘 가격을 기록할 상품 N개 — 무신사 앱에서 다시 찍어 올려주세요"
//
// 사람이 스크린샷을 올리는 것은 봇 트래픽이 아니다. 그렇게 올라온 스크린샷은 기존 SCREENSHOT
// 경로를 그대로 타고 스냅샷이 되므로(docs/05 §4.3 ①) **우리 게이트웨이의 추가 요청 0건**으로
// 기준가가 쌓인다. 뚫지 않는다는 원칙(Never List #7)을 지키면서 기준가를 모으는 유일한 길이라,
// 이건 임시방편이 아니라 지금의 정규 경로다.
//
// 2026-09-14: 텔레그램 푸시 대신 웹 대시보드 상단에 이 목록을 띄운다 — 현표가 앱을 열 때
// 보는 첫 화면이 곧 리마인더다(별도 전송·중복 억제 로직이 필요 없다).

import { db } from "./db";
import { watchCadence } from "./watch";

export interface ReminderItem {
  productId: string;
  brandName: string;
  productName: string;
  canonicalUrl: string;
  /** 마지막으로 가격이 기록된 시각. null이면 아직 한 번도 없다 */
  lastSnapshotAt: Date | null;
}

/**
 * 오늘 사람 손이 필요한 워치 항목.
 *
 * 자동 사이클과 달리 `lastCheckedAt`이 아니라 **스냅샷 유무**를 기준으로 삼는다.
 * 크롤리스 모드에서는 러너가 아무것도 조회하지 않아 `lastCheckedAt`이 영원히 그대로이고,
 * 정작 값이 쌓이는 경로는 현표가 올린 스크린샷 스냅샷이기 때문이다.
 * 즉 "오늘 이미 올린 상품"은 다시 조르지 않는다 — 조르는 알림은 몇 번 무시되면 전부 무시된다.
 */
export async function dueForReminder(now: Date = new Date()): Promise<ReminderItem[]> {
  const { intervalMs } = await watchCadence(now);
  const since = new Date(now.getTime() - intervalMs);

  const watches = await db.watchItem.findMany({
    where: { active: true, expiresAt: { gt: now } },
    include: { product: true },
    orderBy: { createdAt: "asc" },
  });
  if (watches.length === 0) return [];

  const productIds = watches.map((w) => w.productId);
  // 상품별 마지막 스냅샷을 한 번에 — 30건짜리 목록에 N+1 쿼리를 돌릴 이유가 없다.
  const latest = await db.priceSnapshot.groupBy({
    by: ["productId"],
    where: { productId: { in: productIds } },
    _max: { capturedAt: true },
  });
  const lastByProduct = new Map<string, Date | null>(
    latest.map((row) => [row.productId, row._max.capturedAt ?? null])
  );

  return watches
    .filter((w) => {
      const last = lastByProduct.get(w.productId) ?? null;
      return last === null || last <= since;
    })
    .map((w) => ({
      productId: w.productId,
      brandName: w.product.brandName,
      productName: w.product.productName,
      canonicalUrl: w.product.canonicalUrl,
      lastSnapshotAt: lastByProduct.get(w.productId) ?? null,
    }));
}
