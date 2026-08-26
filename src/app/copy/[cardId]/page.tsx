import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { CopyPane } from "@/components/CopyPane";

// 텔레그램 코드블록 탭 복사가 주 경로이고, 이 페이지는 그것이 안 될 때의 폴백 겸 미리보기다
// (iOS 텔레그램은 코드블록 복사 동작이 버전별로 편차가 있다).
// 평범한 URL 버튼으로 열려야 Chrome Custom Tabs / SFSafariViewController가 뜨고 클립보드가 동작한다 —
// 텔레그램 Mini App으로 만들면 클립보드 '쓰기' API가 아예 없다.

export const dynamic = "force-dynamic";

export default async function CopyPage({ params }: { params: Promise<{ cardId: string }> }) {
  const { cardId } = await params;

  const card = await db.contentCard.findUnique({
    where: { id: cardId },
    include: { deal: { include: { product: true } } },
  });

  if (!card) notFound();

  // 고지문 검증에 실패한 카드는 어떤 경로로도 나가지 않는다 (docs/03 §1 불변식 I-3).
  // 복사 웹뷰도 "발행 경로"다 — 여기로 우회해 고지 없는 문구를 퍼뜨릴 수 없어야 한다.
  if (!card.disclosureOk) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <h1 className="text-lg font-semibold text-danger">복사할 수 없는 카드입니다</h1>
        <p className="mt-2 text-sm text-muted">
          공정위 고지문 검증에 실패했습니다. 카드를 다시 생성해 주세요.
        </p>
      </main>
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

      <CopyPane text={card.bodyText} />

      <p className="text-center text-xs text-muted">
        복사가 안 되면 위 상자의 글을 길게 눌러 직접 복사하세요.
      </p>
    </main>
  );
}
