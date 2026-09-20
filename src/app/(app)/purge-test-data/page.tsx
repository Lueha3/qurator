import { planPurge } from "@/lib/purge-screenshot-data";
import { PageHeader } from "@/components/PageHeader";
import { PurgeConfirmButton } from "@/components/PurgeConfirmButton";

// 스크린샷 테스트 데이터 1회용 삭제 화면 — 2026-09-20.
//
// 의도적으로 어디에도 링크를 안 걸었다(홈·설정 어느 메뉴에도 없음). 주소를 직접 쳐야만
// 닿는다 — 지우는 힘이 너무 커서, 실사용자(현표)가 설정 탭을 훑다가 우연히 누르면 안 된다.
// 사용 뒤에는 이 라우트 자체를 지울 예정이다(src/lib/purge-screenshot-data.ts 로직은 남겨도
// 된다 — 위험한 건 "링크 달린 진입점"이지 로직 자체가 아니다).
export const dynamic = "force-dynamic";

export default async function PurgeTestDataPage() {
  const plan = await planPurge();

  return (
    <>
      <PageHeader
        title="테스트 데이터 삭제"
        subtitle="스크린샷으로 만들어진 상품·딜·가격기록을 전부 지워요. 링크된 메뉴가 없는 1회용 화면이에요."
      />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 pb-6 pt-2">
        {plan.productCount === 0 ? (
          <p className="text-sm text-ink-soft">지울 스크린샷 테스트 데이터가 없어요.</p>
        ) : (
          <>
            <section className="card p-4">
              <h3 className="mb-2 text-sm font-semibold">지워질 것</h3>
              <ul className="flex flex-col gap-1 text-sm text-ink-soft">
                <li>상품 {plan.productCount}개</li>
                <li>딜 {plan.dealCount}개</li>
                <li>가격 기록 {plan.priceSnapshotCount}건</li>
                <li>지켜보는 중 {plan.watchItemCount}건</li>
                <li>큐레이터 링크 {plan.curatorLinkCount}개</li>
                <li>발행 문구 {plan.contentCardCount}개 · 발행 이력 {plan.postCount}건</li>
                <li>숏링크 {plan.shortLinkCount}개 · 클릭 기록 {plan.clickEventCount}건</li>
              </ul>
            </section>

            <section className="card p-4">
              <h3 className="mb-2 text-sm font-semibold">상품 목록</h3>
              <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto text-xs text-ink-soft">
                {plan.products.map((p, i) => (
                  <li key={i} className="truncate">
                    {p.brandName} · {p.productName} — 딜 {p.dealCount}개
                  </li>
                ))}
              </ul>
            </section>

            <PurgeConfirmButton productCount={plan.productCount} />
          </>
        )}
      </main>
    </>
  );
}
