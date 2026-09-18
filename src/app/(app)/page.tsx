import Link from "next/link";
import { loadDeals } from "@/lib/deal-list";
import { loadDeadLinkAlerts } from "@/lib/dashboard";
import { dueForReminder } from "@/lib/watch-remind";
import { isCrawlessMode } from "@/lib/policy";
import { formatRelativeFromNow } from "@/lib/format";
import { loadStats } from "@/lib/stats";
import { STAGE_DOT, STAGE_FILTER, STAGE_LABEL, TODO_STAGES } from "@/lib/deal-stage";
import { PageHeader } from "@/components/PageHeader";
import { CopyPane } from "@/components/CopyPane";
import { StatTile } from "@/components/StatTile";
import { DealListRow } from "@/components/DealListRow";

// 홈 — docs/08 §3.3. 열면 3초 안에 "지금 할 일"이 보이는 것이 이 화면의 전부다.
// 할 일이 없으면 그 블록 자체를 그리지 않는다(없는 데이터를 그리지 않는다 — PriceStrip과 같은 원칙).
// DB만 읽는다. 새로고침이 무신사 요청을 만들지 않는 것이 불변식이다.
//
// V3 (docs/08 §4.0.6): 위계를 하나로 모았다. "오늘 할 일"만 크고, 나머지는 작다.
// 3칸 타일이 아니라 한 카드 안의 세 줄이다 — 390px에서 3칸은 숫자와 이름이 서로를 밀어냈다.
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

  const todo = TODO_STAGES.map((stage) => ({
    stage,
    href: `/deals?f=${STAGE_FILTER[stage]}`,
    label: STAGE_LABEL[stage],
    count: deals.filter((d) => d.approvalStage === stage).length,
  })).filter((item) => item.count > 0);

  const recent = deals.slice(0, 5);
  const empty = deals.length === 0;

  return (
    <>
      <PageHeader
        title="qurator"
        subtitle={empty ? "오른쪽 아래 올리기 버튼으로 스크린샷을 올리면 가격이 기록됩니다" : undefined}
      />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-7 px-4 pb-6 pt-2">
        {todo.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] font-medium text-muted">오늘 할 일</h2>
            <div className="card divide-y divide-line">
              {todo.map((item) => (
                <Link
                  key={item.stage}
                  href={item.href}
                  className="flex items-center gap-3 px-4 py-3.5 transition-colors active:bg-background"
                >
                  <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${STAGE_DOT[item.stage]}`} />
                  <span className="flex-1 text-[15px] font-medium">{item.label}</span>
                  <span className="text-[17px] font-semibold tabular-nums text-honey">{item.count}</span>
                  <span aria-hidden className="text-muted">›</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {deadLinks.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] font-medium text-danger">품절 확인 — 카톡에 정정 공지를 올려주세요</h2>
            {deadLinks.map((alert) => (
              <div key={alert.dealId} className="card border-l-[3px] border-danger p-4">
                <p className="text-[15px] font-semibold">{alert.productName}</p>
                <p className="text-xs text-muted">
                  {alert.brand}
                  {alert.priceLabel && ` · ${alert.priceLabel}`} · {HEALTH_LABEL[alert.health]} 확정
                  {alert.confirmedAt && ` · ${formatRelativeFromNow(alert.confirmedAt, now)}`}
                </p>
                <p className="mb-3 mt-1 text-xs text-muted">
                  링크허브에서 내렸고, 이미 나간 링크는 안내 페이지로 갑니다.
                </p>
                <CopyPane text={alert.correction} label="📋 정정 공지 복사" />
              </div>
            ))}
          </section>
        )}

        {reminders.length > 0 && (
          <section className="rounded-2xl border-l-[3px] border-honey bg-honey-soft/70 px-4 py-3.5">
            <h2 className="text-[15px] font-semibold text-honey">오늘 가격을 기록할 상품 {reminders.length}개</h2>
            <p className="mb-2.5 text-xs text-muted">
              무신사 앱에서 열어 다시 찍어 올려주세요 — 올리는 순간 가격이 기록됩니다 (자동 수집은 하지 않습니다).
            </p>
            <ul className="flex flex-col gap-1.5 text-sm">
              {reminders.map((item) => (
                <li key={item.productId} className="flex items-baseline justify-between gap-3">
                  <span className="truncate">
                    <span className="text-muted">{item.brandName} · </span>
                    <span className="font-medium">{item.productName}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted">
                    {item.lastSnapshotAt ? `마지막 기록 ${formatRelativeFromNow(item.lastSnapshotAt, now)}` : "아직 기록 없음"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[13px] font-medium text-muted">지난 7일</h2>
            <Link href="/stats" className="text-xs font-medium text-honey">
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
            <h2 className="text-[13px] font-medium text-muted">최근 캡처</h2>
            <Link href="/deals" className="text-xs font-medium text-honey">
              전체 보기
            </Link>
          </div>
          {recent.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line-strong/50 p-8 text-center text-sm text-muted">
              아직 딜이 없습니다. 무신사 앱에서 상품 화면을 찍고 [📷 올리기]로 올려보세요.
            </p>
          ) : (
            <ul className="card divide-y divide-line">
              {recent.map((deal) => (
                <li key={deal.id}>
                  <DealListRow
                    deal={deal}
                    href={`/deals?d=${deal.id}`}
                    trailing={formatRelativeFromNow(new Date(deal.createdAt), now)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
