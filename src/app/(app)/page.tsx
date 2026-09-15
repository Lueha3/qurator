import Link from "next/link";
import { loadDeals } from "@/lib/deal-list";
import { loadDeadLinkAlerts } from "@/lib/dashboard";
import { dueForReminder } from "@/lib/watch-remind";
import { isCrawlessMode } from "@/lib/policy";
import { formatRelativeFromNow } from "@/lib/format";
import { dealPriceLine } from "@/lib/deal-format";
import { loadStats } from "@/lib/stats";
import { PageHeader } from "@/components/PageHeader";
import { CopyPane } from "@/components/CopyPane";
import { StatTile } from "@/components/StatTile";

// 홈 — docs/08 §3.3. 열면 3초 안에 "지금 할 일"이 보이는 것이 이 화면의 전부다.
// 할 일이 없으면 그 블록 자체를 그리지 않는다(없는 데이터를 그리지 않는다 — PriceStrip과 같은 원칙).
// DB만 읽는다. 새로고침이 무신사 요청을 만들지 않는 것이 불변식이다.
export const dynamic = "force-dynamic";

const HEALTH_LABEL = { SOLDOUT: "품절", DEAD: "상품 페이지 없음", COUPON_EXPIRED: "쿠폰 만료" } as const;

export default async function HomePage() {
  const now = new Date();
  const [deals, crawless, deadLinks, stats] = await Promise.all([
    loadDeals(now),
    isCrawlessMode(),
    loadDeadLinkAlerts(),
    loadStats(7, now),
  ]);
  const reminders = crawless ? await dueForReminder(now) : [];

  const todo = [
    { href: "/deals?f=ready", label: "승인 대기", count: deals.filter((d) => d.approvalStage === "READY_TO_PUBLISH").length },
    { href: "/deals?f=awaiting", label: "링크 대기", count: deals.filter((d) => d.approvalStage === "AWAITING_LINK").length },
    { href: "/deals?f=candidate", label: "후보", count: deals.filter((d) => d.approvalStage === "CANDIDATE").length },
  ].filter((item) => item.count > 0);

  const recent = deals.slice(0, 5);

  return (
    <>
      <PageHeader title="qurator" subtitle="오른쪽 아래 [📷 올리기]로 스크린샷을 올리면 가격이 기록됩니다" />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-5">
        {todo.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-muted">오늘 할 일</h2>
            <div className="grid grid-cols-3 gap-2">
              {todo.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-xl border border-line bg-panel px-3 py-3 transition-colors hover:border-honey"
                >
                  <div className="text-xl font-semibold text-honey">{item.count}</div>
                  <div className="text-xs text-muted">{item.label}</div>
                </Link>
              ))}
            </div>
          </section>
        )}

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

        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-muted">지난 7일</h2>
            <Link href="/stats" className="text-xs font-medium text-honey hover:underline">
              성과 보기
            </Link>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <StatTile label="클릭" value={stats.clicks.value} prev={stats.clicks.prev} href="/stats" />
            <StatTile label="발행" value={stats.posts.value} prev={stats.posts.prev} href="/stats" />
            <StatTile label="허브 방문" value={stats.hubVisits.value} prev={stats.hubVisits.prev} href="/stats" />
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-muted">최근 캡처</h2>
            <Link href="/deals" className="text-xs font-medium text-honey hover:underline">
              전체 보기
            </Link>
          </div>
          {recent.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">
              아직 딜이 없습니다. 무신사 앱에서 상품 화면을 찍고 [📷 올리기]로 올려보세요.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {recent.map((deal) => (
                <li key={deal.id}>
                  <Link
                    href={`/deals?d=${deal.id}`}
                    className="flex items-start gap-3 rounded-xl border border-line bg-panel px-3.5 py-3 transition-colors hover:border-honey"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {deal.brand} · {deal.productName}
                      </div>
                      <div className="truncate text-sm text-muted">{dealPriceLine(deal)}</div>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted">
                      {formatRelativeFromNow(new Date(deal.createdAt), now)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
