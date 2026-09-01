import { db } from "@/lib/db";
import { DEAL_INCLUDE, toDealDTO } from "@/lib/deal-dto";
import { buildPriceAnalyses } from "@/lib/price-analysis";
import { DealWorkspace } from "@/components/DealWorkspace";

// DB를 직접 읽는 페이지라 Next.js의 정적 프리렌더링 대상이 될 수 있다(빌드 시점 딜 목록이
// 영구 고정되는 사고). 매 요청 렌더를 강제한다.
export const dynamic = "force-dynamic";

export default async function Home() {
  const deals = await db.deal.findMany({
    include: DEAL_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  // 가격 이력은 상품 단위다 — 딜마다 쿼리하지 않고 한 번에 읽어 묶는다 (docs/05 §4.6).
  // 이 페이지는 DB만 읽는다. 새로고침이 무신사 요청을 만들지 않는 것이 불변식이다.
  const analyses = await buildPriceAnalyses([...new Set(deals.map((d) => d.productId))]);

  return (
    <>
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold">qurator · Phase 0</h1>
            <p className="text-xs text-muted">
              재입력 4~5회 → 0회. 상품 정보 한 번 입력하면 고지문 포함 4채널 카드가 나옵니다.
            </p>
          </div>
          <span className="rounded-full border border-line px-3 py-1 text-xs text-muted">
            외부 API 0개 · 계정 자격증명 0개
          </span>
        </div>
      </header>
      <main className="flex-1">
        <DealWorkspace
          initialDeals={deals.map((deal) => toDealDTO(deal, analyses.get(deal.productId)))}
        />
      </main>
    </>
  );
}
