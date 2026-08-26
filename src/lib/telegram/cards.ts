// 승인 카드 렌더링 — docs/02-architecture.md §6.
//
// 핵심 설계: **카드 1장이 상태 전이한다.** 딜마다 메시지를 새로 보내지 않고 editMessageText로
// 같은 메시지를 갱신한다. 후보 → 링크 대기 → 발행 승인 → 완료가 한 자리에서 일어나므로
// 대화창이 카드로 뒤덮이지 않고, 현표가 "지금 이 딜이 어디까지 왔는지"를 스크롤 없이 본다.

import { COPY_TEXT_LIMIT, escapeHtml, html, type InlineKeyboard } from "./client";
import { formatKRW } from "../format";

/** callback_data 스키마: ASCII 고정. 한글·URL 금지(64바이트 한도). */
export const CB = {
  interested: (dealId: string) => `v1:int:${dealId}`,
  skip: (dealId: string) => `v1:skp:${dealId}`,
  approve: (dealId: string) => `v1:apv:${dealId}`,
  rehook: (dealId: string) => `v1:hok:${dealId}`,
  manual: (dealId: string) => `v1:man:${dealId}`,
  /** 링크 대기 중에 새 상품 URL이 온 경우, 대기를 풀고 새 딜로 진행 */
  newDeal: (dealId: string) => `v1:new:${dealId}`,
} as const;

export type CallbackAction = "int" | "skp" | "apv" | "hok" | "man" | "new";

export function parseCallbackData(
  data: string
): { action: CallbackAction; dealId: string } | null {
  const m = data.match(/^v1:(int|skp|apv|hok|man|new):([0-9a-f-]{36})$/);
  if (!m) return null;
  return { action: m[1] as CallbackAction, dealId: m[2] };
}

export interface CardDeal {
  id: string;
  brand: string;
  productName: string;
  styleCode: string | null;
  listPrice: number;
  salePrice: number | null;
  finalPrice: number | null;
  discountRate: number | null;
  couponDesc: string | null;
  hookLine: string | null;
  /** 'json-ld' | 'opengraph' | 'none' — 얼마나 믿을 만한 정보인지 사람에게 알린다 */
  parseSource: string | null;
  linkCount: number;
  /** 링크 검증에서 걸린 것들 (다른 상품을 가리킴, 커미션 파라미터 없음 등) */
  linkWarnings?: string[];
}

function priceLine(d: CardDeal): string {
  // 가격을 못 읽었을 때 0원을 찍으면 그대로 광고 고지와 함께 오픈채팅에 나갈 수 있다.
  // 사실 필드가 비었다는 것을 사람이 반드시 보게 한다.
  if (!d.listPrice && !d.salePrice && !d.finalPrice) return "⚠️ 가격 미확인 — 직접 입력 필요";

  const effective = d.finalPrice ?? d.salePrice ?? d.listPrice;
  if (d.salePrice != null && d.listPrice > 0 && d.salePrice < d.listPrice) {
    const pct = d.discountRate != null ? ` (${d.discountRate}%)` : "";
    return `${formatKRW(d.listPrice)} → ${formatKRW(effective)}${pct}`;
  }
  return formatKRW(effective || d.listPrice);
}

function header(d: CardDeal): string {
  const style = d.styleCode ? ` · ${d.styleCode}` : "";
  return (
    html`<b>${d.brand}</b> ${d.productName}${style}\n` + escapeHtml(priceLine(d))
  );
}

// ── 상태별 카드 ──────────────────────────────────────────────────────────

/** 1단계: 봇이 URL을 파싱해 띄우는 후보 카드 */
export function candidateCard(d: CardDeal): { text: string; keyboard: InlineKeyboard } {
  const coupon = d.couponDesc ? html`\n쿠폰 ${d.couponDesc}` : "";
  const note =
    d.parseSource === "none"
      ? "\n\n⚠️ 상품 정보를 읽지 못했습니다. [직접 입력]으로 채워주세요."
      : d.parseSource === "opengraph"
        ? "\n\n<i>일부 정보만 읽었습니다 — 승인 전 확인해주세요.</i>"
        : "";

  // 아무 필드도 못 읽었으면 [이거 올릴래]를 내지 않는다 — 빈 딜을 진행시키면
  // "(브랜드 미입력) 0원"이 고지문과 함께 오픈채팅에 나갈 수 있다.
  const canProceed = d.parseSource !== "none";
  const keyboard: InlineKeyboard = canProceed
    ? [
        [
          { text: "✅ 이거 올릴래", callback_data: CB.interested(d.id) },
          { text: "⏭ 스킵", callback_data: CB.skip(d.id) },
        ],
        [{ text: "✏️ 직접 입력", callback_data: CB.manual(d.id) }],
      ]
    : [
        [{ text: "✏️ 직접 입력", callback_data: CB.manual(d.id) }],
        [{ text: "⏭ 스킵", callback_data: CB.skip(d.id) }],
      ];

  return { text: `${header(d)}${coupon}${note}`, keyboard };
}

/** 2단계: 큐레이터센터에서 링크를 만들어 붙여넣기를 기다리는 카드 */
export function awaitingLinkCard(
  d: CardDeal,
  curatorCenterUrl: string
): { text: string; keyboard: InlineKeyboard } {
  return {
    text:
      `${header(d)}\n\n` +
      "📎 <b>큐레이터 링크를 붙여넣어 주세요</b>\n" +
      "<i>큐레이터센터에서 링크를 만든 뒤, 이 대화에 그대로 붙여넣으면 됩니다.</i>",
    keyboard: [
      [{ text: "🔗 큐레이터센터 열기", url: curatorCenterUrl }],
      [{ text: "⏭ 스킵", callback_data: CB.skip(d.id) }],
    ],
  };
}

/** 3단계: 링크 수신 → 카피 미리보기와 함께 최종 승인을 받는 카드 */
export function approvalCard(
  d: CardDeal,
  kakaoPreview: string
): { text: string; keyboard: InlineKeyboard } {
  const hook = d.hookLine
    ? html`\n\n💬 <b>${d.hookLine}</b>`
    : "\n\n<i>훅 문구 없음 — [훅 교체]로 넣을 수 있습니다.</i>";

  // 링크 검증 경고는 승인 버튼 바로 위에 크게 띄운다. 상품명·가격과 링크가 어긋난 채로
  // 발행되면 무신사가 보기엔 링크 스왑 패턴이고, 소비자에게는 기만 표시다.
  const warnings =
    d.linkWarnings && d.linkWarnings.length > 0
      ? "\n\n" + d.linkWarnings.map((w) => `⚠️ ${escapeHtml(w)}`).join("\n")
      : "";

  return {
    // 미리보기는 <pre>로 감싼다: 발행될 내용 그대로를 보여주고(본 것 = 나가는 것),
    // URL이 자동 링크화되지 않아 텔레그램이 큐레이터 링크를 프리뷰용으로 방문하지 않는다.
    text:
      `${header(d)}${hook}${warnings}\n\n` +
      `🔗 링크 ${d.linkCount}개\n\n` +
      `<pre>${escapeHtml(kakaoPreview)}</pre>`,
    keyboard: [
      [{ text: "🚀 승인 — 카톡 문구 받기", callback_data: CB.approve(d.id) }],
      [
        { text: "✏️ 훅 교체", callback_data: CB.rehook(d.id) },
        { text: "⏭ 스킵", callback_data: CB.skip(d.id) },
      ],
    ],
  };
}

/** 4단계: 승인 완료 — 카톡에 붙여넣을 완성 텍스트를 전달 */
export function approvedCard(
  d: CardDeal,
  copyWebviewUrl: string | null
): { text: string; keyboard: InlineKeyboard } {
  const keyboard: InlineKeyboard = [];
  if (copyWebviewUrl) {
    keyboard.push([{ text: "🌐 전체 보기 · 복사", url: copyWebviewUrl }]);
  }
  return {
    text: `${header(d)}\n\n✅ <b>승인 완료</b> — 아래 메시지를 카톡에 붙여넣으세요.`,
    keyboard,
  };
}

export function skippedCard(d: CardDeal): { text: string; keyboard: InlineKeyboard } {
  return { text: `${header(d)}\n\n⏭ 스킵했습니다.`, keyboard: [] };
}

/**
 * 카톡용 완성 텍스트를 전달하는 후속 메시지.
 * <pre> 코드블록은 텔레그램에서 탭 한 번으로 전체가 복사되고, 줄바꿈·공백이 그대로 보존된다.
 *
 * <pre> 안에서는 HTML 이스케이프만 하면 된다 — MarkdownV2였다면 이스케이프한 백슬래시가
 * 그대로 클립보드에 복사되어 카톡에 깨진 글이 붙었을 것이다(HTML 모드를 택한 이유 중 하나).
 */
export function kakaoDeliveryMessage(
  fullText: string,
  copyWebviewUrl: string | null
): { text: string; keyboard: InlineKeyboard } {
  const keyboard: InlineKeyboard = [];

  // copy_text 버튼은 256자 한도가 있어 카톡 본문 전체는 대부분 담기지 못한다.
  // 들어가는 경우에만 붙인다 — 한도를 넘겨 보내면 메시지 전체가 400으로 실패한다.
  if (fullText.length <= COPY_TEXT_LIMIT) {
    keyboard.push([{ text: "📋 복사", copy_text: { text: fullText } }]);
  }
  if (copyWebviewUrl) {
    keyboard.push([{ text: "🌐 안 되면 여기서 복사", url: copyWebviewUrl }]);
  }

  return { text: `<pre>${escapeHtml(fullText)}</pre>`, keyboard };
}
