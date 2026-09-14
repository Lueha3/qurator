import { db } from "@/lib/db";
import { DEAL_INCLUDE, toDealDTO } from "@/lib/deal-dto";
import { buildPriceAnalyses } from "@/lib/price-analysis";
import { loadDeadLinkAlerts } from "@/lib/dashboard";
import { dueForReminder } from "@/lib/watch-remind";
import { isCrawlessMode } from "@/lib/policy";
import { formatRelativeFromNow } from "@/lib/format";
import { AppHeader } from "@/components/AppHeader";
import { ScreenshotCapture } from "@/components/ScreenshotCapture";
import { DealStageCard } from "@/components/DealStageCard";
import { CopyPane } from "@/components/CopyPane";
import type { DealDTO } from "@/lib/api-types";

// 웹 콕핏 — docs/02 §6 (2026-09-14: 텔레그램 → 웹). 이 페이지는 DB만 읽는다.
// 새로고침이 무신사 요청을 만들지 않는 것이 불변식이다. 매 요청 렌더를 강제한다.
export const dynamic = "force-dynamic";

const ACTIVE_STAGES: DealDTO["approvalStage"][] = ["CANDIDATE", "AWAITING_LINK", "READY_TO_PUBLISH"];

const HEALTH_LABEL = { SOLDOUT: "품절", DEAD: "상품 페이지 없음", COUPON_EXPIRED: "쿠폰 만료" } as const;

export default async function Home() {
  const now = new Date();
  const [deals, creator, crawless] = await Promise.all([
    db.deal.findMany({ include: DEAL_INCLUDE, orderBy: { createdAt: "desc" }, take: 60 }),
    db.creator.findFirst(),
    isCrawlessMode(),
  ]);
  // 가격 이력은 상품 단위다 — 딜마다 쿼리하지 않고 한 번에 읽어 묶는다 (docs/05 §4.6).
  const [analyses, reminders, deadLinks] = await Promise.all([
    buildPriceAnalyses([...new Set(deals.map((d) => d.productId))], now),
    crawless ? dueForReminder(now) : Promise.resolve([]),
    loadDeadLinkAlerts(),
  ]);

  const dtos = deals.map((deal) => toDealDTO(deal, analyses.get(deal.productId), now));
  const active = dtos.filter((d) => ACTIVE_STAGES.includes(d.approvalStage));
  const approved = dtos.filter((d) => d.approvalStage === "APPROVED");
  const skipped = dtos.filter((d) => d.approvalStage === "SKIPPED");
  const curatorShopUrl = creator?.curatorShopUrl ?? null;

  return (
    <>
      <AppHeader current="/" />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-5">
        <ScreenshotCapture />

        {deadLinks.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-danger">🔴 품절 확인 — 카톡에 정정 공지를 올려주세요</h2>
            {deadLinks.map((alert) => (
              <div key={alert.dealId} className="rounded-xl border border-danger/40 bg-panel p-4">
                <p className="text-sm font-medium">
                  {alert.brand} · {alert.productName}
                  {alert.priceLabel && <span className="text-muted"> · {alert.priceLabel}</span>}
                </p>
                <p className="mb-3 text-xs text-muted">
                  {HEALTH_LABEL[alert.health]} 확정
                  {alert.confirmedAt && ` · ${formatRelativeFromNow(alert.confirmedAt, now)}`} · 링크허브·노션에서는 자동으로 내렸습니다.
                </p>
                <CopyPane text={alert.correction} label="📋 정정 공지 복사" />
              </div>
            ))}
          </section>
        )}

        {reminders.length > 0 && (
          <section className="rounded-xl border border-line bg-honey-soft/60 p-4">
            <h2 className="text-sm font-semibold text-honey">📌 오늘 가격을 기록할 상품 {reminders.length}개</h2>
            <p className="mb-2 text-xs text-muted">
              무신사 앱에서 열어 다시 찍어 올려주세요 — 올리는 순간 가격이 기록됩니다 (자동 수집은 하지 않습니다).
            </p>
            <ul className="flex flex-col gap-1 text-sm">
              {reminders.map((item) => (
                <li key={item.productId} className="flex justify-between gap-2">
                  <span className="truncate">
                    {item.brandName} · {item.productName}
                  </span>
                  <span className="shrink-0 text-xs text-muted">
                    {item.lastSnapshotAt ? `마지막 기록 ${formatRelativeFromNow(item.lastSnapshotAt, now)}` : "아직 기록 없음"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-muted">진행 중 {active.length > 0 && `(${active.length})`}</h2>
          {active.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">
              진행 중인 딜이 없습니다. 스크린샷을 올려 시작하세요.
            </p>
          ) : (
            active.map((deal) => <DealStageCard key={deal.id} deal={deal} curatorShopUrl={curatorShopUrl} />)
          )}
        </section>

        {approved.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-muted">승인 완료 ({approved.length})</h2>
            {approved.map((deal) => (
              <DealStageCard key={deal.id} deal={deal} curatorShopUrl={curatorShopUrl} />
            ))}
          </section>
        )}

        {skipped.length > 0 && (
          <details className="rounded-xl border border-line">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-muted">
              기록 완료 ({skipped.length})
            </summary>
            <div className="flex flex-col gap-3 px-4 pb-4">
              {skipped.map((deal) => (
                <DealStageCard key={deal.id} deal={deal} curatorShopUrl={curatorShopUrl} />
              ))}
            </div>
          </details>
        )}
      </main>
    </>
  );
}
