// 텔레그램 업데이트 처리 — Phase 1 상태 머신의 본체.
//
// 흐름 (docs/02-architecture.md §6):
//   URL 던지기 → [후보] --이거 올릴래--> [링크 대기] --링크 붙여넣기--> [발행 승인] --승인--> 카톡 문구 전달
//
// 이 파일은 webhook과 폴링 양쪽에서 같은 함수로 쓰인다(진입 경로만 다르고 처리는 동일).

import { db } from "../db";
import { getDefaultCreator } from "../creator";
import { gatewayFetch } from "../fetch-gateway";
import { canonicalizeMusinsaUrl } from "../url-guard";
import { looksLikeNonProductPage, parseProductPage } from "../product-parser";
import { parseCuratorLink } from "../curator-link";
import { draftHookLine } from "../ai-hook";
import { renderAllChannels, type DealFacts, type DealLink } from "../renderer";
import { audit } from "../audit";
import {
  answerCallback,
  editMessage,
  escapeHtml,
  sendMessage,
  type InlineKeyboard,
} from "./client";
import {
  approvalCard,
  approvedCard,
  awaitingLinkCard,
  candidateCard,
  kakaoDeliveryMessage,
  parseCallbackData,
  skippedCard,
  type CardDeal,
} from "./cards";
import type { ApprovalStage } from "@prisma/client";

// ── 텔레그램 업데이트 타입 (필요한 필드만) ───────────────────────────────

interface TgUser {
  id: number;
}
interface TgMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
}
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number };
  text?: string;
  entities?: TgMessageEntity[];
}
interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

// ── 접근 통제 ────────────────────────────────────────────────────────────

/**
 * 화이트리스트된 chat_id만 응답한다 (docs/03 §3.7).
 * 봇 토큰은 유출될 수 있고, 봇 사용자명은 공개다 — 누구나 말을 걸 수 있다.
 * 화이트리스트가 없으면 아무나 우리 게이트웨이로 무신사 요청을 시킬 수 있게 된다.
 */
function isAuthorized(userId: number | undefined): boolean {
  if (userId === undefined) return false;
  const allowed = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return false; // 미설정 시 전면 거부 (fail closed)
  return allowed.includes(String(userId));
}

// ── URL 추출 ─────────────────────────────────────────────────────────────

/**
 * 메시지에서 URL을 뽑는다. entities의 offset/length는 UTF-16 코드유닛 기준인데,
 * JS의 String.slice가 정확히 같은 단위를 쓴다 — 그래서 한글·이모지가 섞여도 정확하다.
 * (절대 [...text]나 Array.from으로 인덱싱하지 말 것: 코드포인트 단위가 되어 어긋난다.)
 */
export function extractUrls(text: string, entities: TgMessageEntity[] | undefined): string[] {
  const urls: string[] = [];
  for (const e of entities ?? []) {
    if (e.type === "text_link" && e.url) urls.push(e.url);
    else if (e.type === "url") urls.push(text.slice(e.offset, e.offset + e.length));
  }
  if (urls.length === 0) {
    const m = text.match(/https?:\/\/[^\s<>"']+/);
    if (m) urls.push(m[0]);
  }
  return urls;
}

// ── 헬퍼 ────────────────────────────────────────────────────────────────

const DEAL_WITH_RELATIONS = {
  product: true,
  creator: true,
  curatorLinks: true,
  contentCards: { orderBy: { channel: "asc" as const } },
};

type DealRecord = NonNullable<
  Awaited<ReturnType<typeof db.deal.findFirst<{ include: typeof DEAL_WITH_RELATIONS }>>>
>;

function toCardDeal(deal: DealRecord): CardDeal {
  return {
    id: deal.id,
    brand: deal.product.brandName,
    productName: deal.product.productName,
    styleCode: deal.product.styleCode,
    listPrice: deal.product.listPrice,
    salePrice: deal.salePrice,
    finalPrice: deal.finalPrice,
    discountRate: deal.discountRate,
    couponDesc: deal.couponDesc,
    hookLine: deal.hookLine,
    parseSource: deal.product.source === "PASTE" ? "none" : null,
    linkCount: deal.curatorLinks.length,
  };
}

function toFacts(deal: DealRecord): DealFacts {
  const links: DealLink[] = deal.curatorLinks.map((l) => ({
    label: l.isDefault ? "대표 링크" : "색상",
    url: l.rawUrl,
  }));
  return {
    brand: deal.product.brandName,
    productName: deal.product.productName,
    styleCode: deal.product.styleCode,
    listPrice: deal.product.listPrice,
    salePrice: deal.salePrice,
    discountRate: deal.discountRate,
    couponCode: deal.couponCode,
    couponDesc: deal.couponDesc,
    finalPrice: deal.finalPrice,
    endsAt: deal.endsAt,
    hookLine: deal.hookLine,
    hookSource: "human",
    curatorNote: deal.curatorNote,
    links,
  };
}

async function updateCard(
  deal: DealRecord,
  card: { text: string; keyboard: InlineKeyboard }
): Promise<void> {
  if (!deal.telegramChatId || !deal.telegramMessageId) return;
  await editMessage({
    chatId: deal.telegramChatId,
    messageId: deal.telegramMessageId,
    text: card.text,
    keyboard: card.keyboard,
  });
}

async function setStage(dealId: string, stage: ApprovalStage) {
  await db.deal.update({ where: { id: dealId }, data: { approvalStage: stage } });
}

function copyUrl(cardId: string): string | null {
  const base = process.env.PUBLIC_BASE_URL;
  return base ? `${base.replace(/\/$/, "")}/copy/${cardId}` : null;
}

// ── 진입점 ──────────────────────────────────────────────────────────────

export async function handleUpdate(update: TgUpdate): Promise<void> {
  if (update.callback_query) return handleCallback(update.callback_query);
  if (update.message) return handleMessage(update.message);
}

// ── 메시지 처리 ──────────────────────────────────────────────────────────

async function handleMessage(msg: TgMessage): Promise<void> {
  if (!isAuthorized(msg.from?.id)) {
    await audit({
      actor: "SYSTEM",
      action: "telegram.unauthorized",
      detail: `허용되지 않은 사용자 ${msg.from?.id ?? "unknown"}`,
    });
    return; // 조용히 무시 — 봇의 존재를 확인시켜 줄 이유가 없다
  }

  const text = msg.text?.trim() ?? "";
  const chatId = String(msg.chat.id);

  if (text === "/start" || text === "/help") {
    await sendMessage({
      chatId,
      text:
        "<b>qurator</b>\n\n" +
        "무신사 상품 링크를 보내면 카톡·스레드·인스타·노션용 완성 카드를 만들어 드립니다.\n\n" +
        "1️⃣ 상품 URL 전송 (무신사 앱 공유 → 이 대화)\n" +
        "2️⃣ [이거 올릴래] → 큐레이터 링크 붙여넣기\n" +
        "3️⃣ [승인] → 카톡 문구 받기",
    });
    return;
  }

  // 링크 대기 중인 딜이 있으면, 이 메시지를 큐레이터 링크로 해석한다.
  const awaiting = await db.deal.findFirst({
    where: { telegramChatId: chatId, approvalStage: "AWAITING_LINK" },
    include: DEAL_WITH_RELATIONS,
    orderBy: { updatedAt: "desc" },
  });
  if (awaiting) {
    await handleCuratorLinkPaste(awaiting, text, chatId);
    return;
  }

  const urls = extractUrls(text, msg.entities);
  if (urls.length === 0) {
    await sendMessage({
      chatId,
      text: "무신사 상품 링크를 보내주세요. (도움말: /help)",
    });
    return;
  }

  await captureFromUrl(urls[0], chatId, msg.message_id);
}

/** 사용자가 명시적으로 던진 URL 1건을 캡처한다 — Phase 1의 유일한 아웃바운드 트리거 */
async function captureFromUrl(rawUrl: string, chatId: string, sourceMessageId: number) {
  const canonical = canonicalizeMusinsaUrl(rawUrl);
  if (!canonical.ok) {
    await sendMessage({ chatId, text: `⚠️ ${escapeHtml(canonical.error.reason)}` });
    return;
  }

  const status = await sendMessage({ chatId, text: "🔎 상품 정보를 읽는 중…" });

  const result = await gatewayFetch({ url: canonical.value, trigger: "USER_URL" });

  let parsed = parseProductPage(result.ok ? result.body : "");
  if (result.ok && looksLikeNonProductPage(result.body, parsed)) {
    parsed = { ...parsed, fieldCount: 0, source: "none" };
  }

  const creator = await getDefaultCreator();
  const goodsNo = canonical.value.match(/\/products\/(\d+)/)?.[1] ?? null;

  const product = await db.product.create({
    data: {
      creatorId: creator.id,
      canonicalUrl: canonical.value,
      musinsaGoodsNo: goodsNo,
      brandName: parsed.brandName ?? "(브랜드 미입력)",
      productName: parsed.productName ?? "(상품명 미입력)",
      styleCode: parsed.styleCode,
      listPrice: parsed.listPrice ?? parsed.salePrice ?? 0,
      mainImageUrl: parsed.imageUrl,
      source: "SHARE",
    },
  });

  const deal = await db.deal.create({
    data: {
      productId: product.id,
      creatorId: creator.id,
      status: "DRAFT",
      approvalStage: "CANDIDATE",
      salePrice: parsed.salePrice,
      telegramChatId: chatId,
      telegramMessageId: status.message_id,
      sourceUrlRaw: rawUrl,
    },
    include: DEAL_WITH_RELATIONS,
  });

  await audit({
    actor: "HUMAN",
    action: "deal.captured",
    approvalRef: deal.id,
    detail: `사용자가 던진 URL 1건 (텔레그램 메시지 ${sourceMessageId}) → ${canonical.value} / 파싱 ${parsed.source}`,
  });

  const card = candidateCard(toCardDeal(deal));
  const failureNote = result.ok
    ? ""
    : `\n\n⚠️ ${escapeHtml(result.reason)}\n<i>정보를 직접 입력해 계속 진행할 수 있습니다.</i>`;

  await editMessage({
    chatId,
    messageId: status.message_id,
    text: card.text + failureNote,
    keyboard: card.keyboard,
  });
}

/** 링크 대기 상태에서 붙여넣은 큐레이터 링크를 받아 카드를 렌더한다 */
async function handleCuratorLinkPaste(deal: DealRecord, text: string, chatId: string) {
  const parsed = parseCuratorLink(text);
  if (!parsed.ok) {
    await sendMessage({ chatId, text: `⚠️ ${escapeHtml(parsed.reason)} 다시 붙여넣어 주세요.` });
    return;
  }

  await db.curatorLink.create({
    data: {
      dealId: deal.id,
      rawUrl: parsed.link.rawUrl,
      ulid: parsed.link.ulid,
      isDefault: true,
    },
  });

  // 훅이 없으면 AI 초안을 시도한다. 실패해도(키 없음/타임아웃) 빈 훅으로 진행 — 렌더는 AI에 비의존.
  let hookLine = deal.hookLine;
  if (!hookLine) {
    hookLine = await draftHookLine({
      brand: deal.product.brandName,
      productName: deal.product.productName,
      discountRate: deal.discountRate,
      couponDesc: deal.couponDesc,
    });
    if (hookLine) {
      await db.deal.update({ where: { id: deal.id }, data: { hookLine } });
    }
  }

  const refreshed = await db.deal.findUniqueOrThrow({
    where: { id: deal.id },
    include: DEAL_WITH_RELATIONS,
  });

  const rendered = renderAllChannels(toFacts(refreshed));
  const failed = rendered.find((r) => !r.ok);
  if (failed && !failed.ok) {
    await sendMessage({ chatId, text: `⚠️ 카드를 만들지 못했습니다: ${escapeHtml(failed.error.message)}` });
    return;
  }

  await db.$transaction(async (tx) => {
    // 카드는 불변이다 — 재생성 시 새 버전을 만든다 (docs/02 §3.2)
    const existing = await tx.contentCard.findFirst({
      where: { dealId: deal.id },
      orderBy: { version: "desc" },
    });
    const version = (existing?.version ?? 0) + 1;
    for (const r of rendered) {
      if (!r.ok) continue;
      await tx.contentCard.create({
        data: {
          dealId: deal.id,
          channel: r.card.channel,
          version,
          bodyText: r.card.bodyText,
          charCount: r.card.charCount,
          disclosureOk: r.card.disclosureOk,
          truncated: r.card.truncated,
          warnings: JSON.stringify(r.card.warnings),
          aiGeneratedFields: JSON.stringify(r.card.aiGeneratedFields),
        },
      });
    }
    await tx.deal.update({
      where: { id: deal.id },
      data: { status: "READY", approvalStage: "READY_TO_PUBLISH" },
    });
  });

  const final = await db.deal.findUniqueOrThrow({
    where: { id: deal.id },
    include: DEAL_WITH_RELATIONS,
  });
  const kakao = rendered.find((r) => r.ok && r.card.channel === "KAKAO_OPEN");
  const preview = kakao && kakao.ok ? kakao.card.bodyText : "";

  await updateCard(final, approvalCard(toCardDeal(final), preview));
}

// ── 콜백(버튼) 처리 ──────────────────────────────────────────────────────

async function handleCallback(query: TgCallbackQuery): Promise<void> {
  // 무거운 작업 전에 먼저 응답한다 — 콜백 ID는 10~15초 만에 만료되고,
  // 그 사이 사용자 화면에는 스피너가 계속 돈다.
  await answerCallback(query.id);

  if (!isAuthorized(query.from.id)) return;

  const parsed = query.data ? parseCallbackData(query.data) : null;
  if (!parsed) return;

  const deal = await db.deal.findUnique({
    where: { id: parsed.dealId },
    include: DEAL_WITH_RELATIONS,
  });
  if (!deal) return;

  switch (parsed.action) {
    case "int":
      await setStage(deal.id, "AWAITING_LINK");
      await updateCard(
        deal,
        awaitingLinkCard(
          toCardDeal(deal),
          deal.creator?.curatorShopUrl ?? "https://www.musinsa.com/curator"
        )
      );
      break;

    case "skp":
      await setStage(deal.id, "SKIPPED");
      await updateCard(deal, skippedCard(toCardDeal(deal)));
      await audit({ actor: "HUMAN", action: "deal.skipped", approvalRef: deal.id });
      break;

    case "hok":
      await db.deal.update({ where: { id: deal.id }, data: { approvalStage: "AWAITING_LINK" } });
      await sendMessage({
        chatId: String(deal.telegramChatId),
        text: "✏️ 새 훅 문구를 보내주세요. (한 줄)",
      });
      break;

    case "man":
      await sendMessage({
        chatId: String(deal.telegramChatId),
        text:
          "✏️ 웹 대시보드에서 상품 정보를 입력해 주세요.\n" +
          (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"),
      });
      break;

    case "apv":
      await approveDeal(deal);
      break;
  }
}

async function approveDeal(deal: DealRecord): Promise<void> {
  const kakaoCard = deal.contentCards.find((c) => c.channel === "KAKAO_OPEN");
  if (!kakaoCard) return;

  // 고지문 검증 게이트 — disclosureOk가 false인 카드는 어떤 경로로도 나가지 않는다.
  // (docs/03 §1 불변식 I-3. 렌더러가 이미 검증했지만, 발행 직전에 한 번 더 확인한다.)
  if (!kakaoCard.disclosureOk) {
    await sendMessage({
      chatId: String(deal.telegramChatId),
      text: "⛔️ 고지문 검증에 실패한 카드는 발행할 수 없습니다.",
    });
    await audit({
      actor: "SYSTEM",
      action: "publish.blocked_disclosure",
      approvalRef: deal.id,
      channel: "KAKAO_OPEN",
    });
    return;
  }

  await db.$transaction(async (tx) => {
    await tx.deal.update({
      where: { id: deal.id },
      data: { status: "PUBLISHED", approvalStage: "APPROVED" },
    });
    await tx.post.create({
      data: {
        contentCardId: kakaoCard.id,
        dealId: deal.id,
        channel: "KAKAO_OPEN",
        mode: "SEMI_COPIED",
        status: "SENT",
        publishedAt: new Date(),
      },
    });
  });

  await audit({
    actor: "HUMAN",
    action: "deal.approved",
    approvalRef: deal.id,
    channel: "KAKAO_OPEN",
    payloadSnapshot: kakaoCard.bodyText,
    detail: "현표가 텔레그램에서 승인 — 카톡 전송은 사람이 수행(반자동)",
  });

  const url = copyUrl(kakaoCard.id);
  await updateCard(deal, approvedCard(toCardDeal(deal), url));

  const delivery = kakaoDeliveryMessage(kakaoCard.bodyText, url);
  await sendMessage({
    chatId: String(deal.telegramChatId),
    text: delivery.text,
    keyboard: delivery.keyboard,
  });
}
