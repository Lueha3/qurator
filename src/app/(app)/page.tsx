import Link from "next/link";
import { loadDeals } from "@/lib/deal-list";
import { loadDeadLinkAlerts } from "@/lib/dashboard";
import { dueForReminder } from "@/lib/watch-remind";
import { cheaperWatchedProducts } from "@/lib/price-drop";
import { isCrawlessMode } from "@/lib/policy";
import { formatKRW, formatRelativeFromNow } from "@/lib/format";
import { loadStats } from "@/lib/stats";
import { STAGE_DOT, STAGE_FILTER, TODO_LABEL, TODO_STAGES } from "@/lib/deal-stage";
import { PageHeader } from "@/components/PageHeader";
import { CopyPane } from "@/components/CopyPane";
import { StatTile } from "@/components/StatTile";
import { DealListRow } from "@/components/DealListRow";
import { emptyCls } from "@/components/form";

// 홈 — docs/08 §3.3. 열면 3초 안에 "지금 할 일"이 보이는 것이 이 화면의 전부다.
// 할 일이 없으면 그 블록 자체를 그리지 않는다(없는 데이터를 그리지 않는다 — PriceStrip과 같은 원칙).
// DB만 읽는다. 새로고침이 무신사 요청을 만들지 않는 것이 불변식이다.
//
// V4 (docs/08 §4.0.7): 할 일은 **한 카드**다. 단계별 딜(문구 받기·링크 붙이기·올릴지 정하기)뿐 아니라
// "다시 찍을 상품"과 "품절 안내 올리기"도 같은 카드의 한 줄이다 — docs/08 §3.2가 처음부터 넷을 한 자리에
// 두라고 했는데 V3까지는 세 덩어리로 흩어져 있었다. 품절 안내는 복사 패널이 필요해 아래 블록으로 내려가고,
// 할 일 카드의 줄은 그 블록으로 앵커된다.
export const dynamic = "force-dynamic";

const HEALTH_LABEL = { SOLDOUT: "품절", DEAD: "상품 페이지 없음", COUPON_EXPIRED: "쿠폰 종료" } as const;
/** 안내문이 사유별로 다르므로 복사 버튼 이름도 그 사유를 말한다 (docs/08 §4.0.7) */
/** 홈은 "지금 할 일"만 보여주는 화면이다 — 싸진 상품이 40개여도 40줄을 깔지 않는다 */
const DROPS_SHOWN = 5;

const NOTICE_LABEL = {
  SOLDOUT: "📋 품절 안내 복사",
  DEAD: "📋 판매 종료 안내 복사",
  COUPON_EXPIRED: "📋 쿠폰 종료 안내 복사",
} as const;

export default async function HomePage() {
  const now = new Date();
  const [deals, crawless, deadLinks, stats, drops] = await Promise.all([
    loadDeals(now),
    isCrawlessMode(),
    loadDeadLinkAlerts(),
    loadStats(7, now),
    cheaperWatchedProducts(now),
  ]);
  const reminders = crawless ? await dueForReminder(now) : [];

  const todo: { key: string; href: string; dot: string | null; label: string; count: number }[] = TODO_STAGES.map(
    (stage) => ({
      key: stage,
      href: `/deals?f=${STAGE_FILTER[stage]}`,
      dot: STAGE_DOT[stage],
      label: TODO_LABEL[stage],
      count: deals.filter((d) => d.approvalStage === stage).length,
    })
  ).filter((item) => item.count > 0);
  if (drops.length > 0) {
    todo.push({ key: "drops", href: "#drops", dot: "bg-stage-approved", label: "싸진 상품 보기", count: drops.length });
  }
  if (reminders.length > 0) {
    todo.push({ key: "reshoot", href: "/deals?f=saved", dot: "bg-stage-awaiting", label: "다시 찍어 올릴 상품", count: reminders.length });
  }
  if (deadLinks.length > 0) {
    todo.push({ key: "soldout", href: "#soldout", dot: "bg-danger", label: deadLinks.every((a) => a.health === "SOLDOUT") ? "품절 안내 올리기" : "안내 올리기", count: deadLinks.length });
  }

  const recent = deals.slice(0, 5);
  const empty = deals.length === 0;

  return (
    <>
      <PageHeader title="qurator" subtitle={empty ? undefined : "지금 할 일이에요."} />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-7 px-4 pb-6 pt-2">
        {empty ? (
          <p className={emptyCls}>
            아직 올린 딜이 없어요.
            <br />
            오른쪽 아래 📷 올리기로 시작해보세요.
          </p>
        ) : (
          <>
            {todo.length > 0 && (
              <section className="flex flex-col gap-2">
                <h2 className="text-[13px] font-medium text-ink-soft">오늘 할 일 <span className="text-ink-faint">· 금방 끝나는 것부터</span></h2>
                <div className="card divide-y divide-line">
                  {todo.map((item) => (
                    <Link
                      key={item.key}
                      href={item.href}
                      className="flex items-center gap-3 px-4 py-3.5 transition-colors active:bg-paper"
                    >
                      <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${item.dot ?? ""}`} />
                      <span className="flex-1 text-[15px] font-medium">{item.label}</span>
                      <span className="text-[17px] font-semibold tabular-nums text-accent">{item.count}</span>
                      <span aria-hidden className="text-ink-faint">›</span>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {drops.length > 0 && (
              <section id="drops" className="flex flex-col gap-2 scroll-mt-20">
                <h2 className="text-[13px] font-medium text-ink-soft">
                  📉 싸진 상품 <span className="text-ink-faint">· 지난번보다 내렸어요</span>
                </h2>
                <ul className="card divide-y divide-line">
                  {drops.slice(0, DROPS_SHOWN).map((drop) => (
                    <li key={drop.productId}>
                      <Link
                        href="/deals?f=saved"
                        className="flex items-center gap-3 px-4 py-3 transition-colors active:bg-paper"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] leading-4 text-ink-soft">{drop.brandName}</span>
                          <span className="block truncate text-[15px] font-semibold leading-snug">{drop.productName}</span>
                          <span className="block text-sm">
                            <span className="text-xs text-ink-soft line-through">{formatKRW(drop.from)}</span>{" "}
                            <span className="font-semibold">{formatKRW(drop.to)}</span>
                          </span>
                        </span>
                        <span className="shrink-0 rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-bold leading-4 text-accent-ink">
                          {drop.rate}%
                        </span>
                        <span aria-hidden className="text-ink-faint">›</span>
                      </Link>
                    </li>
                  ))}
                </ul>
                {drops.length > DROPS_SHOWN && (
                  <Link href="/deals?f=saved" className="px-1 text-xs font-medium text-accent">
                    {drops.length - DROPS_SHOWN}개 더 보기
                  </Link>
                )}
              </section>
            )}

            {deadLinks.length > 0 && (
              <section id="soldout" className="flex flex-col gap-2 scroll-mt-20">
                <h2 className="text-[13px] font-medium text-danger">
                  {deadLinks.every((a) => a.health === "SOLDOUT") ? "품절됐어요" : "링크가 막혔어요"} — 카톡에 알려주세요
                </h2>
                {deadLinks.map((alert) => (
                  <div key={alert.dealId} className="card border-l-[3px] border-danger p-4">
                    <p className="text-[15px] font-semibold">{alert.productName}</p>
                    <p className="text-xs text-ink-soft">
                      {alert.brand}
                      {alert.confirmedAt && ` · ${formatRelativeFromNow(alert.confirmedAt, now)}`} {HEALTH_LABEL[alert.health]}로 표시함
                    </p>
                    <p className="mb-3 mt-1 text-xs text-ink-soft">
                      팔로워 페이지에서 내렸어요. 보낸 링크는 안내 화면으로 바뀌어요.
                    </p>
                    <CopyPane text={alert.correction} label={NOTICE_LABEL[alert.health]} />
                  </div>
                ))}
              </section>
            )}

            <section className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between">
                <h2 className="text-[13px] font-medium text-ink-soft">
                  7일 성과 <span className="text-ink-faint">· 지난주 대비</span>
                </h2>
                <Link href="/stats" className="text-xs font-medium text-accent">
                  더 보기
                </Link>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <StatTile label="링크 클릭" value={stats.clicks.value} prev={stats.clicks.prev} href="/stats" />
                <StatTile label="문구 복사" value={stats.posts.value} prev={stats.posts.prev} href="/stats" />
                <StatTile label="팔로워 방문" value={stats.hubVisits.value} prev={stats.hubVisits.prev} href="/stats" />
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between">
                <h2 className="text-[13px] font-medium text-ink-soft">최근 올린 딜</h2>
                <Link href="/deals" className="text-xs font-medium text-accent">
                  전체 보기
                </Link>
              </div>
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
            </section>
          </>
        )}
      </main>
    </>
  );
}
