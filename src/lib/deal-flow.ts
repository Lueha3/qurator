// 딜 상태 머신 — docs/02-architecture.md §6 (2026-09-14: 텔레그램 콕핏 → 웹 콕핏).
//
//   스크린샷 업로드 → [후보] --올릴게요--> [링크 대기] --링크 붙여넣기--> [발행 승인] --승인--> 복사
//
// 이 파일은 전송 수단(웹 UI·서버 액션·API 라우트)을 모른다. 상태 전이와 그 불변식만 담당하고,
// 결과를 값으로 돌려준다 — 화면이 그것을 어떻게 보여줄지는 호출부의 일이다.
//
// 이미지 바이트는 captureFromScreenshots의 인자로 잠깐 존재하다가 Vision 호출이 끝나면 버려진다.
// 디스크·DB·로그·감사 기록 어디에도 쓰지 않는다 (docs/06 §4.3).

import { db } from "./db";
import { getDefaultCreator } from "./creator";
import { canonicalizeMusinsaUrl } from "./url-guard";
import { parseCuratorLink } from "./curator-link";
import { recordSnapshot } from "./price-snapshot";
import { buildPriceAnalyses, buildPriceChangeNote } from "./price-analysis";
import { draftHookLine } from "./ai-hook";
import {
  extractFromScreenshot,
  type ScreenshotImage,
  type VisionFailReason,
  type VisionGridItem,
} from "./vision-extract";
import { matchOrCreateProduct, type MatchedBy } from "./product-match";
import { renderAllChannels, type DealFacts, type DealLink } from "./renderer";
import { audit } from "./audit";
import { ensureShortLink } from "./shortlink";
import { addWatch } from "./watch";
import { serializeTags } from "./deal-tags";
import { firstCheckAt } from "./health-check";
import type { ApprovalStage, Channel } from "@prisma/client";

/** 한 캡처에 합칠 최대 장수 — 상품 페이지는 위/아래로 나눠 2~3장이면 충분하다 (docs/06 §4.4). */
export const MAX_CAPTURE_IMAGES = 4;

// ── 조회 헬퍼 ────────────────────────────────────────────────────────────

const DEAL_WITH_RELATIONS = {
  product: true,
  creator: true,
  curatorLinks: true,
};

type DealRecord = NonNullable<
  Awaited<ReturnType<typeof db.deal.findFirst<{ include: typeof DEAL_WITH_RELATIONS }>>>
>;

async function loadDeal(dealId: string): Promise<DealRecord | null> {
  return db.deal.findUnique({ where: { id: dealId }, include: DEAL_WITH_RELATIONS });
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

/**
 * 승인·미리보기에 쓸 카드는 **항상 최신 버전**이어야 한다 — 재렌더된 v2 대신 v1을 집으면
 * 승인 화면에 보인 것과 실제 나가는 것이 달라져 approval-first의 근거가 무너진다.
 */
export async function latestCard(dealId: string, channel: Channel) {
  return db.contentCard.findFirst({
    where: { dealId, channel },
    orderBy: { version: "desc" },
  });
}

async function setStage(dealId: string, stage: ApprovalStage) {
  await db.deal.update({ where: { id: dealId }, data: { approvalStage: stage } });
}

// ── 1. 캡처 ──────────────────────────────────────────────────────────────

export type CaptureResult =
  | {
      kind: "created";
      dealId: string;
      matchedBy: MatchedBy;
      priceChangeNote: string | null;
      /** 새 카드가 아니라 이미 열려 있던 카드를 갱신했는가 — 사람에게 다르게 말해야 한다 */
      reused: boolean;
    }
  /**
   * 좋아요 목록 같은 그리드 화면 — 딜을 만들지 않고 **지켜보는 상품**으로 담는다 (docs/06 §4.6).
   * 한 장에 24개가 들어오는데 그걸 전부 딜로 만들면 "오늘 할 일"이 300줄이 된다. 목록에 담은
   * 상품은 아직 올릴지 정한 것이 아니라 "값을 지켜볼 것"이라, 딜은 사람이 고를 때 만들어진다.
   */
  | {
      kind: "grid";
      /** 처음 담긴 상품 */
      added: number;
      /** 이미 담겨 있어 가격만 갱신된 상품 */
      updated: number;
      /** 그중 지난번보다 싸진 상품 */
      cheaper: number;
      /** 이름이나 가격을 못 읽어 건너뛴 칸 */
      skipped: number;
    }
  /** 상품 페이지가 아닌 화면(장바구니·옵션 시트·홈) — 기록할 것이 없어 딜·스냅샷을 만들지 않는다 */
  | { kind: "not_product_page" }
  /** Vision 실패(API 장애·타임아웃·키 없음) — 빈 딜을 만들지 않고 안내만 한다 */
  | { kind: "vision_failed"; reason: VisionFailReason };

/**
 * 스크린샷 1장 이상으로 상품을 캡처한다 — docs/06 §3-§4의 1차 입력 경로.
 * 여러 장이면 같은 상품 페이지를 위/아래로 나눠 찍은 것으로 보고 Vision에 한 번에 보낸다.
 * 무신사에 요청을 전혀 보내지 않는다: Vision이 화면에서 직접 읽으므로 게이트웨이를 거치지 않는다(§7).
 */
/**
 * 그리드 화면에서 읽은 상품들을 **지켜보는 상품**으로 담는다 (docs/06 §4.6).
 *
 * 딜을 만들지 않는 것이 핵심이다. 좋아요 목록 300개를 담는 목적은 지금 올릴 것을 고르는 게 아니라
 * **가격이 내려가는 순간을 잡는 것**이고, 그 판단의 재료는 스냅샷이다. 목록을 다시 찍을 때마다
 * 300개 가격이 한 번에 갱신되고, 싸진 상품은 홈이 따로 띄운다.
 *
 * 한 칸에서 읽히는 것은 브랜드·상품명·지금 가격·할인율뿐이다. 품번이 없으므로 매칭은
 * (브랜드, 상품명) 정규화 일치에만 기댄다 — 같은 이름의 다른 색상은 한 상품으로 합쳐질 수 있는데,
 * 가격을 지켜보는 목적에서는 그게 틀린 합치기가 아니다(색상별 가격이 다르면 딜을 만들 때 갈라진다).
 */
async function captureGridItems(items: VisionGridItem[]): Promise<CaptureResult> {
  const creator = await getDefaultCreator();
  let added = 0;
  let updated = 0;
  let cheaper = 0;
  let skipped = 0;
  const touched: string[] = [];

  for (const item of items) {
    // 이름도 가격도 없는 칸은 기록할 사실이 없다. Vision 파서가 이미 한 번 거르지만, DB에 쓰는
    // 쪽에서 다시 막는다 — 걸러졌겠거니 하고 쓰면 "(브랜드 미입력) 0원" 상품이 목록에 쌓인다.
    if ((item.brand === null && item.productName === null) || item.salePrice === null) {
      skipped++;
      continue;
    }

    const { product, matchedBy } = await matchOrCreateProduct({
      creatorId: creator.id,
      brand: item.brand,
      productName: item.productName,
      styleCode: null,
    });

    // 그리드에는 정가가 없다. 0("미확인" sentinel — product-match.ts와 동일한 관례)을
    // 그대로 둔다: 판매가를 정가 자리에 채우면 나중에 진짜 가격이 그 아래로 떨어졌을 때
    // 검증된 적 없는 그 값이 취소선 "정가"로 나간다(표시광고법 오인표시 위험, 2026-09-21
    // 발견). "0원" 노출은 렌더러가 listPrice=0을 "정가 모름"으로 처리하는 쪽에서 막는다
    // (renderer.ts priceLine).

    const before = await db.priceSnapshot.findFirst({
      where: { productId: product.id, source: { not: "MANUAL" }, salePrice: { not: null } },
      orderBy: { capturedAt: "desc" },
    });

    const { recorded } = await recordSnapshot({
      productId: product.id,
      listPrice: null,
      salePrice: item.salePrice,
      couponPrice: null,
      // 화면에 찍힌 할인율 그대로 — 예전에는 vision이 읽어와도 저장할 자리가 없어 여기서 버려졌다
      // (2026-09-20, 실사용자 제보로 발견). 기준가 대비 실할인율은 price-analysis.ts가 따로 계산한다.
      discountRateShown: item.discountRateShown,
      source: "SCREENSHOT",
    });
    if (!recorded) {
      skipped++;
      continue;
    }

    if (before?.salePrice != null && item.salePrice !== null && item.salePrice < before.salePrice) {
      cheaper++;
    }
    if (matchedBy === "created") added++;
    else updated++;
    touched.push(product.id);
  }

  // 담기는 기록이 끝난 뒤에 한다 — 상한에 걸려 거부돼도 가격은 이미 남는다.
  let newlyWatched = 0;
  for (const productId of touched) {
    const r = await addWatch(productId, new Date(), { bulk: true });
    if (r.ok && !r.alreadyActive) newlyWatched++;
  }

  await audit({
    actor: "HUMAN",
    action: "capture.grid",
    detail: `목록에서 ${items.length}칸 읽음 — 새 상품 ${added} · 갱신 ${updated} · 싸짐 ${cheaper} · 지켜보기 추가 ${newlyWatched}`,
  });

  return { kind: "grid", added, updated, cheaper, skipped };
}

/**
 * 지켜보는 상품에서 딜을 시작한다 (docs/06 §4.6). 좋아요 목록으로 담긴 상품은 딜이 없으므로,
 * "이건 올려야겠다"고 정한 순간 여기서 카드가 생긴다.
 *
 * 이미 끝나지 않은 딜이 있으면 새로 만들지 않고 그것을 돌려준다 — 같은 상품의 판단이 두 장으로
 * 갈라지면 어느 쪽이 진짜인지 알 수 없다(캡처 경로가 열린 딜을 재사용하는 것과 같은 이유).
 *
 * 가격은 마지막 스냅샷에서 가져온다. 그리드에서 읽은 값이라 정가는 모를 수 있고, 그건 카드가
 * "정보 고치기"로 채우라고 말한다.
 */
export async function startDealFromProduct(
  productId: string
): Promise<{ ok: true; dealId: string; reused: boolean } | { ok: false; reason: string }> {
  const product = await db.product.findUnique({ where: { id: productId } });
  if (!product) return { ok: false, reason: "이 상품을 찾을 수 없어요. 화면을 새로고침해 주세요." };

  const open = await db.deal.findFirst({
    where: {
      productId,
      approvalStage: { in: ["CANDIDATE", "AWAITING_LINK", "READY_TO_PUBLISH"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (open) return { ok: true, dealId: open.id, reused: true };

  const latest = await db.priceSnapshot.findFirst({
    where: { productId, source: { not: "MANUAL" } },
    orderBy: { capturedAt: "desc" },
  });

  const deal = await db.deal.create({
    data: {
      productId,
      creatorId: product.creatorId,
      status: "DRAFT",
      approvalStage: "CANDIDATE",
      salePrice: latest?.salePrice ?? null,
      // 그리드에는 정가가 없어 할인율을 믿을 수 없다 — 화면에서 읽은 값만 쓴다는 규칙대로 비워 둔다.
      parseSource: "vision",
      parseFieldCount: [product.brandName, product.productName, latest?.salePrice ?? null].filter(
        (v) => v !== null && v !== undefined
      ).length,
    },
  });

  await audit({
    actor: "HUMAN",
    action: "deal.started_from_watch",
    approvalRef: deal.id,
    detail: `지켜보는 상품에서 딜 시작 — ${product.brandName} ${product.productName}`,
  });

  return { ok: true, dealId: deal.id, reused: false };
}

export async function captureFromScreenshots(images: ScreenshotImage[]): Promise<CaptureResult> {
  const result = await extractFromScreenshot(images.slice(0, MAX_CAPTURE_IMAGES));
  // null은 옛 계약(이유 없는 실패) — 테스트 목이 아직 쓰므로 함께 받아 준다.
  if (!result) return { kind: "vision_failed", reason: "bad-response" };
  if ("failed" in result) return { kind: "vision_failed", reason: result.reason };
  // 그리드가 먼저다 — 목록 화면은 isProductPage가 false로 오므로 아래 분기에 걸리면
  // "상품 페이지를 찍어주세요"라는 엉뚱한 안내가 나간다.
  if (result.gridItems !== null) return captureGridItems(result.gridItems);
  if (!result.isProductPage) return { kind: "not_product_page" };

  const creator = await getDefaultCreator();
  const { product, matchedBy } = await matchOrCreateProduct({
    creatorId: creator.id,
    brand: result.brand,
    productName: result.productName,
    styleCode: result.styleCode,
  });

  // 정가는 Product의 사실이다 — 화면에서 **실제로 읽힌** 정가로만 갱신한다. 정가를 못
  // 읽었으면 listPrice는 "미확인"(0) 그대로 둔다. 판매가를 정가 자리에 채웠다가 나중에
  // 진짜 가격이 그 아래로 떨어지면, 검증된 적 없는 그 값이 취소선 "정가"로 나간다
  // (표시광고법 오인표시 위험 — 틀린 판매가보다 무겁다, 2026-09-21 발견). "0원" 노출은
  // 렌더러가 listPrice=0을 "정가 모름"으로 처리하는 쪽에서 막는다 (renderer.ts priceLine).
  if (result.listPrice !== null && result.listPrice !== product.listPrice) {
    await db.product.update({ where: { id: product.id }, data: { listPrice: result.listPrice } });
  }

  // 피기백 스냅샷 — 가격을 하나도 못 읽었으면 recordSnapshot이 조용히 건너뛴다.
  await recordSnapshot({
    productId: product.id,
    listPrice: result.listPrice,
    salePrice: result.salePrice,
    couponPrice: result.couponPrice,
    source: "SCREENSHOT",
  });

  // 방금 기록한 스냅샷이 포함된 상태로 다시 읽으므로 previous는 그 직전 기록이 된다.
  // 첫 기록이면(비교할 게 없으면) null.
  const priceChangeNote = buildPriceChangeNote(
    (await buildPriceAnalyses([product.id])).get(product.id)
  );

  const parseFieldCount = [
    result.brand,
    result.productName,
    result.listPrice,
    result.salePrice,
  ].filter((v) => v !== null).length;

  // 아직 손대지 않은 딜이 이 상품에 있으면 **새로 만들지 않고 그것을 갱신한다**.
  //
  // 홈의 리마인더가 "오늘 가격을 기록할 상품 N개 — 다시 찍어 올려주세요"라고 매일 조르는데
  // (docs/05 §3.4, 크롤리스 모드에서 기준가가 쌓이는 유일한 경로다), 캡처마다 딜을 만들면
  // 같은 상품의 후보 카드가 **매일 한 장씩 쌓인다**. 실제 운영에서 후보가 13장까지 불어났고
  // 그중 상당수가 같은 상품이었다 — 딜 탭이 "지금 할 일"을 보여주는 화면이기를 그만둔 것이다.
  //
  // 승인·기록 완료된 딜은 재사용하지 않는다. 그건 끝난 판단이고, 다시 찍었다는 것은
  // 새로 판단할 일이 생겼다는 뜻이다.
  const open = await db.deal.findFirst({
    where: {
      productId: product.id,
      approvalStage: { in: ["CANDIDATE", "AWAITING_LINK", "READY_TO_PUBLISH"] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (open) {
    // 사람이 이미 고친 딜(parseSource='manual')은 재캡처의 새 OCR 값으로 덮지 않는다 — 안
    // 그러면 힘들게 고친 값이 다음 캡처 한 번에 흔적도 없이 사라진다(2026-09-21 발견).
    // 새 OCR 값은 위에서 이미 스냅샷으로 기록됐으니, 가격이 실제로 바뀌었다면 priceChangeNote로
    // 사람 눈에 띈다 — 다시 고칠지는 사람이 판단한다.
    const preserveManualCorrection = open.parseSource === "manual";

    await db.deal.update({
      where: { id: open.id },
      data: {
        // 화면이 현재 가격의 근거다. 다만 이번에 못 읽은 값이나, 사람이 이미 고친 값은 지우지 않는다.
        salePrice: preserveManualCorrection ? open.salePrice : (result.salePrice ?? open.salePrice),
        discountRate: preserveManualCorrection
          ? open.discountRate
          : (result.discountRateShown ?? open.discountRate),
        parseSource: preserveManualCorrection
          ? open.parseSource
          : (parseFieldCount > 0 ? "vision" : open.parseSource),
        parseFieldCount: Math.max(parseFieldCount, open.parseFieldCount),
        // 확신도·애매한 점도 최신 캡처 것으로 — 사람이 이미 고친 딜은 부정확했을 옛 읽기
        // 흔적을 새로 덮지 않는다(위 preserveManualCorrection과 같은 판단).
        visionConfidence: preserveManualCorrection ? open.visionConfidence : result.confidence,
        visionNotes: preserveManualCorrection ? open.visionNotes : result.notes,
      },
    });

    // 승인 대기 카드는 "본 것 = 나가는 것"이다 — 가격이 바뀌었으면 카드도 다시 렌더해야
    // 옛 가격이 고지문과 함께 나가는 일이 없다 (docs/02 §6).
    if (open.approvalStage === "READY_TO_PUBLISH") await renderCards(open.id);

    await audit({
      actor: "HUMAN",
      action: "deal.recaptured",
      approvalRef: open.id,
      detail: `스크린샷 ${images.length}장 재캡처 (웹 업로드) → 기존 ${open.approvalStage} 딜 갱신`,
    });

    return { kind: "created", dealId: open.id, matchedBy, priceChangeNote, reused: true };
  }

  const deal = await db.deal.create({
    data: {
      productId: product.id,
      creatorId: creator.id,
      status: "DRAFT",
      approvalStage: "CANDIDATE",
      salePrice: result.salePrice,
      // 화면에 찍힌 할인율 그대로 — 기준가 대비 실할인율은 price-analysis가 따로 계산한다.
      discountRate: result.discountRateShown,
      parseSource: "vision",
      parseFieldCount,
      visionConfidence: result.confidence,
      visionNotes: result.notes,
    },
  });

  await audit({
    actor: "HUMAN",
    action: "deal.captured",
    approvalRef: deal.id,
    // 이미지 자체는 절대 남기지 않는다 — 매칭 결과만 증적으로 남는다 (docs/06 §4.3/§7).
    detail: `스크린샷 ${images.length}장 캡처 (웹 업로드) → 상품 매칭 ${matchedBy}`,
  });

  return { kind: "created", dealId: deal.id, matchedBy, priceChangeNote, reused: false };
}

// ── 2. 후보 → 링크 대기 / 기록 완료 ─────────────────────────────────────

export async function markInterested(dealId: string): Promise<void> {
  await setStage(dealId, "AWAITING_LINK");
}

/** "안 올릴게요" — 삭제가 아니다. 가격은 캡처 시점에 이미 저장됐고, 발행만 하지 않는 것이다. */
export async function skipDeal(dealId: string): Promise<void> {
  await setStage(dealId, "SKIPPED");
  await audit({ actor: "HUMAN", action: "deal.skipped", approvalRef: dealId });
}

/**
 * "다시 열기" — 안 올리기로 했던 딜을 되살린다(SKIPPED → CANDIDATE). 2026-09-18 추가.
 *
 * 왜 필요한가: 화면은 "지우는 게 아니에요"라고 말하는데 되돌릴 길이 없어서, 잘못 눌렀으면 같은 상품을
 * 다시 찍어 올려야 했다. 그러면 딜이 하나 더 생기고(중복 정리 대상), 그 사이 가격이 그대로면 기록도
 * 의미가 없다. 되살리는 편이 데이터가 깨끗하다.
 *
 * **발행된 딜은 되돌리지 않는다.** 이 함수는 SKIPPED에서만 동작한다 — APPROVED를 후보로 되돌리면
 * 이미 나간 카톡 문구·팔로워 페이지와 앱의 상태가 어긋난다(품절 표시는 그쪽의 되돌리기다).
 * 링크가 이미 붙어 있던 딜이면 링크 대기가 아니라 후보로 보낸다: 그때 판단이 끝났다는 보장이 없고,
 * 후보 카드가 "올릴게요"로 다시 링크 단계로 갈 길을 이미 갖고 있다.
 */
export async function reopenDeal(dealId: string): Promise<{ ok: boolean; reason?: string }> {
  const deal = await db.deal.findUnique({ where: { id: dealId }, select: { approvalStage: true } });
  if (!deal) return { ok: false, reason: "이 딜을 찾을 수 없어요. 화면을 새로고침해 주세요." };
  if (deal.approvalStage !== "SKIPPED") {
    return { ok: false, reason: "이미 열려 있는 딜이에요." };
  }
  await setStage(dealId, "CANDIDATE");
  await audit({ actor: "HUMAN", action: "deal.reopened", approvalRef: dealId });
  return { ok: true };
}

// ── 3. 큐레이터 링크 → 카드 렌더 ─────────────────────────────────────────

export type AttachLinkResult =
  | { ok: true; warnings: string[] }
  | { ok: false; reason: string };

/**
 * 붙여넣은 큐레이터 링크를 받아 4채널 카드를 렌더하고 발행 승인 단계로 옮긴다.
 * 링크는 문자열로만 파싱한다 — 방문하면 현표 자신의 클릭이 실적으로 잡힌다(docs/03 §5.4).
 */
export async function attachCuratorLink(dealId: string, text: string): Promise<AttachLinkResult> {
  const deal = await loadDeal(dealId);
  if (!deal) return { ok: false, reason: "이 딜을 찾을 수 없어요. 화면을 새로고침해 주세요." };

  const parsed = parseCuratorLink(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const warnings: string[] = [];
  const expected = deal.product.musinsaGoodsNo;
  if (expected && parsed.link.goodsNo && parsed.link.goodsNo !== expected) {
    warnings.push(
      "이 링크는 다른 상품 링크 같아요. 큐레이터센터에서 이 상품 링크를 다시 만들어 붙여주세요."
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
      // 같은 상품이 이미 다른 경로로 등록돼 있다 — 두 Product를 자동으로 합치지 않는다.
      warnings.push(
        "이 상품은 이미 다른 딜에 있어요. 딜 탭에서 같은 상품을 찾아 거기서 이어서 하세요."
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
    warnings.push("큐레이터센터에서 만든 링크가 아닌 것 같아요. 이대로 올리면 수수료가 안 잡힐 수 있어요.");
  }

  const curatorLink = await db.curatorLink.create({
    data: {
      dealId: deal.id,
      rawUrl: parsed.link.rawUrl,
      ulid: parsed.link.ulid,
      isDefault: true,
      // 첫 헬스체크는 1~6시간 뒤부터 — 발행 시각과 점검 시각이 동기화되면 지문이 남는다(docs/03 §4.3).
      healthCheckAfter: firstCheckAt(),
    },
  });

  // 링크허브용 숏링크 — 품절 시 착지점만 바꿔 과거 게시물까지 한 번에 구제한다.
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

  if (warnings.length > 0) {
    await audit({
      actor: "SYSTEM",
      action: "link.warning",
      approvalRef: deal.id,
      detail: warnings.join(" / "),
    });
  }

  // 훅이 없으면 AI 초안을 시도한다. 실패해도(키 없음/타임아웃) 빈 훅으로 진행 — 렌더는 AI에 비의존.
  if (!deal.hookLine) {
    const hookLine = await draftHookLine({
      brand: deal.product.brandName,
      productName: deal.product.productName,
      discountRate: deal.discountRate,
      couponDesc: deal.couponDesc,
    });
    if (hookLine) {
      await db.deal.update({ where: { id: deal.id }, data: { hookLine } });
    }
  }

  const rendered = await renderCards(deal.id);
  if (!rendered.ok) return rendered;
  return { ok: true, warnings };
}

export type HookResult = { ok: true } | { ok: false; reason: string };

/** [훅 교체] — 새 훅을 반영하고 전 채널 카드를 새 버전으로 다시 렌더한다 */
export async function replaceHook(dealId: string, hookLine: string): Promise<HookResult> {
  const hook = hookLine.trim();
  if (!hook) return { ok: false, reason: "첫 줄 문구를 적어주세요." };
  if (hook.length > 200) return { ok: false, reason: "첫 줄 문구가 너무 길어요. 200자 안으로 줄여주세요." };

  await db.deal.update({ where: { id: dealId }, data: { hookLine: hook } });
  return renderCards(dealId);
}

/** 딜의 현재 사실로 4채널 카드를 새 버전으로 렌더하고 발행 승인 단계로 옮긴다 */
export async function renderCards(dealId: string): Promise<HookResult> {
  const deal = await loadDeal(dealId);
  if (!deal) return { ok: false, reason: "이 딜을 찾을 수 없어요. 화면을 새로고침해 주세요." };

  const rendered = renderAllChannels(toFacts(deal));
  const failed = rendered.find((r) => !r.ok);
  if (failed && !failed.ok) return { ok: false, reason: failed.error.message };

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

  return { ok: true };
}

// ── 4. 승인 ──────────────────────────────────────────────────────────────

export type ApproveResult =
  | { ok: true; cardId: string }
  | { ok: false; reason: "NO_CARD" | "DISCLOSURE_FAILED" };

export async function approveDeal(dealId: string): Promise<ApproveResult> {
  const kakaoCard = await latestCard(dealId, "KAKAO_OPEN");
  if (!kakaoCard) return { ok: false, reason: "NO_CARD" };

  // 고지문 검증 게이트 — disclosureOk가 false인 카드는 어떤 경로로도 나가지 않는다.
  // (docs/03 §1 불변식 I-3. 렌더러가 이미 검증했지만, 발행 직전에 한 번 더 확인한다.)
  if (!kakaoCard.disclosureOk) {
    await audit({
      actor: "SYSTEM",
      action: "publish.blocked_disclosure",
      approvalRef: dealId,
      channel: "KAKAO_OPEN",
    });
    return { ok: false, reason: "DISCLOSURE_FAILED" };
  }

  await db.$transaction(async (tx) => {
    await tx.deal.update({
      where: { id: dealId },
      data: { status: "PUBLISHED", approvalStage: "APPROVED" },
    });
    await tx.post.create({
      data: {
        contentCardId: kakaoCard.id,
        dealId,
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
    approvalRef: dealId,
    channel: "KAKAO_OPEN",
    payloadSnapshot: kakaoCard.bodyText,
    detail: "현표가 웹에서 승인 — 카톡 전송은 사람이 수행(반자동)",
  });

  return { ok: true, cardId: kakaoCard.id };
}

// ── 5. 정보 고치기 ───────────────────────────────────────────────────────

export interface DealFactsPatch {
  brand?: string;
  productName?: string;
  styleCode?: string | null;
  /** 정규 상품 URL — 스크린샷 상품에 아직 goodsNo가 없을 때 채운다. 큐레이터 링크가 아니어도 된다. */
  productUrl?: string | null;
  listPrice?: number;
  salePrice?: number | null;
  discountRate?: number | null;
  couponCode?: string | null;
  couponDesc?: string | null;
  finalPrice?: number | null;
  endsAt?: Date | null;
  curatorNote?: string | null;
  hookLine?: string | null;
  /** 링크허브 섹션 태그. 빈 배열이면 "태그 없음"으로 저장된다 (docs/08 §3.3) */
  tags?: string[];
}

export type UpdateFactsResult =
  | { ok: true; rerendered: boolean }
  | { ok: false; reason: string };

function nonNegativeInt(v: number | null | undefined): boolean {
  return v == null || (Number.isInteger(v) && v >= 0);
}

function fmtAuditVal(v: string | number | Date | null | undefined): string {
  if (v === null || v === undefined || v === "") return "(없음)";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * "정보 고치기: brand, listPrice"처럼 **필드 이름만** 남기던 예전 로그로는 무엇이 어떻게
 * 바뀌었는지 되짚을 수 없었다(2026-09-21 발견) — 특히 가격 오독을 사람이 고친 흔적이 가장
 * 가치 있는 기록인데 그게 지워지고 있었다. 바뀐 필드만, 전/후 값과 함께 남긴다.
 */
function describePatch(patch: DealFactsPatch, before: DealRecord): string {
  const parts: string[] = [];
  function check(label: string, beforeVal: string | number | Date | null, afterVal: string | number | Date | null | undefined) {
    if (afterVal === undefined) return;
    if (String(beforeVal ?? "") === String(afterVal ?? "")) return;
    parts.push(`${label} ${fmtAuditVal(beforeVal)}→${fmtAuditVal(afterVal)}`);
  }
  check("브랜드", before.product.brandName, patch.brand);
  check("상품명", before.product.productName, patch.productName);
  check("품번", before.product.styleCode, patch.styleCode);
  check("정가", before.product.listPrice, patch.listPrice);
  check("할인가", before.salePrice, patch.salePrice);
  check("할인율", before.discountRate, patch.discountRate);
  check("쿠폰코드", before.couponCode, patch.couponCode);
  check("쿠폰설명", before.couponDesc, patch.couponDesc);
  check("쿠폰가", before.finalPrice, patch.finalPrice);
  check("마감", before.endsAt, patch.endsAt);
  check("메모", before.curatorNote, patch.curatorNote);
  check("훅", before.hookLine, patch.hookLine);
  if (patch.productUrl !== undefined) parts.push(`URL ${fmtAuditVal(patch.productUrl)}`);
  if (patch.tags !== undefined) parts.push(`태그 [${patch.tags.join(", ")}]`);
  return parts.length > 0 ? parts.join(" · ") : Object.keys(patch).join(", ");
}

/**
 * Vision·파서가 잘못 읽은 값을 사람이 바로잡는다. 이미 카드가 렌더된 딜이면 새 버전으로 다시 렌더한다 —
 * 승인 화면이 보여주는 것은 언제나 현재 사실이어야 한다.
 */
export async function updateDealFacts(
  dealId: string,
  patch: DealFactsPatch
): Promise<UpdateFactsResult> {
  const deal = await loadDeal(dealId);
  if (!deal) return { ok: false, reason: "이 딜을 찾을 수 없어요. 화면을 새로고침해 주세요." };

  const brand = patch.brand?.trim();
  const productName = patch.productName?.trim();
  if (patch.brand !== undefined && !brand) return { ok: false, reason: "브랜드를 적어주세요." };
  if (patch.productName !== undefined && !productName) {
    return { ok: false, reason: "상품명을 적어주세요." };
  }
  for (const [label, value] of [
    ["정가", patch.listPrice],
    ["할인가", patch.salePrice],
    ["쿠폰 적용가", patch.finalPrice],
  ] as const) {
    if (!nonNegativeInt(value)) return { ok: false, reason: `${label}는 0 이상 숫자로 적어주세요.` };
  }
  if (patch.discountRate != null && (patch.discountRate < 0 || patch.discountRate > 100)) {
    return { ok: false, reason: "할인율은 0에서 100 사이로 적어주세요." };
  }
  if (patch.endsAt && Number.isNaN(patch.endsAt.getTime())) {
    return { ok: false, reason: "마감 시각을 다시 골라주세요." };
  }

  const productData: {
    brandName?: string;
    productName?: string;
    styleCode?: string | null;
    listPrice?: number;
    canonicalUrl?: string;
    musinsaGoodsNo?: string;
  } = {};
  if (brand) productData.brandName = brand;
  if (productName) productData.productName = productName;
  if (patch.styleCode !== undefined) productData.styleCode = patch.styleCode?.trim() || null;
  if (patch.listPrice !== undefined) productData.listPrice = patch.listPrice;

  if (patch.productUrl?.trim()) {
    const canonical = canonicalizeMusinsaUrl(patch.productUrl.trim());
    if (!canonical.ok) return { ok: false, reason: canonical.error.reason };
    const goodsNo = canonical.value.match(/\/products\/(\d+)/)?.[1] ?? null;
    if (goodsNo && goodsNo !== deal.product.musinsaGoodsNo) {
      const collision = await db.product.findUnique({
        where: { creatorId_musinsaGoodsNo: { creatorId: deal.creatorId, musinsaGoodsNo: goodsNo } },
      });
      if (collision && collision.id !== deal.productId) {
        return {
          ok: false,
          reason: "이 상품은 이미 다른 딜에 있어요. 딜 탭에서 같은 상품을 찾아 거기서 이어서 하세요.",
        };
      }
      productData.musinsaGoodsNo = goodsNo;
    }
    productData.canonicalUrl = canonical.value;
  }

  await db.$transaction(async (tx) => {
    if (Object.keys(productData).length > 0) {
      await tx.product.update({ where: { id: deal.productId }, data: productData });
    }
    await tx.deal.update({
      where: { id: deal.id },
      data: {
        salePrice: patch.salePrice,
        discountRate: patch.discountRate,
        couponCode: patch.couponCode === undefined ? undefined : patch.couponCode?.trim() || null,
        couponDesc: patch.couponDesc === undefined ? undefined : patch.couponDesc?.trim() || null,
        finalPrice: patch.finalPrice,
        endsAt: patch.endsAt,
        curatorNote: patch.curatorNote === undefined ? undefined : patch.curatorNote?.trim() || null,
        hookLine: patch.hookLine === undefined ? undefined : patch.hookLine?.trim() || null,
        tags: patch.tags === undefined ? undefined : serializeTags(patch.tags),
        // 사람이 손본 딜은 "읽지 못함" 상태가 아니다 — 후보 카드가 진행 버튼을 다시 내준다.
        // 가격 필드를 고쳤을 때도 'manual'로 바꾼다(parseSource가 이미 'vision'이어도) — 안
        // 그러면 재캡처가 "이 딜은 사람이 고쳤다"를 알 방법이 없어 다음 OCR로 고친 값을
        // 덮어써버린다(captureFromScreenshots의 preserveManualCorrection, 2026-09-21 발견).
        // 낮은 확신도 경고도 이제 무의미해지므로(parseSource==='vision' 조건에 걸려) 같이 사라진다.
        parseSource:
          deal.parseSource === "none" ||
          patch.listPrice !== undefined ||
          patch.salePrice !== undefined ||
          patch.discountRate !== undefined
            ? "manual"
            : undefined,
      },
    });
  });

  await audit({
    actor: "HUMAN",
    action: "deal.edited",
    approvalRef: deal.id,
    detail: `정보 고치기: ${describePatch(patch, deal)}`,
  });

  // 사람이 고친 가격이 다음 캡처·기준가 계산의 근거가 되게 한다 — 안 그러면 고친 값이
  // price_snapshots에 전혀 남지 않아 computeBaseline·price-drop·최저가 배지가 계속
  // 틀린 OCR 값을 근거로 삼는다(2026-09-21 발견). CORRECTED는 MANUAL과 달리 "오늘 화면의
  // 진짜 값"이라 SCREENSHOT과 동급으로 최신가 계산에 들어간다(스키마 주석 참고).
  if (patch.listPrice !== undefined || patch.salePrice !== undefined) {
    const corrected = await loadDeal(dealId);
    if (corrected) {
      await recordSnapshot({
        productId: corrected.productId,
        listPrice: corrected.product.listPrice > 0 ? corrected.product.listPrice : null,
        salePrice: corrected.salePrice,
        couponPrice: null,
        discountRateShown: corrected.discountRate,
        source: "CORRECTED",
        note: "사람이 정보 고치기로 바로잡은 값",
      });
    }
  }

  // 카드가 이미 있으면(발행 승인 단계 이상) 현재 사실로 새 버전을 렌더한다.
  const hasCards = (await db.contentCard.count({ where: { dealId: deal.id } })) > 0;
  if (hasCards && deal.approvalStage === "READY_TO_PUBLISH") {
    const rendered = await renderCards(deal.id);
    if (!rendered.ok) return rendered;
    return { ok: true, rerendered: true };
  }
  return { ok: true, rerendered: false };
}
