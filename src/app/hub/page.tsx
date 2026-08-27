import type { Metadata } from "next";
import { db } from "@/lib/db";
import { DISCLOSURE } from "@/lib/disclosure";
import { formatKRW } from "@/lib/format";

// 링크허브 — 링크트리 대체 (docs/02-architecture.md §10.4).
//
// 링크트리 대비 얻는 것: 수동 편집 0, 품절 자동 숨김, 클릭 데이터 소유.
// 현표는 프로필 링크를 여기로 한 번 바꾸면 이후 아무것도 하지 않는다.
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

export default async function HubPage() {
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

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-5 p-5">
      <header className="flex flex-col items-center gap-1 pt-4 text-center">
        <h1 className="text-xl font-semibold">꿀매각 아이템</h1>
        <p className="text-sm text-muted">@{creator?.handle ?? "maison_jenflox"}</p>
      </header>

      {/* 고지는 링크 목록 위에 상시 노출한다 — 개별 항목마다 붙이지 않아도 되도록 지면 상단 고정 */}
      <p className="rounded-lg bg-honey-soft px-4 py-2.5 text-center text-xs text-honey">
        {DISCLOSURE.NOTION}
      </p>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-muted">오늘의 꿀매</h2>
        {deals.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
            지금은 살아있는 딜이 없어요. 곧 새 아이템이 올라옵니다.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {deals.map((deal) => {
              // 쿠폰이 만료됐으면 쿠폰 적용가와 쿠폰 문구를 쓰지 않는다 —
              // 이미 못 받는 할인을 광고하면 소비자 오인 표시가 된다.
              const couponLive =
                deal.couponExpiresAt == null || deal.couponExpiresAt > now;
              const effective =
                (couponLive ? deal.finalPrice : null) ?? deal.salePrice ?? deal.product.listPrice;
              const discounted =
                deal.salePrice != null &&
                deal.product.listPrice > 0 &&
                deal.salePrice < deal.product.listPrice;

              return (
                <li key={deal.id}>
                  {/* next/link가 아니라 순수 <a>를 쓴다: next/link는 뷰포트에 들어온 링크를
                      프로덕션에서 자동 프리페치하고, 그 요청이 /l/{code} 라우트를 실제로 실행시켜
                      누르지도 않은 클릭이 기록되고 커미션 URL로 302가 나간다. */}
                  <a
                    href={`/l/${deal.shortLinks[0].code}`}
                    rel="nofollow noopener"
                    className="flex flex-col gap-1 rounded-lg border border-line bg-panel px-4 py-3 transition-colors hover:border-honey"
                  >
                    <span className="text-sm font-medium">
                      {deal.product.brandName} · {deal.product.productName}
                    </span>
                    <span className="text-xs text-muted">
                      {effective > 0 ? (
                        <>
                          {discounted && (
                            <span className="line-through">
                              {formatKRW(deal.product.listPrice)}{" "}
                            </span>
                          )}
                          <span className="font-medium text-honey">{formatKRW(effective)}</span>
                          {deal.discountRate != null && ` (${deal.discountRate}%)`}
                        </>
                      ) : (
                        "가격은 링크에서 확인"
                      )}
                      {couponLive && deal.couponDesc && ` · 쿠폰 ${deal.couponDesc}`}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {creator?.curatorShopUrl && (
        <a
          href={creator.curatorShopUrl}
          rel="nofollow noopener"
          className="rounded-lg border border-line px-4 py-3 text-center text-sm hover:border-honey"
        >
          큐레이션 샵 전체 보기
        </a>
      )}

      <footer className="pb-8 text-center text-[11px] text-muted">
        품절되거나 할인이 끝난 상품은 목록에서 자동으로 사라집니다.
      </footer>
    </main>
  );
}
