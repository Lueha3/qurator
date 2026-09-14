import { db } from "@/lib/db";
import { countActiveWatches, listActiveWatches } from "@/lib/watch";
import { getWatchLimits, isCrawlessMode } from "@/lib/policy";
import { formatRelativeFromNow } from "@/lib/format";
import { AppHeader } from "@/components/AppHeader";
import { WatchList, type WatchRow } from "@/components/WatchList";
import { ManualPriceForm } from "@/components/ManualPriceForm";

// 가격 추적 — docs/05. 등록·해제와 작년 BF 가격 수동 입력. DB만 읽는다.
export const dynamic = "force-dynamic";

export default async function WatchPage() {
  const now = new Date();
  const [items, activeCount, limits, crawless, products] = await Promise.all([
    listActiveWatches(now),
    countActiveWatches(now),
    getWatchLimits(),
    isCrawlessMode(),
    db.product.findMany({ orderBy: { capturedAt: "desc" }, take: 200 }),
  ]);

  // 상품별 마지막 스냅샷 — 목록에 N+1 쿼리를 돌리지 않는다.
  const latest = await db.priceSnapshot.groupBy({
    by: ["productId"],
    where: { productId: { in: items.map((i) => i.productId) } },
    _max: { capturedAt: true },
  });
  const lastByProduct = new Map(latest.map((r) => [r.productId, r._max.capturedAt]));

  const rows: WatchRow[] = items.map((item) => {
    const last = lastByProduct.get(item.productId) ?? null;
    return {
      productId: item.productId,
      brand: item.product.brandName,
      productName: item.product.productName,
      lastSnapshotLabel: last ? formatRelativeFromNow(last, now) : null,
    };
  });

  return (
    <>
      <AppHeader current="/watch" />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-5">
        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">
              📋 지켜보는 중 <span className="text-muted">({activeCount}/{limits.itemsMax})</span>
            </h2>
          </div>
          <p className="text-xs text-muted">
            {crawless
              ? "자동 수집은 하지 않습니다 — 대시보드 상단의 “오늘 기록할 상품”을 보고 다시 찍어 올리면 그때마다 기록됩니다. 자동으로 끝나지 않으니 그만 볼 상품은 해제하세요."
              : "하루 1회 가격을 기록합니다 (행사 기간에는 2회). 자동으로 끝나지 않으니 그만 볼 상품은 해제하세요."}
          </p>
          <WatchList rows={rows} />
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-1 text-sm font-semibold">💾 작년 BF 가격 수동 입력</h2>
          <p className="mb-3 text-xs text-muted">
            자동으로는 복원할 수 없는 2025 블프 가격을 기록해 두면 올해 BF 카드에 “작년 vs 올해”가 나옵니다.
          </p>
          <ManualPriceForm
            products={products.map((p) => ({ id: p.id, label: `${p.brandName} · ${p.productName}` }))}
          />
        </section>
      </main>
    </>
  );
}
