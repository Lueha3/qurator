import type { Metadata } from "next";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { DISCLOSURE } from "@/lib/disclosure";
import { formatKRW } from "@/lib/format";
import { classifyUserAgent } from "@/lib/shortlink";
import { parseTags } from "@/lib/deal-tags";
import { buildHubBadges, type HubBadge } from "@/lib/hub-badge";
import { BrandMark } from "@/components/BrandMark";

// 링크허브 — 링크트리 대체 (docs/02-architecture.md §10.4, docs/08 §3.3 허브 v2).
//
// 링크트리 대비 얻는 것: 수동 편집 0, 품절 자동 숨김, 클릭 데이터 소유.
// 현표는 프로필 링크를 여기로 한 번 바꾸면 이후 아무것도 하지 않는다.
//
// v2에서 더해진 것(2026-09-15): 한 줄 소개, 태그 섹션, 배지 1개.
// 배지는 우리가 이미 가진 것(가격 스냅샷·쿠폰 마감)만으로 계산한다 — 무신사 요청 0건 그대로다.
//
// 공개 페이지다(팔로워가 클릭해야 하므로 미들웨어 인증 예외). 대신:
//   - noindex/nofollow — 검색봇이 커미션 링크를 따라가 실적을 오염시키면 안 된다.
//     사람이 프로필에서 눌러 들어오는 지면이라 SEO가 필요 없고, 봇 차단이 순이익이다.
//   - 모든 아웃바운드는 숏링크 경유 → 클릭 계측 + 품절 시 일괄 구제
//   - 상시 고지 배너 (docs/03 §10)

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "꿀매각 아이템",
  robots: { index: false, follow: false },
};

const UNTAGGED = "오늘의 꿀매";

const BADGE_CLASS: Record<HubBadge["kind"], string> = {
  coupon: "bg-danger/10 text-danger",
  lowest: "bg-honey text-accent-ink",
  drop: "bg-honey-soft text-honey",
};

/**
 * 방문 기록 — 성과 탭의 "방문 대비 클릭"(CTR) 분모다.
 * ClickEvent와 같은 규율: IP·referer를 저장하지 않고 봇 분류만 남긴다.
 * 기록에 실패해도 페이지는 그대로 그린다 — 팔로워에게 링크를 보여주는 것이 먼저다.
 */
async function recordVisit(): Promise<void> {
  try {
    const uaClass = classifyUserAgent((await headers()).get("user-agent"));
    await db.hubVisit.create({ data: { uaClass } });
  } catch (err) {
    console.error("[hub] 방문 기록 실패", err);
  }
}

export default async function HubPage() {
  await recordVisit();
  const creator = await db.creator.findFirst();
  const now = new Date();

  // 살아있는 링크가 있는 발행 딜만 노출한다 — 죽은 링크는 자동으로 사라진다(수동 편집 0).
  // endsAt도 함께 본다: 렌더러는 마감 지난 딜의 렌더를 거부하는데(renderer.ts 'EXPIRED')
  // 허브만 계속 노출하면 "할인이 끝난 상품은 자동으로 사라집니다"라는 이 페이지의 약속이 거짓이 된다.
  const deals = await db.deal.findMany({
    where: {
      status: "PUBLISHED",
      curatorLinks: { some: { health: { in: ["OK", "UNCHECKED"] } } },
      shortLinks: { some: { state: "ACTIVE", surface: "hub" } },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
    include: {
      product: true,
      shortLinks: { where: { state: "ACTIVE", surface: "hub" }, take: 1 },
    },
    orderBy: { updatedAt: "desc" },
    take: 40,
  });

  const badges = await buildHubBadges(deals, now);

  // 태그 = 섹션. 태그가 여러 개면 그 딜은 각 섹션에 함께 걸린다(컬렉션과 같은 뜻).
  // 태그가 하나도 없으면 지금까지처럼 "오늘의 꿀매" 한 섹션만 그려진다.
  const sections = new Map<string, typeof deals>();
  for (const deal of deals) {
    const tags = parseTags(deal.tags);
    for (const key of tags.length > 0 ? tags : [UNTAGGED]) {
      const list = sections.get(key);
      if (list) list.push(deal);
      else sections.set(key, [deal]);
    }
  }
  // 묶어둔 섹션이 먼저, 나머지("오늘의 꿀매")가 마지막.
  const ordered = [...sections.entries()].sort(([a], [b]) =>
    a === UNTAGGED ? 1 : b === UNTAGGED ? -1 : 0
  );
  const hasLowestBadge = [...badges.values()].some((b) => b.kind === "lowest");

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-5 p-5">
      <header className="flex flex-col items-center gap-1 pt-4 text-center">
        <h1 className="text-[22px] font-semibold tracking-tight">꿀매각 아이템</h1>
        <p className="text-sm text-muted">@{creator?.handle ?? "maison_jenflox"}</p>
        {creator?.bio && <p className="mt-1 text-sm">{creator.bio}</p>}
      </header>

      {/* 고지는 링크 목록 위에 상시 노출한다 — 개별 항목마다 붙이지 않아도 되도록 지면 상단 고정 */}
      <p className="rounded-lg bg-honey-soft px-4 py-2.5 text-center text-xs text-honey">
        {DISCLOSURE.NOTION}
      </p>

      {deals.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
          지금은 살아있는 딜이 없어요. 곧 새 아이템이 올라옵니다.
        </p>
      ) : (
        ordered.map(([title, rows]) => (
          <section key={title} className="flex flex-col gap-2">
            <h2 className="px-1 text-[13px] font-medium text-muted">{title}</h2>
            <ul className="card divide-y divide-line">
              {rows.map((deal) => {
                // 쿠폰이 만료됐으면 쿠폰 적용가와 쿠폰 문구를 쓰지 않는다 —
                // 이미 못 받는 할인을 광고하면 소비자 오인 표시가 된다.
                const couponLive = deal.couponExpiresAt == null || deal.couponExpiresAt > now;
                const effective =
                  (couponLive ? deal.finalPrice : null) ?? deal.salePrice ?? deal.product.listPrice;
                const discounted =
                  deal.salePrice != null &&
                  deal.product.listPrice > 0 &&
                  deal.salePrice < deal.product.listPrice;
                const badge = badges.get(deal.id);

                return (
                  <li key={`${title}-${deal.id}`}>
                    {/* next/link가 아니라 순수 <a>를 쓴다: next/link는 뷰포트에 들어온 링크를
                        프로덕션에서 자동 프리페치하고, 그 요청이 /l/{code} 라우트를 실제로 실행시켜
                        누르지도 않은 클릭이 기록되고 커미션 URL로 302가 나간다. */}
                    <a
                      href={`/l/${deal.shortLinks[0].code}`}
                      rel="nofollow noopener"
                      className="flex items-start gap-3 px-3.5 py-3 transition-colors active:bg-background"
                    >
                      <BrandMark brand={deal.product.brandName} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-center gap-1.5 text-[11px] leading-4 text-muted">
                          <span className="truncate">{deal.product.brandName}</span>
                          {badge && (
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${BADGE_CLASS[badge.kind]}`}
                            >
                              {badge.label}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 text-[15px] font-semibold leading-snug">{deal.product.productName}</span>
                        <span className="mt-1 flex items-baseline gap-1.5 text-sm">
                          {effective > 0 ? (
                            <>
                              <span className="font-semibold">{formatKRW(effective)}</span>
                              {/* 공백을 취소선 밖에 둔다 — 안에 넣으면 취소선이 공백까지 덮어 두 숫자가 붙어 보인다 */}
                              {discounted && (
                                <span className="text-xs text-muted line-through">{formatKRW(deal.product.listPrice)}</span>
                              )}
                            </>
                          ) : (
                            <span className="text-xs text-muted">가격은 링크에서 확인</span>
                          )}
                          {couponLive && deal.couponDesc && (
                            <span className="text-xs text-muted">· 쿠폰 {deal.couponDesc}</span>
                          )}
                        </span>
                      </span>
                      {discounted && deal.discountRate != null && deal.discountRate > 0 && (
                        <span className="shrink-0 rounded-md bg-honey px-1.5 py-0.5 text-[11px] font-bold leading-4 text-accent-ink">
                          {deal.discountRate}%
                        </span>
                      )}
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}

      {creator?.curatorShopUrl && (
        <a
          href={creator.curatorShopUrl}
          rel="nofollow noopener"
          className="card px-4 py-3 text-center text-sm font-medium"
        >
          큐레이션 샵 전체 보기
        </a>
      )}

      <footer className="flex flex-col gap-1 pb-8 text-center text-[11px] text-muted">
        <span>품절되거나 할인이 끝난 상품은 목록에서 바로 내려갑니다.</span>
        {/* 배지가 과장으로 읽히지 않게, 근거의 범위를 말해둔다 */}
        {hasLowestBadge && <span>‘최저가’는 제가 기록해 온 가격 범위 안에서의 최저가입니다.</span>}
      </footer>
    </main>
  );
}
