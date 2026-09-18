import { db } from "@/lib/db";
import { countActiveWatches } from "@/lib/watch";
import { getWatchLimits, isCrawlessMode } from "@/lib/policy";
import { PageHeader } from "@/components/PageHeader";
import { ManualPriceForm } from "@/components/ManualPriceForm";
import { ProfileForm } from "@/components/ProfileForm";
import { DedupeCard } from "@/components/DedupeCard";
import { PushToggle } from "@/components/PushToggle";
import { pushPublicKey } from "@/lib/push";
import { PasskeyManager } from "@/components/PasskeyManager";
import { listLiveInvites, listPasskeys } from "@/lib/passkey";
import { InviteCard } from "@/components/InviteCard";

// 설정 — docs/08 §3.3. 매일 쓰지는 않지만 있어야 하는 것들을 한곳에 모았다.
// (작년 BF 수동 입력은 원래 /watch 하단에 있었다 — 딜 탭이 목록 전용이 되면서 이리로 옮겼다.)
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const now = new Date();
  const vapidPublicKey = pushPublicKey();
  const [creator, activeWatches, limits, crawless, products, passkeys, invites] = await Promise.all([
    db.creator.findFirst(),
    countActiveWatches(now),
    getWatchLimits(),
    isCrawlessMode(),
    db.product.findMany({ orderBy: { capturedAt: "desc" }, take: 200 }),
    listPasskeys(),
    listLiveInvites(),
  ]);

  return (
    <>
      <PageHeader title="설정" />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-4 py-5">
        <section className="rounded-2xl border border-line bg-panel p-4">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold">프로필</h2>
            <span className="truncate text-sm text-muted">@{creator?.handle ?? "(없음)"}</span>
          </div>
          <ProfileForm bio={creator?.bio ?? null} curatorShopUrl={creator?.curatorShopUrl ?? null} />
        </section>

        <section className="rounded-2xl border border-line bg-panel p-4">
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

        <section className="rounded-2xl border border-line bg-panel p-4">
          <h2 className="mb-1 text-sm font-semibold">
            저장함 <span className="font-normal text-muted">({activeWatches}/{limits.itemsMax})</span>
          </h2>
          <p className="text-xs text-muted">
            {crawless
              ? "자동 수집은 하지 않습니다 — 홈의 “오늘 기록할 상품”을 보고 다시 찍어 올리면 그때마다 기록됩니다. 자동으로 끝나지 않으니 그만 볼 상품은 딜 탭 저장함에서 빼주세요."
              : "하루 1회 가격을 기록합니다 (행사 기간에는 2회). 자동으로 끝나지 않으니 그만 볼 상품은 딜 탭 저장함에서 빼주세요."}
          </p>
        </section>

        <section className="rounded-2xl border border-line bg-panel p-4">
          <h2 className="mb-1 text-sm font-semibold">Face ID 로그인</h2>
          <p className="mb-3 text-xs text-muted">
            등록해두면 주소만 치고 얼굴만 보면 열립니다 — <code className="font-mono">?k=</code> 주소를
            다시 찾을 일이 없습니다. 열쇠는 이 기기 안에서 나가지 않고, 아이클라우드 키체인에 저장되니
            <b> Safari·홈 화면 앱·맥이 전부 같은 얼굴</b>로 열립니다.
          </p>
          <PasskeyManager
            passkeys={passkeys.map((key) => ({
              id: key.id,
              label: key.label,
              createdAt: key.createdAt.toISOString(),
              lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
            }))}
          />
          <p className="mt-2 text-xs text-muted">
            전부 지워도 앱에서 잠기지 않습니다 — <code className="font-mono">?k=</code> 주소가 비상구로
            늘 살아 있습니다.
          </p>
        </section>

        <section className="rounded-2xl border border-line bg-panel p-4">
          <h2 className="mb-1 text-sm font-semibold">다른 사람 기기 등록하기</h2>
          <p className="mb-3 text-xs text-muted">
            30분짜리 <b>1회용 링크</b>를 만들어 보내면, 받는 사람이 자기 폰에 Face ID를 등록하고 바로
            들어옵니다. <b>접속 암호(<code className="font-mono">?k=</code> 토큰)는 넘어가지 않습니다</b> —
            그 링크로는 등록만 됩니다.
          </p>
          <InviteCard
            invites={invites.map((invite) => ({
              id: invite.id,
              note: invite.note,
              expiresAt: invite.expiresAt.toISOString(),
            }))}
          />
        </section>

        <section className="rounded-2xl border border-line bg-panel p-4">
          <h2 className="mb-1 text-sm font-semibold">아침 알림</h2>
          <p className="mb-3 text-xs text-muted">
            매일 아침 8시, <b>할 일이 있는 날에만</b> 한 통 옵니다 — “기록할 상품 3개 · 정정 공지 1건”.
            상품명·가격·링크는 싣지 않습니다(잠금화면은 옆 사람도 봅니다).
          </p>
          <PushToggle publicKey={vapidPublicKey} />
        </section>

        <section className="rounded-2xl border border-line bg-panel p-4">
          <h2 className="mb-1 text-sm font-semibold">중복 카드 정리</h2>
          <p className="mb-3 text-xs text-muted">
            예전에는 같은 상품을 다시 찍을 때마다 새 카드가 생겼습니다(지금은 기존 카드를 갱신합니다).
            그때 쌓인 중복을 한 번에 닫습니다 — 지우지 않고 “기록 완료”로 옮기며, 큐레이터 링크가
            붙은 카드는 건드리지 않습니다.
          </p>
          <DedupeCard />
        </section>

        <section className="rounded-2xl border border-line bg-panel p-4">
          <h2 className="mb-1 text-sm font-semibold">작년 BF 가격 수동 입력</h2>
          <p className="mb-3 text-xs text-muted">
            자동으로는 복원할 수 없는 2025 블프 가격을 기록해 두면 올해 BF 카드에 “작년 vs 올해”가 나옵니다.
          </p>
          <ManualPriceForm
            products={products.map((p) => ({ id: p.id, label: `${p.brandName} · ${p.productName}` }))}
          />
        </section>

        <section className="rounded-2xl border border-line bg-panel p-4">
          <h2 className="mb-1 text-sm font-semibold">폰에서 앱처럼 쓰기</h2>
          <p className="text-xs text-muted">
            아이폰 Safari에서 이 주소를 연 뒤 <b>공유 → 홈 화면에 추가</b>를 누르면 주소창 없이 앱처럼 열립니다.
            로그인은 90일이고 쓸 때마다 갱신되니, 계속 쓰시는 한 다시 하실 일이 없습니다.
          </p>
          <p className="mt-2 text-xs text-muted">
            아이폰은 <b>홈 화면 앱과 Safari가 로그인을 따로 기억합니다.</b> 홈 화면 아이콘으로 쓰시다가
            Safari 주소창에 주소를 치면 막히는 것이 정상입니다 — 두 곳에서 다 쓰시려면 각각 한 번씩{" "}
            <code className="font-mono">?k=</code> 주소로 열어주세요.
          </p>

          {/* 단축어를 쓰면 앱을 여는 탭과 사진첩에서 고르는 탭이 둘 다 사라진다 (docs/06 §4.5) */}
          <details className="mt-3 rounded-lg border border-line">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
              ⚡️ 단축어로 공유 시트에서 바로 올리기
            </summary>
            <div className="flex flex-col gap-2 px-3 pb-3 text-xs leading-relaxed text-muted">
              <p>무신사 앱에서 스크린샷 → 공유 → 단축어 선택. 웹앱을 열 필요가 없습니다.</p>
              <ol className="flex list-decimal flex-col gap-1 pl-4">
                <li>단축어 앱 → 새 단축어 → 이름 “꿀매 올리기”</li>
                <li>
                  <b>이미지 크기 조절</b> 추가 — 입력 <code className="font-mono">단축어 입력</code>, 가장 긴 변{" "}
                  <b>1600</b>px <span className="text-danger">(빼지 마세요 — 원본은 업로드 상한에 걸립니다)</span>
                </li>
                <li>
                  <b>URL 내용 가져오기</b> 추가 — URL <code className="font-mono">{"<이 앱 주소>"}/api/capture</code>, 방식{" "}
                  <b>POST</b>
                </li>
                <li>
                  헤더 <code className="font-mono">x-app-token</code> = Vercel 환경변수의{" "}
                  <code className="font-mono">APP_ACCESS_TOKEN</code> 값
                </li>
                <li>
                  본문 <b>양식</b> → 필드 이름 <code className="font-mono">images</code>, 종류 <b>파일</b>, 값{" "}
                  <b>크기 조절된 이미지</b>
                </li>
                <li>단축어 설정(ⓘ) → “공유 시트에 표시” 켜고 입력 종류는 이미지만</li>
              </ol>
              <p>
                카드는 다음에 이 앱을 열 때 딜 탭 맨 위에 있습니다. 한 상품을 위·아래로 나눠 찍었다면 사진 앱에서{" "}
                <b>두 장을 함께 선택해</b> 공유하세요.
              </p>
            </div>
          </details>
        </section>
      </main>
    </>
  );
}
