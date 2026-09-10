// 텔레그램 업데이트 처리 — Phase 1 상태 머신의 본체.
//
// 흐름 (docs/02-architecture.md §6):
//   URL 던지기 → [후보] --이거 올릴래--> [링크 대기] --링크 붙여넣기--> [발행 승인] --승인--> 카톡 문구 전달
//
// 이 파일은 webhook과 폴링 양쪽에서 같은 함수로 쓰인다(진입 경로만 다르고 처리는 동일).

// 텔레그램 파일 다운로드(getFile이 알려준 file_path → api.telegram.org/file/...)는 무신사
// Fetch Gateway와 무관한 텔레그램 자체 CDN이다 (docs/06-screenshot-capture.md §4.4).
// client.ts와 동일한 이유로, 이 경로에서만 전역 fetch를 직접 쓴다.
/* eslint-disable no-restricted-globals -- 텔레그램 자체 CDN 다운로드, 무신사 게이트웨이와 무관한 별도 경로다 */

import { db } from "../db";
import { getDefaultCreator } from "../creator";
import { gatewayFetch } from "../fetch-gateway";
import { canonicalizeMusinsaUrl } from "../url-guard";
import { looksLikeNonProductPage, parseProductPage } from "../product-parser";
import { parseCuratorLink } from "../curator-link";
import { recordParsedSnapshot, recordSnapshot } from "../price-snapshot";
import { BF2025_OBSERVED_AT } from "../price-analysis";
import { addWatch, countActiveWatches, listActiveWatches, removeWatch } from "../watch";
import { isCrawlessMode } from "../policy";
import { formatKRW, formatShortDateTime } from "../format";
import { draftHookLine } from "../ai-hook";
import { extractFromScreenshot } from "../vision-extract";
import { matchOrCreateProduct } from "../product-match";
import { renderAllChannels, type DealFacts, type DealLink } from "../renderer";
import { audit } from "../audit";
import { signCardToken } from "../signed-link";
import { ensureShortLink } from "../shortlink";
import { firstCheckAt } from "../health-check";
import {
  answerCallback,
  callMethod,
  editMessage,
  escapeHtml,
  sendMessage,
  type InlineKeyboard,
} from "./client";
import {
  approvalCard,
  approvedCard,
  awaitingLinkCard,
  BUTTON_GUIDE,
  candidateCard,
  CB,
  kakaoDeliveryMessage,
  parseCallbackData,
  skippedCard,
  type CardDeal,
} from "./cards";
import type { ApprovalStage, Channel, PendingInput } from "@prisma/client";

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
/** 텔레그램은 사진 1장을 여러 해상도로 보낸다 — 배열의 마지막 원소가 가장 큰 사이즈다(텔레그램 자체 컨벤션) */
interface TgPhotoSize {
  file_id: string;
  file_size?: number;
  width: number;
  height: number;
}
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number };
  text?: string;
  entities?: TgMessageEntity[];
  photo?: TgPhotoSize[];
  /** 여러 장을 한 번에 보낸 "앨범"의 사진들이 공유하는 id. 낱장 사진에는 없다 (docs/06 §4.4). */
  media_group_id?: string;
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

function toCardDeal(deal: DealRecord, linkWarnings?: string[]): CardDeal {
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
    // 파싱 출처는 캡처 시점에 DB에 저장해 둔 값을 그대로 쓴다.
    // (product.source로 유추하면 항상 같은 값이 나와 경고가 영원히 표시되지 않았다.)
    parseSource: deal.parseSource,
    linkCount: deal.curatorLinks.length,
    linkWarnings,
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

/**
 * "이 대화에서 봇이 지금 기다리는 입력"을 한 딜에만 세운다.
 *
 * 이것이 상태 머신의 핵심 불변식이다: 한 대화에 pendingInput이 걸린 딜은 최대 1건.
 * 이전 구현은 approvalStage=AWAITING_LINK인 딜을 chatId로만 찾았는데, 딜 2건을 연달아
 * 던지면(이 봇의 정상 사용 패턴) 붙여넣은 링크가 엉뚱한 딜에 붙어 상품 A를 설명하며
 * 상품 B의 커미션 링크를 뿌리게 된다 — 무신사가 보기엔 링크 스왑 패턴이다.
 */
async function setPendingInput(
  dealId: string,
  chatId: string,
  input: PendingInput | null
): Promise<void> {
  await db.$transaction(async (tx) => {
    // 같은 대화의 다른 딜에 걸린 대기 상태를 먼저 모두 해제한다.
    await tx.deal.updateMany({
      where: { telegramChatId: chatId, pendingInput: { not: null }, NOT: { id: dealId } },
      data: { pendingInput: null },
    });
    await tx.deal.update({ where: { id: dealId }, data: { pendingInput: input } });
  });
}

/** 이 대화에서 봇이 입력을 기다리는 딜(최대 1건) */
async function findPendingDeal(chatId: string): Promise<DealRecord | null> {
  return db.deal.findFirst({
    where: { telegramChatId: chatId, pendingInput: { not: null } },
    include: DEAL_WITH_RELATIONS,
    orderBy: { updatedAt: "desc" },
  });
}

/**
 * 승인·미리보기에 쓸 카드를 고른다. **항상 최신 버전**이어야 한다.
 * include의 정렬은 channel 기준뿐이라 관계 배열에서 find로 집으면 재렌더된 v2 대신 v1이 잡힌다 —
 * 그러면 승인 화면에 보인 것과 실제 나가는 것이 달라져 approval-first의 근거가 무너진다.
 */
async function latestCard(dealId: string, channel: Channel) {
  return db.contentCard.findFirst({
    where: { dealId, channel },
    orderBy: { version: "desc" },
  });
}

/**
 * 복사 웹뷰 링크. cardId를 그대로 노출하지 않고 HMAC 서명 토큰으로 감싼다 —
 * 카드 본문에는 커미션 ULID가 들어 있어, 링크를 아는 누구나 열 수 있으면 안 된다.
 * APP_SECRET이 없으면 링크를 만들지 않는다(버튼 생략).
 */
function copyUrl(cardId: string): string | null {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) return null;
  try {
    return `${base.replace(/\/$/, "")}/copy/${signCardToken(cardId)}`;
  } catch {
    return null;
  }
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

  const chatId = String(msg.chat.id);

  // 스크린샷은 pendingInput·/command보다 먼저 처리한다: 사진은 링크 붙여넣기와 절대 혼동될
  // 수 없으므로(텍스트 URL과 달리) "무엇을 기다리는 중인지"를 되물을 모호함이 없다 —
  // 사진이 오면 항상 새 캡처를 시작한다 (docs/06-screenshot-capture.md §3).
  if (msg.photo && msg.photo.length > 0) {
    // 앨범(여러 장을 한 번에 전송)은 사진마다 별개의 update로 오므로, 한 캡처로 합치려면
    // 버퍼링이 필요하다 — 낱장 사진은 그대로 즉시 처리한다 (docs/06 §4.4).
    if (msg.media_group_id) {
      await bufferGroupedScreenshot(msg, chatId);
    } else {
      await captureFromScreenshot(msg, chatId);
    }
    return;
  }

  const text = msg.text?.trim() ?? "";

  if (text === "/start" || text === "/help") {
    await sendMessage({
      chatId,
      text:
        "<b>qurator</b>\n\n" +
        "무신사 상품 <b>스크린샷</b>을 보내면 상품을 읽고, 가격을 기록하고, 카톡·스레드·인스타·노션용 완성 카드를 만들어 드립니다.\n\n" +
        "1️⃣ 무신사 앱에서 상품 화면 스크린샷 → 이 대화로 공유 (링크를 보내도 됩니다)\n" +
        "2️⃣ [✅ 이 상품 올릴게요] → 큐레이터 링크 붙여넣기\n" +
        "3️⃣ [🚀 승인] → 카톡 문구 받기\n\n" +
        "<i>카드의 [❓ 버튼 설명]을 누르면 각 버튼이 무슨 뜻인지 볼 수 있습니다.</i>\n\n" +
        "<b>가격 추적</b>\n" +
        "📈 /watch 상품링크 — 가격 추적 등록\n" +
        "📋 /watchlist — 지켜보는 중인 상품 목록\n" +
        "🚫 /unwatch 상품링크 — 추적 해제\n" +
        "💾 /bf2025 상품링크 판매가 [정가] [쿠폰가] — 작년 블프 가격 수동 기록",
    });
    return;
  }

  // 워치·수동입력 명령은 pending 상태보다 먼저 처리한다.
  // 링크 대기 중에 이 명령들을 보내면 큐레이터 링크 파서로 들어가 오류만 반복되기 때문이다.
  if (text.startsWith("/bf2025")) {
    await handleManualBfEntry(text, chatId);
    return;
  }
  if (text.startsWith("/watchlist")) {
    await handleWatchList(chatId);
    return;
  }
  if (text.startsWith("/watch")) {
    await handleWatchCommand(text, chatId, true);
    return;
  }
  if (text.startsWith("/unwatch")) {
    await handleWatchCommand(text, chatId, false);
    return;
  }

  // 봇이 이 대화에서 무언가를 기다리고 있으면, 그 딜의 그 입력으로 해석한다.
  // pendingInput이 무엇인지에 따라 링크와 훅이 정확히 구분된다 — 이전처럼
  // approvalStage만 보면 [훅 교체] 후 보낸 훅 문구가 큐레이터 링크 파서로 들어가 버린다.
  const pending = await findPendingDeal(chatId);
  if (pending) {
    if (pending.pendingInput === "HOOK") {
      await handleHookReplacement(pending, text, chatId);
      return;
    }

    // 링크를 기다리는 중인데 커미션 파라미터가 없는 무신사 상품 URL이 오면,
    // 링크를 붙여넣은 것인지 새 딜을 시작하려는 것인지 모호하다. 사람에게 되묻는다.
    const looksLikeNewProduct =
      /musinsa\.com\/(products|app\/goods)\//.test(text) && !/utm_|af_dp/.test(text);
    if (looksLikeNewProduct) {
      await sendMessage({
        chatId,
        text:
          "커미션 파라미터가 없는 상품 링크입니다.\n" +
          "이 딜의 큐레이터 링크라면 큐레이터센터에서 만든 링크를 붙여넣어 주세요.\n" +
          "새 딜을 시작하려면 아래 버튼을 눌러주세요.",
        keyboard: [[{ text: "🆕 새 딜로 시작", callback_data: CB.newDeal(pending.id) }]],
      });
      return;
    }

    await handleCuratorLinkPaste(pending, text, chatId);
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

  // 공유 링크(예: 무신사 앱 "공유하기"가 만드는 onelink.me)는 게이트웨이가 리다이렉트를
  // 따라가야 실제 상품 URL에 도달한다. goodsNo·canonicalUrl은 리다이렉트 전 URL이 아니라
  // 실제 도달한 finalUrl 기준이어야 한다 — 안 그러면 공유 링크 자체가 canonicalUrl로 저장되고
  // goodsNo가 항상 null이 돼 같은 상품 재전송 시 dedup(upsert)이 깨진다.
  const resolved = result.ok ? canonicalizeMusinsaUrl(result.finalUrl) : canonical;
  const finalCanonical = resolved.ok ? resolved.value : canonical.value;

  let parsed = parseProductPage(result.ok ? result.body : "");
  if (result.ok && looksLikeNonProductPage(result.body, parsed)) {
    parsed = { ...parsed, fieldCount: 0, source: "none" };
  }

  const creator = await getDefaultCreator();
  const goodsNo = finalCanonical.match(/\/products\/(\d+)/)?.[1] ?? null;

  const productFields = {
    canonicalUrl: finalCanonical,
    brandName: parsed.brandName ?? "(브랜드 미입력)",
    productName: parsed.productName ?? "(상품명 미입력)",
    styleCode: parsed.styleCode,
    // 가격을 못 읽었을 때 0으로 채우면 "0원"이 고지문과 함께 오픈채팅에 나갈 수 있다.
    // 0은 "미확인"의 의미로만 쓰고, 카드가 그것을 눈에 띄게 표시한다.
    listPrice: parsed.listPrice ?? parsed.salePrice ?? 0,
    mainImageUrl: parsed.imageUrl,
    source: "SHARE" as const,
  };

  // 같은 상품을 두 번 던지는 것은 정상 사용이다(가격이 또 떨어졌거나, 아까 스킵했거나).
  // Product에 @@unique([creatorId, musinsaGoodsNo])가 걸려 있어 create만 하면 두 번째 전송에서
  // 예외가 나고 봇이 조용히 죽는다 — upsert로 최신 정보를 덮어쓴다.
  const product = goodsNo
    ? await db.product.upsert({
        where: { creatorId_musinsaGoodsNo: { creatorId: creator.id, musinsaGoodsNo: goodsNo } },
        update: productFields,
        create: { creatorId: creator.id, musinsaGoodsNo: goodsNo, ...productFields },
      })
    : await db.product.create({
        data: { creatorId: creator.id, musinsaGoodsNo: null, ...productFields },
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
      parseSource: parsed.source,
      parseFieldCount: parsed.fieldCount,
    },
    include: DEAL_WITH_RELATIONS,
  });

  // 피기백 스냅샷(docs/05 §4.3) — 방금 그 1회 조회의 파싱 결과를 이력으로 남긴다.
  // Product upsert는 최신값으로 덮어쓰므로, 여기 기록이 없으면 가격 변화가 소실된다.
  // 절대 throw하지 않고, 가격을 못 읽었으면 조용히 건너뛴다.
  await recordParsedSnapshot(product.id, parsed, "USER_URL");

  await audit({
    actor: "HUMAN",
    action: "deal.captured",
    approvalRef: deal.id,
    detail: `사용자가 던진 URL 1건 (텔레그램 메시지 ${sourceMessageId}) → ${finalCanonical} / 파싱 ${parsed.source}`,
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

/**
 * 다운로드한 스크린샷 1장 이상으로 상품을 캡처한다 — docs/06-screenshot-capture.md §3-§4의
 * 1차 입력 경로. 낱장 사진 경로와 앨범(여러 장) 경로가 이 함수부터 합쳐진다: 여러 장이면
 * 같은 상품 페이지를 위/아래로 나눠 찍은 것으로 보고 Claude Vision에 한 번에 같이 보낸다
 * (vision-extract.ts가 다중 이미지를 받는다 — §4.4, "폰 화면에 상품 사진과 가격이 한 번에 안 담기는" 문제).
 * captureFromUrl과 대칭이지만 무신사에 요청을 전혀 보내지 않는다: Vision이 화면에서
 * 직접 읽으므로 gatewayFetch를 아예 거치지 않는다(§7 — 요청 0건).
 *
 * 이미지 바이트는 이 함수의 지역 변수(images)에만 존재하다가 extractFromScreenshot 호출이
 * 끝나면 스코프를 벗어나 버려진다 — 디스크·DB·로그·감사 기록 어디에도 쓰지 않는다 (§4.3).
 */
async function processScreenshotPhotos(
  photos: TgPhotoSize[],
  chatId: string,
  statusMessageId: number,
  sourceMessageId: number
): Promise<void> {
  const images: { data: string; mediaType: string }[] = [];
  for (const photo of photos) {
    try {
      const file = await callMethod<{ file_path: string }>("getFile", { file_id: photo.file_id });
      // 텔레그램 자체 CDN이다(무신사와 무관) — gatewayFetch가 아니라 전역 fetch를 직접 쓴다.
      const response = await fetch(
        `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`
      );
      // 텔레그램은 사진(photo)을 서버에서 항상 JPEG로 재인코딩한다 — 원래 사용자가 무엇을 보냈든
      // photo 배열에는 mime 정보가 없으므로 고정값을 쓴다 (docs/06 §4.4).
      images.push({
        data: Buffer.from(await response.arrayBuffer()).toString("base64"),
        mediaType: "image/jpeg",
      });
    } catch (err) {
      // 앨범 중 한 장만 실패해도 나머지로 계속 진행한다 — 부분 정보가 전무보다 낫다.
      console.error("[screenshot] 텔레그램 파일 다운로드 실패", err);
    }
  }

  if (images.length === 0) {
    await editMessage({
      chatId,
      messageId: statusMessageId,
      text: "⚠️ 스크린샷을 받지 못했습니다. 다시 보내주세요.",
    });
    return;
  }

  const result = await extractFromScreenshot(images);
  // 이 아래로는 images를 다시 참조하지 않는다 — 여기서 사실상 버려진다.

  if (!result) {
    // Vision 실패(API 장애·타임아웃 등)는 ai-hook.ts와 같은 null 폴백이다 — 빈 딜을 만들면
    // 장애 상황에 워크스페이스가 껍데기 카드로 스팸된다. 아무것도 만들지 않고 안내만 한다.
    await editMessage({
      chatId,
      messageId: statusMessageId,
      text: "⚠️ 스크린샷을 읽지 못했습니다. 다시 시도해주시거나 /help의 직접 입력 방법을 이용해주세요.",
    });
    return;
  }

  if (!result.isProductPage) {
    // 카메라가 잘못된 화면을 향한 경우다 — 기록할 것이 없으므로 딜·스냅샷을 만들지 않는다
    // (docs/06 §3.3: "이건 실패가 아니라 엉뚱한 화면을 찍은 것" — 소음으로 남기지 않는다).
    await editMessage({
      chatId,
      messageId: statusMessageId,
      text: "상품 페이지 상단(브랜드·상품명·가격이 보이는 화면)을 찍어주세요.",
    });
    return;
  }

  const creator = await getDefaultCreator();
  const { product, matchedBy } = await matchOrCreateProduct({
    creatorId: creator.id,
    chatId,
    brand: result.brand,
    productName: result.productName,
    styleCode: result.styleCode,
  });

  // 피기백 스냅샷 — 가격을 하나도 못 읽었으면 recordSnapshot이 조용히 건너뛴다.
  await recordSnapshot({
    productId: product.id,
    listPrice: result.listPrice,
    salePrice: result.salePrice,
    couponPrice: result.couponPrice,
    source: "SCREENSHOT",
  });

  // product-parser.ts의 countFields()와 같은 정신: null이 아닌 필드 수 = "얼마나 채워졌나".
  const parseFieldCount = [
    result.brand,
    result.productName,
    result.listPrice,
    result.salePrice,
  ].filter((v) => v !== null).length;

  const deal = await db.deal.create({
    data: {
      productId: product.id,
      creatorId: creator.id,
      status: "DRAFT",
      approvalStage: "CANDIDATE",
      salePrice: result.salePrice,
      telegramChatId: chatId,
      telegramMessageId: statusMessageId,
      // JSON-LD/OpenGraph가 아니라 Vision 추출이라는 것을 카드·감사 로그가 구분할 수 있게 한다.
      parseSource: "vision",
      parseFieldCount,
    },
    include: DEAL_WITH_RELATIONS,
  });

  await audit({
    actor: "HUMAN",
    action: "deal.captured",
    approvalRef: deal.id,
    // 이미지 자체는 절대 남기지 않는다 — 매칭 결과와 메시지 ID만 증적으로 남는다 (docs/06 §4.3/§7).
    detail:
      images.length > 1
        ? `스크린샷 ${images.length}장 캡처 (텔레그램 메시지 ${sourceMessageId}~) → 상품 매칭 ${matchedBy}`
        : `스크린샷 캡처 (텔레그램 메시지 ${sourceMessageId}) → 상품 매칭 ${matchedBy}`,
  });

  // 링크 경로와 동일한 후보 카드 — 사용자에게는 두 입력 경로가 이 지점부터 구분되지 않는다.
  const card = candidateCard(toCardDeal(deal));
  await editMessage({
    chatId,
    messageId: statusMessageId,
    text: card.text,
    keyboard: card.keyboard,
  });
}

/** 사진 1장 경로 — 즉시 처리한다(앨범과 달리 더 올지 기다릴 이유가 없다). */
async function captureFromScreenshot(msg: TgMessage, chatId: string): Promise<void> {
  const status = await sendMessage({ chatId, text: "🔎 스크린샷 확인하는 중…" });
  // 여러 해상도 중 배열의 마지막(가장 큰 사이즈)을 쓴다 — 작은 글씨(품번 등) 오독을 줄인다.
  const photo = msg.photo![msg.photo!.length - 1];
  await processScreenshotPhotos([photo], chatId, status.message_id, msg.message_id);
}

// ── 앨범(여러 장) 스크린샷 병합 ──────────────────────────────────────────
//
// 폰 화면 하나로 상품 사진(위)과 가격(아래)이 한 스크린샷에 다 안 담기는 경우, 두 장으로 나눠
// 찍어 텔레그램 "앨범"(여러 장 한 번에 전송)으로 보낼 수 있다. 텔레그램은 앨범을 사진마다
// 별개의 update로 쪼개 보내므로, update 하나만 보고는 몇 장이 더 오는지 알 수 없다 — 그래서
// media_group_id별로 잠깐 모았다가 한 번에 처리한다.

interface PendingMediaGroup {
  chatId: string;
  photos: TgPhotoSize[];
  statusMessageId: number;
  sourceMessageId: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 프로세스 메모리 버퍼. 재시작하면 비지만, 앨범 도착 간격(수백 ms~2초)만 버티면 되므로
 * webhook route의 재전송 중복 캐시와 같은 이유로 이걸로 충분하다 — 봇 프로세스는
 * 폴링·webhook 어느 경로든 장기 실행 단일 프로세스다.
 */
const pendingMediaGroups = new Map<string, PendingMediaGroup>();

/** 앨범 사진 사이의 대기 시간. 너무 짧으면 마지막 장을 놓치고, 너무 길면 카드가 늦게 뜬다. */
export const MEDIA_GROUP_DEBOUNCE_MS = 1500;

/**
 * 한 캡처에 합칠 최대 장수. 무신사 상품 페이지는 위/아래로 나눠 2~3장이면 충분하다 —
 * 그 이상은 실수로 여러 상품을 한 앨범에 같이 보낸 경우일 가능성이 크므로 이 캡처엔 안 쓴다
 * (Vision 입력·비용이 무한정 커지지 않게 하는 상한이지 사진을 버리는 건 아니다).
 */
export const MAX_GROUP_PHOTOS = 4;

/**
 * 앨범의 사진 한 장이 도착했다 — 버퍼에 쌓고 타이머를 리셋할 뿐, 여기서 처리를 기다리지
 * 않는다(디바운스 타이머를 await하면 폴링 루프가 같은 앨범의 다음 사진을 못 받는다).
 */
async function bufferGroupedScreenshot(msg: TgMessage, chatId: string): Promise<void> {
  const groupId = msg.media_group_id!;
  const photo = msg.photo![msg.photo!.length - 1];
  const existing = pendingMediaGroups.get(groupId);

  if (existing) {
    clearTimeout(existing.timer);
    if (existing.photos.length < MAX_GROUP_PHOTOS) existing.photos.push(photo);
    existing.timer = setTimeout(() => flushMediaGroupSafely(groupId), MEDIA_GROUP_DEBOUNCE_MS);
    return;
  }

  // 앨범의 첫 사진에서만 상태 메시지를 보낸다 — 장마다 "확인하는 중"이 여러 개 뜨면 소란스럽다.
  const status = await sendMessage({
    chatId,
    text: "🔎 스크린샷 확인하는 중… (더 있으면 잠시 기다립니다)",
  });
  pendingMediaGroups.set(groupId, {
    chatId,
    photos: [photo],
    statusMessageId: status.message_id,
    sourceMessageId: msg.message_id,
    timer: setTimeout(() => flushMediaGroupSafely(groupId), MEDIA_GROUP_DEBOUNCE_MS),
  });
}

/** setTimeout 콜백은 async를 await할 수 없다 — 에러가 조용히 사라지지 않게 여기서 잡는다. */
function flushMediaGroupSafely(groupId: string): void {
  flushMediaGroup(groupId).catch((err) => {
    console.error("[screenshot] 앨범 처리 실패", groupId, err);
  });
}

/** 디바운스 타이머가 만료되면 그때까지 모인 사진들로 한 번에 캡처를 진행한다. */
async function flushMediaGroup(groupId: string): Promise<void> {
  const group = pendingMediaGroups.get(groupId);
  if (!group) return; // 이미 처리됐거나(방어적) 존재하지 않는 그룹
  pendingMediaGroups.delete(groupId);
  await processScreenshotPhotos(
    group.photos,
    group.chatId,
    group.statusMessageId,
    group.sourceMessageId
  );
}

// ── 작년 BF 가격 수동 입력 ───────────────────────────────────────────────

/** 자동으로는 복원 불가능한 과거(2025 BF) 가격의 유일한 입력 경로 — docs/05 §2(a) */
const BF_MANUAL_TAG = "BF2025";

/** "39,000" / "39000원" 같은 사람 입력을 원 단위 정수로 */
function parsePriceToken(token: string | undefined): number | null {
  if (!token) return null;
  const digits = token.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * `/bf2025 <상품링크|상품번호> <판매가> [정가] [쿠폰가]` — 네트워크 요청이 전혀 없는 순수 DB 기록.
 * 상품은 이미 캡처된 것만 받는다: 여기서 미등록 상품을 만들면 이름 없는 껍데기 Product가
 * 생기고, 그걸 채우려면 결국 링크를 던져야 한다 — 순서만 바꾼 셈이니 처음부터 그렇게 안내한다.
 *
 * 쿠폰가는 선택이다 — 작년엔 쿠폰이 없었거나 기억나지 않을 수 있다. 입력하면 그 해 행사의
 * 쿠폰 반영 실할인율(price-analysis.ts의 couponDiscountRate)까지 "작년 vs 올해" 비교에 들어간다.
 */
/**
 * "https://www.musinsa.com/products/123" 또는 "123" → 이미 등록된 Product.
 * 여기서 미등록 상품을 새로 만들지 않는 이유: 이름·가격이 빈 껍데기 Product가 생기고,
 * 그것을 채우려면 결국 링크를 던져야 한다 — 순서만 바꾼 셈이라 처음부터 그렇게 안내한다.
 */
async function resolveProductByToken(token: string) {
  const goodsNo = /^\d+$/.test(token) ? token : (token.match(/\/products\/(\d+)/)?.[1] ?? null);
  if (!goodsNo) return { goodsNo: null, product: null };
  const creator = await getDefaultCreator();
  const product = await db.product.findUnique({
    where: { creatorId_musinsaGoodsNo: { creatorId: creator.id, musinsaGoodsNo: goodsNo } },
  });
  return { goodsNo, product };
}

async function handleManualBfEntry(text: string, chatId: string) {
  const tokens = text.split(/\s+/).slice(1);
  const { goodsNo, product } = await resolveProductByToken(tokens[0] ?? "");
  const salePrice = parsePriceToken(tokens[1]);
  const listPriceInput = parsePriceToken(tokens[2]);
  const couponPrice = parsePriceToken(tokens[3]);

  if (!goodsNo || salePrice === null) {
    await sendMessage({
      chatId,
      text:
        "사용법: /bf2025 상품링크(또는 상품번호) 작년BF판매가 [정가] [쿠폰가]\n" +
        "예: <code>/bf2025 https://www.musinsa.com/products/3134008 39900 89000 37900</code>",
    });
    return;
  }

  if (!product) {
    await sendMessage({
      chatId,
      text: `#${goodsNo} 상품이 아직 등록되지 않았습니다.\n상품 링크를 먼저 보내 등록한 뒤 다시 입력해주세요.`,
    });
    return;
  }

  // 정가 미입력 시 상품의 정가를 쓴다. 0은 "미확인" 표시값이므로 정가로 취급하지 않는다.
  const listPrice = listPriceInput ?? (product.listPrice > 0 ? product.listPrice : null);
  const saved = await recordSnapshot({
    productId: product.id,
    salePrice,
    listPrice,
    couponPrice,
    source: "MANUAL",
    eventTag: BF_MANUAL_TAG,
    // capturedAt은 "그 가격이 참이었던 시점"이다. 입력 시각(지금)으로 찍으면 작년 가격이
    // 최신 스냅샷이 되어 카드의 '현재가'와 시계열 순서가 통째로 뒤집힌다.
    capturedAt: BF2025_OBSERVED_AT,
    note: `텔레그램 수동 입력 (${new Date().toISOString().slice(0, 10)} 기록)`,
  });
  if (!saved.recorded) {
    await sendMessage({ chatId, text: "⚠️ 기록하지 못했습니다. 다시 시도해주세요." });
    return;
  }

  await audit({
    actor: "HUMAN",
    action: "snapshot.manual",
    approvalRef: product.id,
    detail:
      `${BF_MANUAL_TAG} ${product.brandName} ${product.productName} — ` +
      `판매가 ${salePrice}${listPrice ? ` / 정가 ${listPrice}` : ""}${couponPrice ? ` / 쿠폰가 ${couponPrice}` : ""}`,
  });

  const rate =
    listPrice && listPrice > salePrice ? Math.round((1 - salePrice / listPrice) * 100) : null;
  const couponRate =
    listPrice && couponPrice && listPrice > couponPrice
      ? Math.round((1 - couponPrice / listPrice) * 100)
      : null;
  await sendMessage({
    chatId,
    text:
      `📌 <b>${BF_MANUAL_TAG}</b> 기록 완료 — ${escapeHtml(product.brandName)} ${escapeHtml(product.productName)}\n` +
      `판매가 ${formatKRW(salePrice)}` +
      (listPrice ? ` · 정가 ${formatKRW(listPrice)}` : "") +
      (rate !== null ? ` · 할인율 ${rate}%` : "") +
      (couponPrice
        ? `\n쿠폰가 ${formatKRW(couponPrice)}` + (couponRate !== null ? ` · 할인율 ${couponRate}%` : "")
        : "") +
      "\n<i>수동 입력 값입니다 — 올해 BF 비교에 '작년(수동)'으로 표시됩니다.</i>",
  });
}

// ── BF 워치 등록/해제 ────────────────────────────────────────────────────

/**
 * 등록·해제 결과를 사람이 읽을 문장으로. 상한을 항상 함께 알려준다.
 *
 * 자동 만료는 없다 — /unwatch로 해제할 때까지 계속 지켜본다(2026-09-10 변경, watch.ts 참고).
 *
 * 크롤리스 모드(기본 켜짐)에서는 러너가 무신사에 요청을 보내지 않으므로 자동 기록이 **없다**
 * (watch.ts의 크롤리스 게이트). 그런데도 "하루 1회 기록합니다"라고 알리면 오지 않을 데이터를
 * 약속하는 셈이라, 실제로 일어나는 일(리마인더 → 사람이 다시 촬영)을 그대로 적는다.
 */
async function watchAddedMessage(
  productLabel: string,
  result: Awaited<ReturnType<typeof addWatch>>
): Promise<string> {
  if (!result.ok) return `⚠️ ${result.reason}`;
  const head = result.alreadyActive
    ? `📈 이미 지켜보는 중입니다 — ${productLabel}`
    : `📈 <b>가격 추적 시작</b> — ${productLabel}`;
  const how = (await isCrawlessMode())
    ? "같은 상품을 다시 찍어 보내주시면 그때마다 가격 변화가 기록됩니다. 잊지 않도록 알림을 보내드릴게요."
    : "하루 1회 가격을 기록합니다 (행사 기간에는 2회).";
  return (
    `${head}\n${how}\n` +
    `<i>자동으로 끝나지 않습니다 — 그만 지켜보려면 /unwatch로 해제해주세요. 지켜보는 중 ${result.activeCount}개</i>`
  );
}

/** `/watch <링크|번호>` · `/unwatch <링크|번호>` */
async function handleWatchCommand(text: string, chatId: string, add: boolean) {
  const token = text.split(/\s+/)[1] ?? "";
  const { goodsNo, product } = await resolveProductByToken(token);

  if (!goodsNo) {
    await sendMessage({
      chatId,
      text:
        `사용법: ${add ? "/watch" : "/unwatch"} 상품링크(또는 상품번호)\n` +
        `예: <code>${add ? "/watch" : "/unwatch"} https://www.musinsa.com/products/3134008</code>`,
    });
    return;
  }
  if (!product) {
    await sendMessage({
      chatId,
      text: `#${goodsNo} 상품이 아직 등록되지 않았습니다.\n상품 링크를 먼저 보내주세요.`,
    });
    return;
  }

  const label = `${escapeHtml(product.brandName)} ${escapeHtml(product.productName)}`;
  if (!add) {
    const removed = await removeWatch(product.id);
    await sendMessage({
      chatId,
      text: removed ? `🚫 추적을 해제했습니다 — ${label}` : `추적 중이 아닌 상품입니다 — ${label}`,
    });
    return;
  }

  await sendMessage({ chatId, text: await watchAddedMessage(label, await addWatch(product.id)) });
}

/** `/watchlist` — 지금 무엇을 추적 중인지. 상한 대비 사용량을 항상 함께 보여준다. */
async function handleWatchList(chatId: string) {
  const [items, activeCount] = await Promise.all([listActiveWatches(), countActiveWatches()]);
  if (items.length === 0) {
    await sendMessage({
      chatId,
      text: "지켜보는 중인 상품이 없습니다.\n상품 카드의 [📈 가격만 지켜보기] 버튼이나 /watch 로 등록하세요.",
    });
    return;
  }

  const lines = items.map((item, i) => {
    const last = item.lastCheckedAt
      ? formatShortDateTime(item.lastCheckedAt)
      : "아직 조회 전";
    return (
      `${i + 1}. ${escapeHtml(item.product.brandName)} ${escapeHtml(item.product.productName)}\n` +
      `   마지막 조회 ${last}`
    );
  });

  await sendMessage({
    chatId,
    text: `📋 <b>지켜보는 중인 상품</b> (${activeCount}개)\n\n${lines.join("\n")}`,
  });
}

/** 링크 대기 상태에서 붙여넣은 큐레이터 링크를 받아 카드를 렌더한다 */
async function handleCuratorLinkPaste(deal: DealRecord, text: string, chatId: string) {
  const parsed = parseCuratorLink(text);
  if (!parsed.ok) {
    await sendMessage({ chatId, text: `⚠️ ${escapeHtml(parsed.reason)} 다시 붙여넣어 주세요.` });
    return;
  }

  // 파싱해 둔 검증 필드를 실제로 쓴다. 이전 구현은 goodsNo·hasCommissionParams를 뽑아만 두고
  // 한 번도 읽지 않아, 다른 상품의 링크를 붙여넣어도 그대로 통과했다.
  const linkWarnings: string[] = [];
  const expected = deal.product.musinsaGoodsNo;
  if (expected && parsed.link.goodsNo && parsed.link.goodsNo !== expected) {
    linkWarnings.push(
      `이 링크는 다른 상품(#${parsed.link.goodsNo})을 가리킵니다 — 이 딜은 #${expected}입니다.`
    );
  } else if (!expected && parsed.link.goodsNo) {
    // 스크린샷으로 생성된 상품(docs/06 §4.2)은 musinsaGoodsNo가 없다. 처음 받는 정규 링크로
    // 지금 채워야 한다 — 안 그러면 canonicalUrl이 합성 sentinel("screenshot-pending:...")로
    // 영원히 남고, 승인 뒤 헬스체커·워치가 그걸 실제 URL로 오인해 요청을 시도하게 된다.
    const collision = await db.product.findUnique({
      where: {
        creatorId_musinsaGoodsNo: { creatorId: deal.creatorId, musinsaGoodsNo: parsed.link.goodsNo },
      },
    });
    if (collision && collision.id !== deal.productId) {
      // 같은 상품이 이미 다른 경로(링크 던지기 등)로 등록돼 있다 — 두 Product를 자동으로
      // 합치지 않는다(자동 병합은 v2 과제, docs/06 §4.2). 사람이 보도록 경고만 남긴다.
      linkWarnings.push(
        `이 링크의 상품(#${parsed.link.goodsNo})은 이미 다른 항목으로 등록돼 있습니다 — 중복 상품일 수 있습니다.`
      );
    } else {
      const canonical = canonicalizeMusinsaUrl(parsed.link.rawUrl);
      if (canonical.ok) {
        await db.product.update({
          where: { id: deal.productId },
          data: { musinsaGoodsNo: parsed.link.goodsNo, canonicalUrl: canonical.value },
        });
      }
    }
  }
  if (!parsed.link.hasCommissionParams) {
    // 거부하지 않고 경고한다: 무신사가 파라미터 이름을 바꾸면 정상 링크를 전부 막게 되므로,
    // 판정은 사람에게 맡기되 승인 화면에서 반드시 보이게 한다.
    linkWarnings.push("커미션 파라미터가 없습니다 — 큐레이터센터에서 만든 링크가 맞는지 확인하세요.");
  }

  const curatorLink = await db.curatorLink.create({
    data: {
      dealId: deal.id,
      rawUrl: parsed.link.rawUrl,
      ulid: parsed.link.ulid,
      isDefault: true,
      // 첫 헬스체크는 지금이 아니라 1~6시간 뒤부터. 발행 시각과 점검 시각이 동기화되면
      // 무신사 쪽에서 "이 큐레이터의 크롤러"라는 지문이 남는다(docs/03 §4.3).
      healthCheckAfter: firstCheckAt(),
    },
  });

  // 링크허브용 숏링크를 발급한다(자기 소유 지면이라 safe 모드에서도 숏링크를 쓴다).
  // 이 코드가 있어야 품절 시 착지점만 바꿔 과거 게시물까지 한 번에 구제된다.
  try {
    await ensureShortLink({
      dealId: deal.id,
      curatorLinkId: curatorLink.id,
      targetUrl: parsed.link.rawUrl,
      surface: "hub",
    });
  } catch (err) {
    // 숏링크 발급 실패가 카드 생성을 막지는 않는다 — 카톡·스레드는 어차피 원본 링크를 쓴다.
    console.error("[shortlink] 발급 실패", deal.id, err);
  }

  if (linkWarnings.length > 0) {
    await audit({
      actor: "SYSTEM",
      action: "link.warning",
      approvalRef: deal.id,
      detail: linkWarnings.join(" / "),
    });
  }

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

  await renderAndShowApproval(deal.id, chatId, linkWarnings);
}

/** [훅 교체] 후 받은 새 훅 문구를 반영하고 승인 카드를 다시 그린다 */
async function handleHookReplacement(deal: DealRecord, text: string, chatId: string) {
  const hook = text.trim();
  if (!hook) {
    await sendMessage({ chatId, text: "훅 문구가 비어 있습니다. 한 줄로 보내주세요." });
    return;
  }
  if (hook.length > 200) {
    await sendMessage({ chatId, text: "훅 문구가 너무 깁니다(200자 이내). 다시 보내주세요." });
    return;
  }

  await db.deal.update({ where: { id: deal.id }, data: { hookLine: hook } });
  await renderAndShowApproval(deal.id, chatId, []);
}

/** 딜의 현재 사실로 4채널 카드를 새 버전으로 렌더하고 승인 카드를 띄운다 */
async function renderAndShowApproval(dealId: string, chatId: string, linkWarnings: string[]) {
  const deal = await db.deal.findUniqueOrThrow({
    where: { id: dealId },
    include: DEAL_WITH_RELATIONS,
  });

  const rendered = renderAllChannels(toFacts(deal));
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
      data: {
        status: "READY",
        approvalStage: "READY_TO_PUBLISH",
        // 입력 대기 해제 — 이제 봇은 이 대화에서 아무 텍스트도 기다리지 않는다.
        pendingInput: null,
      },
    });
  });

  const final = await db.deal.findUniqueOrThrow({
    where: { id: deal.id },
    include: DEAL_WITH_RELATIONS,
  });
  const kakao = rendered.find((r) => r.ok && r.card.channel === "KAKAO_OPEN");
  const preview = kakao && kakao.ok ? kakao.card.bodyText : "";

  await updateCard(final, approvalCard(toCardDeal(final, linkWarnings), preview));
}

// ── 콜백(버튼) 처리 ──────────────────────────────────────────────────────

async function handleCallback(query: TgCallbackQuery): Promise<void> {
  // 인가 확인이 먼저다. answerCallback을 먼저 부르면 비인가 사용자에게도 스피너가 정상 종료되어
  // "봇이 살아 있다"를 알려준다 — 메시지 경로는 조용히 무시하는데 콜백만 응답하면 앞뒤가 안 맞는다.
  if (!isAuthorized(query.from.id)) {
    await audit({
      actor: "SYSTEM",
      action: "telegram.unauthorized",
      detail: `허용되지 않은 사용자의 콜백 ${query.from.id}`,
    });
    return;
  }

  // 인가된 사용자에게는 즉시 응답한다 — 콜백 ID는 10~15초 만에 만료되고,
  // 게이트웨이의 최소 간격(5초+지터) 뒤에 부르면 십중팔구 늦는다.
  await answerCallback(query.id);

  const parsed = query.data ? parseCallbackData(query.data) : null;
  if (!parsed) return;

  const deal = await db.deal.findUnique({
    where: { id: parsed.dealId },
    include: DEAL_WITH_RELATIONS,
  });
  if (!deal) return;

  const chatId = String(deal.telegramChatId ?? query.from.id);

  switch (parsed.action) {
    case "int":
      await setStage(deal.id, "AWAITING_LINK");
      await setPendingInput(deal.id, chatId, "CURATOR_LINK");
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
      await db.deal.update({ where: { id: deal.id }, data: { pendingInput: null } });
      await updateCard(deal, skippedCard(toCardDeal(deal)));
      await audit({ actor: "HUMAN", action: "deal.skipped", approvalRef: deal.id });
      break;

    case "hok":
      // 훅 대기임을 명시적으로 기록한다. 예전처럼 approvalStage만 되돌리면
      // 이어서 보낸 훅 문구가 큐레이터 링크 파서로 들어가 "링크를 찾지 못했습니다"만 반복됐다.
      await setPendingInput(deal.id, chatId, "HOOK");
      await sendMessage({ chatId, text: "✏️ 새 훅 문구를 보내주세요. (한 줄)" });
      break;

    case "new":
      // 링크 대기를 풀고 새 상품 URL을 다시 보내게 한다.
      await db.deal.update({ where: { id: deal.id }, data: { pendingInput: null } });
      await sendMessage({ chatId, text: "대기를 해제했습니다. 상품 링크를 다시 보내주세요." });
      break;

    case "man": {
      // 딜을 지정해 대시보드로 보낸다 — 링크 없이 루트로만 보내면 텔레그램에서 시작한 딜을
      // 웹에서 이어받을 수 없어 동선이 끊긴다.
      const base = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
      await sendMessage({
        chatId,
        text: "✏️ 웹 대시보드에서 상품 정보를 채워주세요.",
        keyboard: [[{ text: "🌐 대시보드에서 편집", url: `${base.replace(/\/$/, "")}/?deal=${deal.id}` }]],
      });
      break;
    }

    case "wch": {
      // 버튼 한 번으로 워치 등록 — 카드는 그대로 두고 별도 메시지로 결과만 알린다.
      // (카드를 갈아끼우면 진행 중이던 승인 흐름의 버튼이 사라진다.)
      const label = `${escapeHtml(deal.product.brandName)} ${escapeHtml(deal.product.productName)}`;
      await sendMessage({
        chatId,
        text: await watchAddedMessage(label, await addWatch(deal.productId)),
      });
      break;
    }

    case "hlp":
      // 카드는 건드리지 않는다 — 설명을 보려다 진행 중인 카드의 버튼이 사라지면 안 된다.
      await sendMessage({ chatId, text: BUTTON_GUIDE });
      break;

    case "apv":
      await approveDeal(deal);
      break;
  }
}

async function approveDeal(deal: DealRecord): Promise<void> {
  // 관계 배열에서 find로 집으면 재렌더된 v2 대신 v1(구버전)이 잡힌다 —
  // 승인 화면에 보인 것과 실제 나가는 것이 달라지고, 감사 로그도 엉뚱한 본문을 증적으로 남긴다.
  const kakaoCard = await latestCard(deal.id, "KAKAO_OPEN");
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
