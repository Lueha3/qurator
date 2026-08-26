import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { verifyCardToken } from "@/lib/signed-link";
import { CopyPane } from "@/components/CopyPane";

// 텔레그램 코드블록 탭 복사가 주 경로이고, 이 페이지는 그것이 안 될 때의 폴백 겸 미리보기다
// (iOS 텔레그램은 코드블록 복사 동작이 버전별로 편차가 있다).
// 평범한 URL 버튼으로 열려야 Chrome Custom Tabs / SFSafariViewController가 뜨고 클립보드가 동작한다 —
// 텔레그램 Mini App으로 만들면 클립보드 '쓰기' API가 아예 없다.
//
// 이 경로는 미들웨어의 인증 예외다(세션 쿠키가 없는 텔레그램 인앱 브라우저에서 열리므로).
// 대신 URL에 실린 HMAC 서명 토큰으로 스스로를 방어한다 — 카드 본문에는 커미션 ULID가 들어 있어
// 링크를 아는 누구나 열 수 있으면 안 된다.

export const dynamic = "force-dynamic";

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-lg font-semibold text-danger">{title}</h1>
      <p className="mt-2 text-sm text-muted">{body}</p>
    </main>
  );
}

export default async function CopyPage({ params }: { params: Promise<{ cardId: string }> }) {
  // [cardId] 자리에는 순수 id가 아니라 서명 토큰({id}.{만료}.{서명})이 들어온다.
  const { cardId: token } = await params;

  const checked = verifyCardToken(decodeURIComponent(token));
  if (!checked.ok) {
    if (checked.reason === "expired") {
      return (
        <Notice
          title="링크가 만료되었습니다"
          body="텔레그램에서 카드를 다시 열어 새 링크를 받아주세요."
        />
      );
    }
    notFound();
  }

  const card = await db.contentCard.findUnique({
    where: { id: checked.cardId },
    include: { deal: { include: { product: true } } },
  });

  if (!card) notFound();

  // 고지문 검증에 실패한 카드는 어떤 경로로도 나가지 않는다 (docs/03 §1 불변식 I-3).
  // 복사 웹뷰도 "발행 경로"다 — 여기로 우회해 고지 없는 문구를 퍼뜨릴 수 없어야 한다.
  if (!card.disclosureOk) {
    return (
      <Notice
        title="복사할 수 없는 카드입니다"
        body="공정위 고지문 검증에 실패했습니다. 카드를 다시 생성해 주세요."
      />
    );
  }

  const { deal } = card;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-5 p-5">
      <header>
        <h1 className="text-base font-semibold">
          {deal.product.brandName} · {deal.product.productName}
        </h1>
        <p className="text-xs text-muted">
          카톡 오픈채팅용 · {card.charCount}자
          {card.truncated && " · 글자수 초과로 축약됨"}
        </p>
      </header>

      <CopyPane text={card.bodyText} token={decodeURIComponent(token)} />

      <p className="text-center text-xs text-muted">
        복사가 안 되면 위 상자의 글을 길게 눌러 직접 복사하세요.
      </p>
    </main>
  );
}
