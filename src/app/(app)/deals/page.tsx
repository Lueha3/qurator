import { db } from "@/lib/db";
import { loadDeals } from "@/lib/deal-list";
import { PageHeader } from "@/components/PageHeader";
import { DealBrowser, type DealFilter } from "@/components/DealBrowser";

// 딜 탭 — docs/08 §3.3. 찾기(행)와 하기(시트)를 분리한 목록.
// DB만 읽는다 — 페이지뷰가 무신사 요청을 만들지 않는다.
export const dynamic = "force-dynamic";

const FILTER_KEYS: DealFilter[] = [
  "all",
  "candidate",
  "awaiting",
  "ready",
  "saved",
  "approved",
  "skipped",
  "archived",
];

function parseFilter(raw: string | string[] | undefined): DealFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return FILTER_KEYS.find((k) => k === value) ?? "all";
}

export default async function DealsPage({ searchParams }: PageProps<"/deals">) {
  const now = new Date();
  const [params, deals, creator] = await Promise.all([
    searchParams,
    loadDeals(now),
    db.creator.findFirst(),
  ]);

  const rawDealId = Array.isArray(params.d) ? params.d[0] : params.d;
  // 존재하지 않는 id로 들어오면(오래된 링크·삭제된 딜) 빈 시트를 열지 않고 목록만 보여준다.
  const initialDealId = rawDealId && deals.some((d) => d.id === rawDealId) ? rawDealId : null;

  return (
    <>
      <PageHeader title="딜" />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pb-6 pt-2">
        <DealBrowser
          deals={deals}
          curatorShopUrl={creator?.curatorShopUrl ?? null}
          initialFilter={parseFilter(params.f)}
          initialDealId={initialDealId}
          nowIso={now.toISOString()}
        />
      </main>
    </>
  );
}
