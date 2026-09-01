import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getDefaultCreator } from "@/lib/creator";
import { draftHookLine } from "@/lib/ai-hook";
import { renderAllChannels, type DealFacts, type DealLink } from "@/lib/renderer";
import { DEAL_INCLUDE, toDealDTO } from "@/lib/deal-dto";
import { buildPriceAnalyses } from "@/lib/price-analysis";
import type { ApiErrorResponse, CreateDealInput } from "@/lib/api-types";

export async function GET() {
  const deals = await db.deal.findMany({
    include: DEAL_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  const analyses = await buildPriceAnalyses([...new Set(deals.map((d) => d.productId))]);
  // 점 없는 `deals.map(toDealDTO)`를 쓰면 배열 인덱스가 두 번째 인자로 들어간다 — 명시적 화살표로 고정한다.
  return NextResponse.json({
    deals: deals.map((deal) => toDealDTO(deal, analyses.get(deal.productId))),
  });
}

function badRequest(error: string, code?: string) {
  return NextResponse.json<ApiErrorResponse>({ error, code }, { status: 400 });
}

export async function POST(req: NextRequest) {
  let body: CreateDealInput;
  try {
    body = await req.json();
  } catch {
    return badRequest("잘못된 요청 본문입니다.");
  }

  if (!body.brand?.trim() || !body.productName?.trim() || !body.canonicalUrl?.trim()) {
    return badRequest("브랜드·상품명·상품 URL은 필수입니다.");
  }
  if (!Number.isFinite(body.listPrice) || body.listPrice <= 0) {
    return badRequest("정가는 0보다 큰 숫자여야 합니다.");
  }

  const colorLinks = (body.colorLinks ?? []).filter((l) => l.url?.trim());
  const defaultUrl = body.defaultLinkUrl?.trim();
  if (!defaultUrl && colorLinks.length === 0) {
    return badRequest(
      "큐레이터 링크가 최소 1개 필요합니다 (대표 링크 또는 색상별 링크).",
      "NO_LIVE_LINK"
    );
  }

  let endsAt: Date | null = null;
  if (body.endsAt) {
    endsAt = new Date(body.endsAt);
    if (Number.isNaN(endsAt.getTime())) return badRequest("마감 시각 형식이 올바르지 않습니다.");
    if (endsAt.getTime() < Date.now()) {
      return badRequest("마감 시각은 미래여야 합니다.", "EXPIRED");
    }
  }

  const creator = await getDefaultCreator();

  // 사람이 훅을 직접 입력하면 그것을 정본으로 쓴다. 비어있고 AI 사용을 켰을 때만 초안을 시도하며,
  // 실패해도(draftHookLine이 null 반환) 빈 훅으로 그대로 진행한다 — 렌더는 AI에 의존하지 않는다.
  let hookLine = body.hookLine?.trim() || null;
  let hookSource: "ai" | "human" = "human";
  if (!hookLine && body.useAiHook) {
    const draft = await draftHookLine({
      brand: body.brand,
      productName: body.productName,
      discountRate: body.discountRate ?? null,
      couponDesc: body.couponDesc ?? null,
    });
    if (draft) {
      hookLine = draft;
      hookSource = "ai";
    }
  }

  const links: DealLink[] = [];
  if (defaultUrl) links.push({ label: "대표 링크", url: defaultUrl });
  for (const cl of colorLinks) links.push({ label: cl.label || "색상", url: cl.url.trim() });

  const facts: DealFacts = {
    brand: body.brand.trim(),
    productName: body.productName.trim(),
    styleCode: body.styleCode?.trim() || null,
    listPrice: body.listPrice,
    salePrice: body.salePrice ?? null,
    discountRate: body.discountRate ?? null,
    couponCode: body.couponCode?.trim() || null,
    couponDesc: body.couponDesc?.trim() || null,
    finalPrice: body.finalPrice ?? null,
    endsAt,
    hookLine,
    hookSource,
    curatorNote: body.curatorNote?.trim() || null,
    links,
  };

  const results = renderAllChannels(facts);
  const failed = results.find((r) => !r.ok);
  if (failed && !failed.ok) {
    return badRequest(failed.error.message, failed.error.code);
  }
  // disclosureOk는 렌더러가 스스로 채운 값이지만, 발행 게이트와 동일한 사고로
  // 여기서도 한 번 더 확인한다(docs/03 §10의 "3중 방어" 중 2단계를 API 경계에 적용).
  const anyDisclosureFailed = results.some((r) => r.ok && !r.card.disclosureOk);
  if (anyDisclosureFailed) {
    return NextResponse.json<ApiErrorResponse>(
      { error: "고지문 검증에 실패했습니다. 발행할 수 없습니다.", code: "DISCLOSURE_FAILED" },
      { status: 422 }
    );
  }

  const deal = await db.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        creatorId: creator.id,
        canonicalUrl: body.canonicalUrl.trim(),
        brandName: facts.brand,
        productName: facts.productName,
        styleCode: facts.styleCode,
        listPrice: facts.listPrice,
        source: "PASTE",
      },
    });

    const createdDeal = await tx.deal.create({
      data: {
        productId: product.id,
        creatorId: creator.id,
        status: "DRAFT",
        salePrice: facts.salePrice,
        discountRate: facts.discountRate,
        couponCode: facts.couponCode,
        couponDesc: facts.couponDesc,
        finalPrice: facts.finalPrice,
        endsAt: facts.endsAt,
        hookLine: facts.hookLine,
        curatorNote: facts.curatorNote,
      },
    });

    if (defaultUrl) {
      await tx.curatorLink.create({
        data: { dealId: createdDeal.id, rawUrl: defaultUrl, isDefault: true },
      });
    }
    for (const cl of colorLinks) {
      const variant = await tx.productVariant.create({
        data: { productId: product.id, colorName: cl.label || "색상" },
      });
      await tx.curatorLink.create({
        data: {
          dealId: createdDeal.id,
          variantId: variant.id,
          rawUrl: cl.url.trim(),
          isDefault: false,
        },
      });
    }

    for (const r of results) {
      if (!r.ok) continue; // 위에서 이미 실패 없음을 확인했지만 타입 좁히기용
      await tx.contentCard.create({
        data: {
          dealId: createdDeal.id,
          channel: r.card.channel,
          version: 1,
          bodyText: r.card.bodyText,
          charCount: r.card.charCount,
          disclosureOk: r.card.disclosureOk,
          truncated: r.card.truncated,
          warnings: JSON.stringify(r.card.warnings),
          aiGeneratedFields: JSON.stringify(r.card.aiGeneratedFields),
        },
      });
    }

    return tx.deal.update({
      where: { id: createdDeal.id },
      data: { status: "READY" },
      include: DEAL_INCLUDE,
    });
  });

  return NextResponse.json({ deal: toDealDTO(deal) }, { status: 201 });
}
