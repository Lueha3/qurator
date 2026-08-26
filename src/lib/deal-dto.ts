import type { Channel } from "@prisma/client";
import type { DealDTO } from "./api-types";

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

export function toDealDTO(deal: DealWithRelations): DealDTO {
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
  };
}
