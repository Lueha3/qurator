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
import { extractFromScreenshot, type ScreenshotImage } from "./vision-extract";
import { matchOrCreateProduct, type MatchedBy } from "./product-match";
import { renderAllChannels, type DealFacts, type DealLink } from "./renderer";
import { audit } from "./audit";
import { ensureShortLink } from "./shortlink";
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
  /** 상품 페이지가 아닌 화면(장바구니·옵션 시트·홈) — 기록할 것이 없어 딜·스냅샷을 만들지 않는다 */
  | { kind: "not_product_page" }
  /** Vision 실패(API 장애·타임아웃·키 없음) — 빈 딜을 만들지 않고 안내만 한다 */
  | { kind: "vision_failed" };

/**
 * 스크린샷 1장 이상으로 상품을 캡처한다 — docs/06 §3-§4의 1차 입력 경로.
 * 여러 장이면 같은 상품 페이지를 위/아래로 나눠 찍은 것으로 보고 Vision에 한 번에 보낸다.
 * 무신사에 요청을 전혀 보내지 않는다: Vision이 화면에서 직접 읽으므로 게이트웨이를 거치지 않는다(§7).
 */
export async function captureFromScreenshots(images: ScreenshotImage[]): Promise<CaptureResult> {
  const result = await extractFromScreenshot(images.slice(0, MAX_CAPTURE_IMAGES));
  if (!result) return { kind: "vision_failed" };
  if (!result.isProductPage) return { kind: "not_product_page" };

  const creator = await getDefaultCreator();
  const { product, matchedBy } = await matchOrCreateProduct({
    creatorId: creator.id,
    brand: result.brand,
    productName: result.productName,
    styleCode: result.styleCode,
  });

  // 정가는 Product의 사실이다 — 화면에서 읽힌 정가로 갱신한다. 정가 없이 판매가만 읽혔고 아직
  // 정가를 모르는(0) 상품이면 판매가를 정가 자리에 둔다: 0을 그대로 두면 카드에 "0원"이
  // 고지문과 함께 찍혀 나간다 (수동 폼 경로의 listPrice ?? salePrice ?? 0과 같은 규칙).
  const listPriceReading =
    result.listPrice ?? (product.listPrice === 0 ? result.salePrice : null);
  if (listPriceReading !== null && listPriceReading !== product.listPrice) {
    await db.product.update({ where: { id: product.id }, data: { listPrice: listPriceReading } });
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
    await db.deal.update({
      where: { id: open.id },
      data: {
        // 화면이 현재 가격의 근거다. 다만 이번에 못 읽은 값으로 이미 있는 값을 지우지는 않는다.
        salePrice: result.salePrice ?? open.salePrice,
        discountRate: result.discountRateShown ?? open.discountRate,
        parseSource: parseFieldCount > 0 ? "vision" : open.parseSource,
        parseFieldCount: Math.max(parseFieldCount, open.parseFieldCount),
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

/** "기록 완료" — 삭제가 아니다. 가격은 캡처 시점에 이미 저장됐고, 발행만 하지 않는 것이다. */
export async function skipDeal(dealId: string): Promise<void> {
  await setStage(dealId, "SKIPPED");
  await audit({ actor: "HUMAN", action: "deal.skipped", approvalRef: dealId });
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
        parseSource: deal.parseSource === "none" ? "manual" : undefined,
      },
    });
  });

  await audit({
    actor: "HUMAN",
    action: "deal.edited",
    approvalRef: deal.id,
    detail: `정보 고치기: ${Object.keys(patch).join(", ")}`,
  });

  // 카드가 이미 있으면(발행 승인 단계 이상) 현재 사실로 새 버전을 렌더한다.
  const hasCards = (await db.contentCard.count({ where: { dealId: deal.id } })) > 0;
  if (hasCards && deal.approvalStage === "READY_TO_PUBLISH") {
    const rendered = await renderCards(deal.id);
    if (!rendered.ok) return rendered;
    return { ok: true, rerendered: true };
  }
  return { ok: true, rerendered: false };
}
