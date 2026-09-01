import type { Channel } from "@prisma/client";
import type { DealDTO, PriceHistoryDTO } from "./api-types";
import type { PriceAnalysis } from "./price-analysis";
import { formatRelativeFromNow } from "./format";

export const DEAL_INCLUDE = {
  product: true,
  contentCards: { orderBy: { channel: "asc" as const } },
};

type DealWithRelations = {
  id: string;
  status: string;
  salePrice: number | null;
  discountRate: number | null;
  couponDesc: string | null;
  finalPrice: number | null;
  endsAt: Date | null;
  hookLine: string | null;
  createdAt: Date;
  product: {
    id: string;
    brandName: string;
    productName: string;
    styleCode: string | null;
    canonicalUrl: string;
    listPrice: number;
  };
  contentCards: {
    id: string;
    channel: Channel;
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
      manualOnly: e.manualOnly,
      baselineSampleSize: e.baseline.sampleSize,
      baselineSufficient: e.baseline.sufficient,
    })),
    currentSalePrice: analysis.current?.salePrice ?? null,
    currentCouponPrice: analysis.current?.couponPrice ?? null,
    currentCapturedLabel: analysis.current
      ? formatRelativeFromNow(analysis.current.capturedAt, now)
      : null,
    snapshotCount: analysis.snapshotCount,
  };
}

export function toDealDTO(deal: DealWithRelations, analysis?: PriceAnalysis): DealDTO {
  const cards = deal.contentCards.map((c) => {
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

  return {
    id: deal.id,
    brand: deal.product.brandName,
    productName: deal.product.productName,
    styleCode: deal.product.styleCode,
    canonicalUrl: deal.product.canonicalUrl,
    listPrice: deal.product.listPrice,
    salePrice: deal.salePrice,
    finalPrice: deal.finalPrice,
    discountRate: deal.discountRate,
    couponDesc: deal.couponDesc,
    endsAt: deal.endsAt ? deal.endsAt.toISOString() : null,
    hookLine: deal.hookLine,
    hookSource,
    status: deal.status,
    createdAt: deal.createdAt.toISOString(),
    cards,
    priceHistory: toPriceHistoryDTO(analysis),
  };
}
