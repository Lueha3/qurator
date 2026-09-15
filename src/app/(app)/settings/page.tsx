import { db } from "@/lib/db";
import { countActiveWatches } from "@/lib/watch";
import { getWatchLimits, isCrawlessMode } from "@/lib/policy";
import { PageHeader } from "@/components/PageHeader";
import { ManualPriceForm } from "@/components/ManualPriceForm";
import { ProfileForm } from "@/components/ProfileForm";

// 설정 — docs/08 §3.3. 매일 쓰지는 않지만 있어야 하는 것들을 한곳에 모았다.
// (작년 BF 수동 입력은 원래 /watch 하단에 있었다 — 딜 탭이 목록 전용이 되면서 이리로 옮겼다.)
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const now = new Date();
  const [creator, activeWatches, limits, crawless, products] = await Promise.all([
    db.creator.findFirst(),
    countActiveWatches(now),
    getWatchLimits(),
    isCrawlessMode(),
    db.product.findMany({ orderBy: { capturedAt: "desc" }, take: 200 }),
  ]);

  return (
    <>
      <PageHeader title="설정" />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-4 py-5">
        <section className="rounded-xl border border-line bg-panel p-4">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold">프로필</h2>
            <span className="truncate text-sm text-muted">@{creator?.handle ?? "(없음)"}</span>
          </div>
          <ProfileForm bio={creator?.bio ?? null} curatorShopUrl={creator?.curatorShopUrl ?? null} />
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-1 text-sm font-semibold">팔로워가 보는 지면</h2>
          <p className="mb-3 text-xs text-muted">
            프로필 링크를 링크허브로 바꿔두면, 품절·마감된 딜은 자동으로 사라집니다(수동 편집 0).
          </p>
          {/* 공개 페이지라 프리페치로 열리지 않게 순수 <a>로 둔다 */}
          <a
            href="/hub"
            target="_blank"
            rel="noopener"
            className="block rounded-lg border border-line px-3 py-2.5 text-center text-sm font-medium hover:border-honey"
          >
            링크허브 열기 ↗
          </a>
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-1 text-sm font-semibold">
            저장함 <span className="font-normal text-muted">({activeWatches}/{limits.itemsMax})</span>
          </h2>
          <p className="text-xs text-muted">
            {crawless
              ? "자동 수집은 하지 않습니다 — 홈의 “오늘 기록할 상품”을 보고 다시 찍어 올리면 그때마다 기록됩니다. 자동으로 끝나지 않으니 그만 볼 상품은 딜 탭 저장함에서 빼주세요."
              : "하루 1회 가격을 기록합니다 (행사 기간에는 2회). 자동으로 끝나지 않으니 그만 볼 상품은 딜 탭 저장함에서 빼주세요."}
          </p>
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-1 text-sm font-semibold">💾 작년 BF 가격 수동 입력</h2>
          <p className="mb-3 text-xs text-muted">
            자동으로는 복원할 수 없는 2025 블프 가격을 기록해 두면 올해 BF 카드에 “작년 vs 올해”가 나옵니다.
          </p>
          <ManualPriceForm
            products={products.map((p) => ({ id: p.id, label: `${p.brandName} · ${p.productName}` }))}
          />
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-1 text-sm font-semibold">📱 폰에서 앱처럼 쓰기</h2>
          <p className="text-xs text-muted">
            아이폰 Safari에서 이 주소를 연 뒤 <b>공유 → 홈 화면에 추가</b>를 누르면 주소창 없이 앱처럼 열립니다.
            쿠키가 만료되면 <code className="font-mono">?k=</code> 주소로 한 번만 다시 열어주세요.
          </p>
        </section>
      </main>
    </>
  );
}
