import Link from "next/link";
import { db } from "@/lib/db";
import { DISCLOSURE } from "@/lib/disclosure";

// 죽은 링크의 착지 지점 — docs/03-account-safety.md 불변식 I-5.
//
// 이 페이지가 존재하는 이유는 "대안 상품으로 자동 이동시키지 않기 위해서"다.
// 자동 302로 다른 상품의 커미션 링크에 보내면 무신사 로그에서 링크 스왑과 구분되지 않는다.
// 대안은 보여주되, 이동은 반드시 사람의 클릭을 한 번 거친다(클릭 의도의 단절점).

export const dynamic = "force-dynamic";

export default async function ExpiredPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  const link =
    code === "unknown"
      ? null
      : await db.shortLink.findUnique({
          where: { code },
          include: { deal: { include: { product: true } } },
        });

  // 대안 딜: 지금 살아있는 다른 딜 몇 개. 자동 이동이 아니라 목록으로만 제시한다.
  const alternatives = await db.deal.findMany({
    where: {
      status: "PUBLISHED",
      shortLinks: { some: { state: "ACTIVE", surface: "hub" } },
      ...(link ? { NOT: { id: link.dealId } } : {}),
    },
    include: {
      product: true,
      shortLinks: { where: { state: "ACTIVE", surface: "hub" }, take: 1 },
    },
    orderBy: { updatedAt: "desc" },
    take: 5,
  });

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">지금은 살 수 없는 상품이에요</h1>
        <p className="text-sm text-muted">
          {link?.deal.product
            ? `${link.deal.product.brandName} · ${link.deal.product.productName} 은(는) 품절되었거나 할인이 종료됐습니다.`
            : "품절되었거나 할인이 종료된 링크입니다."}
        </p>
      </header>

      {alternatives.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted">지금 살아있는 다른 꿀템</h2>
          <p className="text-xs text-muted">{DISCLOSURE.NOTION}</p>
          <ul className="flex flex-col gap-2">
            {alternatives.map((deal) => (
              <li key={deal.id}>
                <Link
                  href={`/l/${deal.shortLinks[0].code}`}
                  rel="nofollow"
                  className="block rounded-lg border border-line bg-panel px-4 py-3 hover:border-honey"
                >
                  <span className="text-sm font-medium">
                    {deal.product.brandName} · {deal.product.productName}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link href="/hub" className="text-center text-sm text-honey hover:underline">
        전체 목록 보기 →
      </Link>
    </main>
  );
}
