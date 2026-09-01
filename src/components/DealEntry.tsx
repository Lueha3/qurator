import { DealCard } from "./DealCard";
import { PriceStrip } from "./PriceStrip";
import { formatKRW, formatShortDateTime } from "@/lib/format";
import type { DealDTO } from "@/lib/api-types";

export function DealEntry({ deal }: { deal: DealDTO }) {
  const priceLine =
    deal.salePrice != null && deal.salePrice < deal.listPrice
      ? `${formatKRW(deal.listPrice)} → ${formatKRW(deal.finalPrice ?? deal.salePrice)}${
          deal.discountRate != null ? ` (${deal.discountRate}%)` : ""
        }`
      : formatKRW(deal.listPrice);

  return (
    <div className="rounded-xl border border-line bg-panel/50 p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">
            {deal.brand} · {deal.productName}
            {deal.styleCode ? ` (${deal.styleCode})` : ""}
          </h3>
          <p className="text-sm text-muted">
            {priceLine}
            {deal.couponDesc ? ` · 쿠폰 ${deal.couponDesc}` : ""}
          </p>
        </div>
        <span className="font-mono text-xs text-muted">
          {formatShortDateTime(new Date(deal.createdAt))}
        </span>
      </div>
      {deal.priceHistory && <PriceStrip history={deal.priceHistory} />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {deal.cards.map((card) => (
          <DealCard key={card.id} card={card} />
        ))}
      </div>
    </div>
  );
}
