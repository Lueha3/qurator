import type { ApprovalStage, Channel, LinkHealth } from "@prisma/client";
import type { DealDTO, PriceHistoryDTO } from "./api-types";
import { buildPriceChangeNote, discountRate, type PriceAnalysis } from "./price-analysis";
import { formatRelativeFromNow } from "./format";
import { parseTags } from "./deal-tags";

export const DEAL_INCLUDE = {
  product: { include: { watchItem: { select: { active: true, expiresAt: true } } } },
  curatorLinks: { select: { id: true, health: true } },
  contentCards: { orderBy: { channel: "asc" as const } },
};

type DealWithRelations = {
  id: string;
  productId: string;
  status: string;
  approvalStage: ApprovalStage;
  parseSource: string | null;
  visionConfidence: string | null;
  visionNotes: string | null;
  salePrice: number | null;
  discountRate: number | null;
  couponCode: string | null;
  couponDesc: string | null;
  finalPrice: number | null;
  endsAt: Date | null;
  curatorNote: string | null;
  hookLine: string | null;
  tags: string | null;
  createdAt: Date;
  product: {
    id: string;
    brandName: string;
    productName: string;
    styleCode: string | null;
    canonicalUrl: string;
    musinsaGoodsNo: string | null;
    listPrice: number;
    watchItem: { active: boolean; expiresAt: Date } | null;
  };
  curatorLinks: { id: string; health: LinkHealth }[];
  contentCards: {
    id: string;
    channel: Channel;
    version: number;
    bodyText: string;
    charCount: number;
    disclosureOk: boolean;
    truncated: boolean;
    warnings: string | null;
    aiGeneratedFields: string | null;
  }[];
};

/**
 * 분석 결과를 클라이언트가 그대로 그릴 수 있는 형태로 눕힌다.
 * 상대 시각은 서버에서 문자열로 확정한다 — 클라이언트가 다시 계산하면 하이드레이션이 깨진다.
 */
export function toPriceHistoryDTO(
  analysis: PriceAnalysis | undefined,
  now: Date = new Date()
): PriceHistoryDTO | null {
  if (!analysis || analysis.snapshotCount === 0) return null;
  return {
    events: analysis.events.map((e) => ({
      eventTag: e.eventTag,
      salePrice: e.salePrice,
      couponPrice: e.couponPrice,
      realDiscountRate: e.realDiscountRate,
      listDiscountRate: e.listDiscountRate,
      couponDiscountRate: e.couponDiscountRate,
      manualOnly: e.manualOnly,
      baselineSampleSize: e.baseline.sampleSize,
      baselineSufficient: e.baseline.sufficient,
    })),
    currentSalePrice: analysis.current?.salePrice ?? null,
    currentCouponPrice: analysis.current?.couponPrice ?? null,
    currentCapturedLabel: analysis.current
      ? formatRelativeFromNow(analysis.current.capturedAt, now)
      : null,
    firstSalePrice: analysis.first?.salePrice ?? null,
    firstCouponPrice: analysis.first?.couponPrice ?? null,
    firstCapturedLabel: analysis.first ? formatRelativeFromNow(analysis.first.capturedAt, now) : null,
    firstChangeRate: discountRate(analysis.first?.salePrice ?? null, analysis.current?.salePrice ?? null),
    snapshotCount: analysis.snapshotCount,
  };
}

export function toDealDTO(
  deal: DealWithRelations,
  analysis?: PriceAnalysis,
  now: Date = new Date()
): DealDTO {
  // 카드는 불변·버전 누적이다 — 화면에는 채널별 **최신 버전**만 보여준다. 재렌더된 v2 옆에
  // v1이 같이 보이면 어느 것이 나갈 카드인지 알 수 없다(approval-first의 "본 것 = 나가는 것").
  const latestByChannel = new Map<Channel, DealWithRelations["contentCards"][number]>();
  for (const c of deal.contentCards) {
    const cur = latestByChannel.get(c.channel);
    if (!cur || c.version > cur.version) latestByChannel.set(c.channel, c);
  }
  const cards = [...latestByChannel.values()].map((c) => {
    const aiFields: string[] = c.aiGeneratedFields ? JSON.parse(c.aiGeneratedFields) : [];
    const warnings: string[] = c.warnings ? JSON.parse(c.warnings) : [];
    return {
      id: c.id,
      channel: c.channel,
      bodyText: c.bodyText,
      charCount: c.charCount,
      disclosureOk: c.disclosureOk,
      truncated: c.truncated,
      warnings,
      aiGeneratedFields: aiFields,
    };
  });
  const hookSource: "ai" | "human" | null = !deal.hookLine
    ? null
    : cards.some((c) => c.aiGeneratedFields.includes("hookLine"))
      ? "ai"
      : "human";

  const watch = deal.product.watchItem;

  return {
    id: deal.id,
    productId: deal.productId,
    brand: deal.product.brandName,
    productName: deal.product.productName,
    styleCode: deal.product.styleCode,
    canonicalUrl: deal.product.canonicalUrl,
    musinsaGoodsNo: deal.product.musinsaGoodsNo,
    listPrice: deal.product.listPrice,
    salePrice: deal.salePrice,
    finalPrice: deal.finalPrice,
    discountRate: deal.discountRate,
    couponCode: deal.couponCode,
    couponDesc: deal.couponDesc,
    endsAt: deal.endsAt ? deal.endsAt.toISOString() : null,
    curatorNote: deal.curatorNote,
    hookLine: deal.hookLine,
    hookSource,
    tags: parseTags(deal.tags),
    status: deal.status,
    approvalStage: deal.approvalStage,
    parseSource: deal.parseSource,
    visionConfidence: deal.visionConfidence,
    visionNotes: deal.visionNotes,
    linkCount: deal.curatorLinks.length,
    watchActive: !!watch && watch.active && watch.expiresAt > now,
    soldOut: deal.curatorLinks.some((l) => l.health !== "OK" && l.health !== "UNCHECKED"),
    priceChangeNote: buildPriceChangeNote(analysis),
    createdAt: deal.createdAt.toISOString(),
    cards,
    priceHistory: toPriceHistoryDTO(analysis, now),
  };
}
