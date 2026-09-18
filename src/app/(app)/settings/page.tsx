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
import { BaseUrlWarning } from "@/components/BaseUrlWarning";

// 설정 — docs/08 §3.3. 매일 쓰지는 않지만 있어야 하는 것들을 한곳에 모았다.
//
// 2026-09-18 (docs/08 §4.0.7): 아홉 섹션을 세 묶음으로 나눴다 — 매일 쓰는 것 / 처음 한 번 하는 것 / 가끔 필요한 것.
// 접지는 않는다. 접으면 처음 온 사람이 Face ID 등록을 못 찾는다. 순서와 묶음 제목만으로 훑어볼 수 있게 했다.
export const dynamic = "force-dynamic";

function GroupTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-2 px-1 text-[13px] font-medium text-ink-soft">{children}</h2>;
}

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
      <PageHeader title="설정" subtitle="매일 쓰는 것은 위에, 처음 한 번 하는 것은 아래에 있어요." />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 pb-6 pt-2">
        {/* 설정이 틀리면 Face ID가 조용히 막힌다 — 맨 위에서 알린다 (관리자용) */}
        <BaseUrlWarning />

        <GroupTitle>매일 쓰는 것</GroupTitle>

        <section className="card p-4">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold">👤 프로필</h3>
            <span className="truncate text-sm text-ink-soft">@{creator?.handle ?? "(없음)"}</span>
          </div>
          <ProfileForm bio={creator?.bio ?? null} curatorShopUrl={creator?.curatorShopUrl ?? null} />
        </section>

        <section className="card p-4">
          <h3 className="mb-1 text-sm font-semibold">🛍️ 팔로워 페이지</h3>
          <p className="mb-3 text-xs text-ink-soft">
            인스타나 오픈채팅 프로필 링크를 이 페이지 주소로 두세요. 품절되거나 끝난 딜은 알아서 내려가요.
          </p>
          {/* 공개 페이지라 프리페치로 열리지 않게 순수 <a>로 둔다 */}
          <a
            href="/hub"
            target="_blank"
            rel="noopener"
            className="block rounded-xl border border-line bg-surface px-3 py-2.5 text-center text-sm font-semibold text-ink-soft transition-colors hover:border-accent hover:text-accent"
          >
            팔로워 페이지 열기 ↗
          </a>
        </section>

        <section className="card p-4">
          <h3 className="mb-1 text-sm font-semibold">🔔 아침 알림</h3>
          <p className="mb-3 text-xs text-ink-soft">
            매일 아침 8시, <b>할 일이 있는 날에만</b> 한 통 와요. 상품명·가격·링크는 싣지 않아요.
          </p>
          <PushToggle publicKey={vapidPublicKey} />
        </section>

        <GroupTitle>처음 한 번 하는 것</GroupTitle>

        <section className="card p-4">
          <h3 className="mb-1 text-sm font-semibold">🔐 Face ID 로그인</h3>
          <p className="mb-3 text-xs text-ink-soft">
            등록해두면 주소만 열고 얼굴만 보면 들어와져요. 아이클라우드에 함께 저장돼서
            <b> Safari·홈 화면 앱·맥이 전부 같은 얼굴</b>로 열려요.
          </p>
          <PasskeyManager
            passkeys={passkeys.map((key) => ({
              id: key.id,
              label: key.label,
              createdAt: key.createdAt.toISOString(),
              lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
            }))}
          />
          <p className="mt-2 text-xs text-ink-soft">
            이 폰 것을 지우면 다음엔 Face ID로 못 들어와요. 그래도 관리자가 다시 열어줄 수 있어요.
          </p>
        </section>

        <section className="card p-4">
          <h3 className="mb-1 text-sm font-semibold">📱 다른 폰도 등록하기</h3>
          <p className="mb-3 text-xs text-ink-soft">
            <b>30분 안에 한 번만</b> 쓸 수 있는 등록 링크를 만들어 보내면, 받는 사람이 자기 폰에 Face ID를 등록하고
            바로 들어와요. 접속 암호는 넘어가지 않아요. 받는 사람은 링크를 길게 눌러 <b>‘Safari에서 열기’</b>를 골라야 해요.
          </p>
          <InviteCard
            invites={invites.map((invite) => ({
              id: invite.id,
              note: invite.note,
              expiresAt: invite.expiresAt.toISOString(),
            }))}
          />
        </section>

        <section className="card p-4">
          <h3 className="mb-1 text-sm font-semibold">📱 폰에서 앱처럼 쓰기</h3>
          <p className="text-xs text-ink-soft">
            아이폰 Safari에서 이 주소를 연 뒤 <b>공유 → 홈 화면에 추가</b>를 누르면 주소창 없이 앱처럼 열려요.
            홈 화면 앱과 Safari는 로그인을 따로 기억해요. 둘 다 쓰려면 각각 한 번 Face ID로 들어와 주세요.
          </p>

          {/* 단축어 레시피는 docs/06 §4.5에 있다. 화면에 두면 "접속 암호를 받아 넣어라"는 문장이 되어
              docs/03 §7.2(마스터 토큰은 비개발자에게 넘기지 않는다)와 부딪힌다 — 관리자가 대신 설치한다. */}
          <p className="mt-2 text-xs text-ink-soft">
            <b>단축어</b>를 쓰면 이 앱을 열지 않아도 돼요. 무신사에서 스크린샷 → 공유 → ‘꿀매 올리기’로 끝이에요.
            설치는 <b>관리자가 이 폰에서 직접</b> 해줘요 — 한 번만 부탁하면 돼요.
          </p>
        </section>

        <GroupTitle>가끔 필요한 것</GroupTitle>

        <section className="card p-4">
          <h3 className="mb-1 text-sm font-semibold">
            📈 지켜보는 상품 <span className="font-normal text-ink-soft">({activeWatches}/{limits.itemsMax})</span>
          </h3>
          <p className="text-xs text-ink-soft">
            {crawless
              ? "자동으로 가격을 가져오지는 않아요. 홈의 “다시 찍어 올릴 상품”을 보고 다시 찍어 올리면 그때마다 기록돼요. 그만 볼 상품은 딜 탭 “지켜보는 중”에서 빼주세요."
              : "하루 1회 가격을 기록해요 (행사 기간에는 2회). 그만 볼 상품은 딜 탭 “지켜보는 중”에서 빼주세요."}
          </p>
        </section>

        <section className="card p-4">
          <h3 className="mb-1 text-sm font-semibold">🧹 중복 딜 정리</h3>
          <p className="mb-3 text-xs text-ink-soft">
            예전에는 같은 상품을 다시 찍을 때마다 새 딜이 생겼어요(지금은 있던 딜에 기록돼요). 그때 쌓인 중복을
            한 번에 “안 올림”으로 옮겨요. 지우지 않고, 링크가 붙은 딜은 건드리지 않아요.
          </p>
          <DedupeCard />
        </section>

        <section className="card p-4">
          <h3 className="mb-1 text-sm font-semibold">🗓️ 작년 블프 가격 적어두기</h3>
          <p className="mb-3 text-xs text-ink-soft">
            작년 블프 가격을 적어두면 올해 블프 때 “작년 vs 올해”가 보여요.
          </p>
          <ManualPriceForm
            products={products.map((p) => ({ id: p.id, label: `${p.brandName} · ${p.productName}` }))}
          />
        </section>
      </main>
    </>
  );
}
