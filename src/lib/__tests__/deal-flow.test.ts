import { beforeEach, describe, expect, it, vi } from "vitest";

// Vision·AI 훅·게이트웨이만 가로채고, 상태 머신과 DB는 진짜로 돌린다.
// 검증 대상: 후보 → 링크 대기 → 발행 승인 → 승인 완료 전이가 실제로 일어나는가,
// 그리고 각 단계에서 계정 안전 불변식이 지켜지는가 (docs/02 §6, docs/06 §3-§4).

const gatewayFetch = vi.fn();
vi.mock("../fetch-gateway", () => ({
  gatewayFetch: (...args: unknown[]) => gatewayFetch(...args),
  USER_AGENT: "HoneyFlowBot/1.0",
}));

// AI 훅은 네트워크를 타므로 끈다 — 훅 없이도 파이프라인이 도는지가 검증 포인트다.
vi.mock("../ai-hook", () => ({ draftHookLine: vi.fn(async () => null) }));

const extractFromScreenshot = vi.fn();
vi.mock("../vision-extract", () => ({
  extractFromScreenshot: (...args: unknown[]) => extractFromScreenshot(...args),
}));

const {
  captureFromScreenshots,
  markInterested,
  skipDeal,
  reopenDeal,
  attachCuratorLink,
  replaceHook,
  approveDeal,
  updateDealFacts,
  MAX_CAPTURE_IMAGES,
} = await import("../deal-flow");
const { db } = await import("../db");
const { toDealDTO, DEAL_INCLUDE } = await import("../deal-dto");
const { buildPriceAnalyses } = await import("../price-analysis");
type VisionExtractResult = import("../vision-extract").VisionExtractResult;

const IMAGE = { data: "ZmFrZSBqcGVn", mediaType: "image/jpeg" }; // "fake jpeg"

const VISION_FULL: VisionExtractResult = {
  isProductPage: true,
  gridItems: null,
  brand: "쿠어",
  productName: "스탠다드 오버셔츠",
  styleCode: "CO-999",
  listPrice: 89000,
  salePrice: 53400,
  couponPrice: 45000,
  discountRateShown: 40,
  soldOut: false,
  confidence: "high" as const,
  notes: null,
};

const VISION_NOT_PRODUCT_PAGE: VisionExtractResult = {
  ...VISION_FULL,
  isProductPage: false,
  brand: null,
  productName: null,
  styleCode: null,
  listPrice: null,
  salePrice: null,
  couponPrice: null,
  discountRateShown: null,
  soldOut: null,
  confidence: "low" as const,
};

const CURATOR_LINK = "https://www.musinsa.com/products/8888888?utm_source=curator&utm_term=01HZX8QK9M";

async function resetDb() {
  await db.clickEvent.deleteMany();
  await db.shortLink.deleteMany();
  await db.post.deleteMany();
  await db.contentCard.deleteMany();
  await db.curatorLink.deleteMany();
  await db.deal.deleteMany();
  await db.productVariant.deleteMany();
  await db.priceSnapshot.deleteMany();
  await db.watchItem.deleteMany();
  await db.product.deleteMany();
  await db.auditLog.deleteMany();
}

async function capture(vision = VISION_FULL) {
  extractFromScreenshot.mockResolvedValueOnce(vision);
  const result = await captureFromScreenshots([IMAGE]);
  if (result.kind !== "created") throw new Error(`capture failed: ${result.kind}`);
  return result;
}

async function dealDTO(dealId: string) {
  const deal = await db.deal.findUniqueOrThrow({ where: { id: dealId }, include: DEAL_INCLUDE });
  const analyses = await buildPriceAnalyses([deal.productId]);
  return toDealDTO(deal, analyses.get(deal.productId));
}

beforeEach(async () => {
  gatewayFetch.mockReset();
  extractFromScreenshot.mockReset();
  await resetDb();
});

describe("스크린샷 캡처 (docs/06 §3-4)", () => {
  it("Vision 성공 → Deal · PriceSnapshot(SCREENSHOT) · 후보 단계", async () => {
    const result = await capture();
    expect(result.matchedBy).toBe("created");

    const deal = await db.deal.findUniqueOrThrow({
      where: { id: result.dealId },
      include: { product: true },
    });
    expect(deal.approvalStage).toBe("CANDIDATE");
    expect(deal.status).toBe("DRAFT");
    expect(deal.parseSource).toBe("vision");
    expect(deal.parseFieldCount).toBe(4); // brand·productName·listPrice·salePrice
    expect(deal.salePrice).toBe(53400);
    expect(deal.discountRate).toBe(40); // 화면에 찍힌 할인율
    expect(deal.product.brandName).toBe("쿠어");
    expect(deal.product.styleCode).toBe("CO-999");
    expect(deal.product.source).toBe("SCREENSHOT");
    // 정가는 Product의 사실로 남는다 — 0으로 두면 카드에 "0원"이 찍혀 나간다.
    expect(deal.product.listPrice).toBe(89000);

    const snapshot = await db.priceSnapshot.findFirstOrThrow({ where: { productId: deal.productId } });
    expect(snapshot.source).toBe("SCREENSHOT");
    expect(snapshot.listPrice).toBe(89000);
    expect(snapshot.salePrice).toBe(53400);
    expect(snapshot.couponPrice).toBe(45000);

    // 첫 캡처는 비교할 이전 기록이 없다.
    expect(result.priceChangeNote).toBeNull();

    const log = await db.auditLog.findFirst({ where: { action: "deal.captured" } });
    expect(log?.detail).toContain("스크린샷");
    // 이미지 바이트·base64는 어디에도(로그 포함) 남지 않는다 (docs/06 §4.3)
    expect(log?.detail ?? "").not.toMatch(/ZmFrZSBqcGVn|base64/i);
    expect(log?.payloadSnapshot).toBeFalsy();
  });

  it("여러 장은 한 번에 Vision에 보내고, 상한을 넘는 장수는 쓰지 않는다", async () => {
    extractFromScreenshot.mockResolvedValueOnce(VISION_FULL);
    const images = Array.from({ length: MAX_CAPTURE_IMAGES + 2 }, () => IMAGE);
    await captureFromScreenshots(images);

    expect(extractFromScreenshot).toHaveBeenCalledTimes(1);
    expect(extractFromScreenshot.mock.calls[0][0]).toHaveLength(MAX_CAPTURE_IMAGES);
    expect(await db.deal.count()).toBe(1);
  });

  it("같은 상품을 가격이 바뀐 뒤 다시 찍으면 '지난번 → 지금'이 나온다 (docs/06 §3.1)", async () => {
    await capture(); // 53,400원
    const second = await capture({ ...VISION_FULL, salePrice: 42900 });

    // 같은 브랜드·상품명·품번이므로 product-match가 같은 Product로 묶고,
    // 열려 있던 후보 카드를 재사용하므로 딜은 늘지 않는다. 가격 기록만 쌓인다.
    expect(await db.product.count()).toBe(1);
    expect(await db.deal.count()).toBe(1);
    expect(await db.priceSnapshot.count()).toBe(2);

    expect(second.priceChangeNote).toContain("53,400원");
    expect(second.priceChangeNote).toContain("42,900원");
    expect(second.priceChangeNote).toMatch(/하락|📉/);
    expect(second.priceChangeNote).toContain("정가 89,000원 대비 할인 40% → 52%");
    expect(second.priceChangeNote).toContain("쿠폰 쓰면 45,000원 (49% 할인)");

    // 화면이 다시 그려질 때도 같은 비교가 DTO에 실린다.
    expect((await dealDTO(second.dealId)).priceChangeNote).toContain("42,900원");
  });

  it("Vision 실패(null)면 Deal·스냅샷을 만들지 않는다 (docs/06 §3.3)", async () => {
    extractFromScreenshot.mockResolvedValueOnce(null);
    expect(await captureFromScreenshots([IMAGE])).toEqual({
      kind: "vision_failed",
      reason: "bad-response",
    });
    expect(await db.deal.count()).toBe(0);
    expect(await db.priceSnapshot.count()).toBe(0);
  });

  it("상품 페이지가 아닌 화면이면 아무것도 만들지 않는다 (docs/06 §3.3)", async () => {
    extractFromScreenshot.mockResolvedValueOnce(VISION_NOT_PRODUCT_PAGE);
    expect(await captureFromScreenshots([IMAGE])).toEqual({ kind: "not_product_page" });
    expect(await db.deal.count()).toBe(0);
    expect(await db.priceSnapshot.count()).toBe(0);
  });

  // 리마인더가 매일 "다시 찍어 올려주세요"라고 조르는 구조라, 캡처마다 딜을 만들면
  // 같은 상품의 후보 카드가 매일 한 장씩 쌓인다(운영에서 실제로 13장까지 불어났다).
  it("같은 상품을 다시 찍으면 새 딜을 만들지 않고 열려 있던 카드를 갱신한다", async () => {
    const first = await capture();
    expect(first.reused).toBe(false);

    const second = await capture({ ...VISION_FULL, salePrice: 49000, discountRateShown: 45 });
    expect(second.reused).toBe(true);
    expect(second.dealId).toBe(first.dealId);
    expect(await db.deal.count()).toBe(1);

    const deal = await db.deal.findUniqueOrThrow({ where: { id: first.dealId } });
    expect(deal.salePrice).toBe(49000);
    expect(deal.discountRate).toBe(45);
    // 가격 기록은 두 번 다 남는다 — 카드를 합쳤다고 이력이 합쳐지는 것은 아니다
    expect(await db.priceSnapshot.count()).toBe(2);
  });

  it("이번에 못 읽은 값으로 이미 있던 값을 지우지 않는다", async () => {
    const { dealId } = await capture();
    await capture({ ...VISION_FULL, salePrice: null, discountRateShown: null });

    const deal = await db.deal.findUniqueOrThrow({ where: { id: dealId } });
    expect(deal.salePrice).toBe(53400);
    expect(deal.discountRate).toBe(40);
  });

  it("링크 대기 중인 딜도 재사용한다 — 진행 중이던 판단을 되돌리지 않는다", async () => {
    const { dealId } = await capture();
    await markInterested(dealId);

    const again = await capture({ ...VISION_FULL, salePrice: 51000 });
    expect(again.dealId).toBe(dealId);
    expect((await db.deal.findUniqueOrThrow({ where: { id: dealId } })).approvalStage).toBe(
      "AWAITING_LINK"
    );
  });

  it("기록 완료한 딜은 재사용하지 않는다 — 끝난 판단이고 다시 찍은 건 새 판단이다", async () => {
    const { dealId } = await capture();
    await skipDeal(dealId);

    const again = await capture();
    expect(again.reused).toBe(false);
    expect(again.dealId).not.toBe(dealId);
    expect(await db.deal.count()).toBe(2);
  });

  it("계정 안전: 어느 경로에서도 무신사 게이트웨이를 호출하지 않는다 (docs/06 §7)", async () => {
    await capture();
    extractFromScreenshot.mockResolvedValueOnce(null);
    await captureFromScreenshots([IMAGE]);
    extractFromScreenshot.mockResolvedValueOnce(VISION_NOT_PRODUCT_PAGE);
    await captureFromScreenshots([IMAGE]);

    expect(gatewayFetch).not.toHaveBeenCalled();
  });
});

describe("전체 흐름: 후보 → 링크 대기 → 발행 승인 → 승인", () => {
  it("해피패스가 끝까지 돈다", async () => {
    const { dealId } = await capture();

    await markInterested(dealId);
    expect((await db.deal.findUniqueOrThrow({ where: { id: dealId } })).approvalStage).toBe(
      "AWAITING_LINK"
    );

    const attached = await attachCuratorLink(dealId, `링크 여기요 ${CURATOR_LINK}`);
    expect(attached).toEqual({ ok: true, warnings: [] });

    let deal = await db.deal.findUniqueOrThrow({ where: { id: dealId }, include: { product: true } });
    expect(deal.approvalStage).toBe("READY_TO_PUBLISH");
    expect(deal.status).toBe("READY");

    const link = await db.curatorLink.findFirstOrThrow({ where: { dealId } });
    expect(link.ulid).toBe("01HZX8QK9M");
    // 원본 무변조 보존 (링크 변조 금지 조항)
    expect(link.rawUrl).toContain("utm_term=01HZX8QK9M");
    // 링크허브용 숏링크가 발급된다
    expect(await db.shortLink.count({ where: { dealId, surface: "hub" } })).toBe(1);

    const cards = await db.contentCard.findMany({ where: { dealId } });
    expect(cards).toHaveLength(4);
    expect(cards.every((c) => c.disclosureOk)).toBe(true);

    const approved = await approveDeal(dealId);
    expect(approved.ok).toBe(true);
    deal = await db.deal.findUniqueOrThrow({ where: { id: dealId }, include: { product: true } });
    expect(deal.approvalStage).toBe("APPROVED");
    expect(deal.status).toBe("PUBLISHED");

    const post = await db.post.findFirstOrThrow({ where: { dealId } });
    expect(post.mode).toBe("SEMI_COPIED"); // 카톡은 반자동 — 사람이 전송한다
    expect(post.channel).toBe("KAKAO_OPEN");

    // 화면에 보이는 카톡 카드에 고지문이 첫 줄로 들어가 있어야 한다
    const dto = await dealDTO(dealId);
    const kakao = dto.cards.find((c) => c.channel === "KAKAO_OPEN");
    expect(kakao?.bodyText).toContain("(광고) 아래 링크로 구매 시 수수료를 받습니다");
    expect(kakao?.bodyText).toContain("89,000원 → 53,400원 (40%)");
    expect(kakao?.bodyText).not.toContain("0원\n");
    expect(dto.approvalStage).toBe("APPROVED");
    expect(dto.linkCount).toBe(1);

    // 승인 사실이 감사 로그에 남는다 (제재 시 "사람이 승인했다"의 증적)
    const log = await db.auditLog.findFirst({ where: { action: "deal.approved" } });
    expect(log?.actor).toBe("HUMAN");
    expect(log?.payloadHash).toBeTruthy();
  });

  it("링크가 아닌 텍스트를 붙여넣으면 거부하고 상태를 바꾸지 않는다", async () => {
    const { dealId } = await capture();
    await markInterested(dealId);

    const result = await attachCuratorLink(dealId, "이거 어때요");
    expect(result.ok).toBe(false);
    expect((await db.deal.findUniqueOrThrow({ where: { id: dealId } })).approvalStage).toBe(
      "AWAITING_LINK"
    );
    expect(await db.curatorLink.count()).toBe(0);
  });

  it("무신사가 아닌 링크는 거부한다", async () => {
    const { dealId } = await capture();
    const result = await attachCuratorLink(dealId, "https://evil.example.com/products/1?utm_term=X");
    expect(result.ok).toBe(false);
    expect(await db.curatorLink.count()).toBe(0);
  });
});

describe("링크 검증 경고 — 승인 화면에 반드시 보여야 한다", () => {
  it("스크린샷 상품에 첫 정규 링크가 오면 goodsNo·canonicalUrl을 백필한다", async () => {
    const { dealId } = await capture();
    let deal = await db.deal.findUniqueOrThrow({ where: { id: dealId }, include: { product: true } });
    expect(deal.product.musinsaGoodsNo).toBeNull();
    expect(deal.product.canonicalUrl).toContain("screenshot-pending:");

    const result = await attachCuratorLink(dealId, CURATOR_LINK);
    expect(result).toEqual({ ok: true, warnings: [] });

    deal = await db.deal.findUniqueOrThrow({ where: { id: dealId }, include: { product: true } });
    expect(deal.product.musinsaGoodsNo).toBe("8888888");
    expect(deal.product.canonicalUrl).toBe("https://www.musinsa.com/products/8888888");
  });

  it("goodsNo 충돌 — 이미 등록된 상품이면 백필하지 않고 경고만 남긴다", async () => {
    const { getDefaultCreator } = await import("../creator");
    const creator = await getDefaultCreator();
    await db.product.create({
      data: {
        creatorId: creator.id,
        musinsaGoodsNo: "7777777",
        canonicalUrl: "https://www.musinsa.com/products/7777777",
        brandName: "이미등록",
        productName: "먼저 들어온 상품",
        listPrice: 50000,
      },
    });

    const { dealId } = await capture();
    const result = await attachCuratorLink(
      dealId,
      "https://www.musinsa.com/products/7777777?utm_source=curator&utm_term=XYZ999"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(" ")).toContain("이미 다른 딜에 있어요");

    const deal = await db.deal.findUniqueOrThrow({ where: { id: dealId }, include: { product: true } });
    expect(deal.product.musinsaGoodsNo).toBeNull(); // 자동으로 합치지 않는다
    // 그래도 링크 붙여넣기 자체는 막지 않는다
    expect(await db.curatorLink.count({ where: { dealId } })).toBe(1);
    expect(await db.auditLog.findFirst({ where: { action: "link.warning" } })).toBeTruthy();
  });

  it("링크가 다른 상품을 가리키면 경고한다", async () => {
    const { dealId } = await capture();
    await attachCuratorLink(dealId, CURATOR_LINK); // #8888888로 확정
    const { dealId: again } = await capture(); // 같은 상품(품번 일치)

    const result = await attachCuratorLink(
      again,
      "https://www.musinsa.com/products/9999999?utm_source=curator&utm_term=ZZZ"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(" ")).toContain("다른 상품 링크");
  });

  it("커미션 파라미터가 없으면 경고한다", async () => {
    const { dealId } = await capture();
    const result = await attachCuratorLink(dealId, "https://www.musinsa.com/products/8888888");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(" ")).toContain("수수료가 안 잡힐");
  });
});

describe("훅 교체와 최신 버전 승인", () => {
  it("훅을 교체하면 v2가 렌더되고, 승인은 항상 최신 버전을 발행한다", async () => {
    const { dealId } = await capture();
    await attachCuratorLink(dealId, CURATOR_LINK);

    expect(await replaceHook(dealId, "새로운 훅 문구 V2")).toEqual({ ok: true });
    expect((await db.deal.findUniqueOrThrow({ where: { id: dealId } })).hookLine).toBe(
      "새로운 훅 문구 V2"
    );

    const versions = await db.contentCard.findMany({
      where: { dealId, channel: "KAKAO_OPEN" },
      orderBy: { version: "asc" },
    });
    expect(versions).toHaveLength(2);

    // 화면에는 채널당 최신 버전만 보인다 — 본 것 = 나가는 것
    const dto = await dealDTO(dealId);
    expect(dto.cards).toHaveLength(4);
    expect(dto.cards.find((c) => c.channel === "KAKAO_OPEN")?.bodyText).toContain("새로운 훅 문구 V2");

    const approved = await approveDeal(dealId);
    expect(approved.ok).toBe(true);
    const post = await db.post.findFirstOrThrow({ where: { dealId } });
    expect(post.contentCardId).toBe(versions[1].id);
  });

  it("빈 훅·너무 긴 훅은 거부한다", async () => {
    const { dealId } = await capture();
    expect((await replaceHook(dealId, "   ")).ok).toBe(false);
    expect((await replaceHook(dealId, "가".repeat(201))).ok).toBe(false);
  });
});

describe("승인 게이트", () => {
  it("카드가 없으면 승인할 수 없다", async () => {
    const { dealId } = await capture();
    expect(await approveDeal(dealId)).toEqual({ ok: false, reason: "NO_CARD" });
  });

  it("고지문 검증에 실패한 카드는 승인되지 않는다 (docs/03 불변식 I-3)", async () => {
    const { dealId } = await capture();
    await attachCuratorLink(dealId, CURATOR_LINK);
    await db.contentCard.updateMany({ where: { dealId }, data: { disclosureOk: false } });

    expect(await approveDeal(dealId)).toEqual({ ok: false, reason: "DISCLOSURE_FAILED" });
    expect((await db.deal.findUniqueOrThrow({ where: { id: dealId } })).status).toBe("READY");
    expect(await db.post.count()).toBe(0);
    expect(
      await db.auditLog.findFirst({ where: { action: "publish.blocked_disclosure" } })
    ).toBeTruthy();
  });
});

describe("기록 완료", () => {
  it("SKIPPED로 남고 감사 로그가 기록된다 — 가격 스냅샷은 그대로 남는다", async () => {
    const { dealId } = await capture();
    await skipDeal(dealId);

    expect((await db.deal.findUniqueOrThrow({ where: { id: dealId } })).approvalStage).toBe("SKIPPED");
    expect(await db.auditLog.findFirst({ where: { action: "deal.skipped" } })).toBeTruthy();
    expect(await db.priceSnapshot.count()).toBe(1);
  });

  it("다시 열면 후보로 돌아오고 감사 로그에 남는다 — 같은 상품을 다시 찍지 않아도 된다", async () => {
    const { dealId } = await capture();
    await skipDeal(dealId);

    const result = await reopenDeal(dealId);
    expect(result.ok).toBe(true);
    expect((await db.deal.findUniqueOrThrow({ where: { id: dealId } })).approvalStage).toBe("CANDIDATE");
    expect(await db.auditLog.count({ where: { action: "deal.reopened", approvalRef: dealId } })).toBe(1);
    // 딜이 늘지 않는다 — 다시 찍어 올리는 우회로의 부작용(중복 카드)이 이 기능의 이유다
    expect(await db.deal.count()).toBe(1);
  });

  it("안 올림이 아닌 딜은 되돌리지 않는다 — 이미 나간 카드와 앱 상태가 어긋나면 안 된다", async () => {
    const { dealId } = await capture();
    const before = (await db.deal.findUniqueOrThrow({ where: { id: dealId } })).approvalStage;

    const result = await reopenDeal(dealId);
    expect(result.ok).toBe(false);
    expect((await db.deal.findUniqueOrThrow({ where: { id: dealId } })).approvalStage).toBe(before);
    expect(await db.auditLog.count({ where: { action: "deal.reopened" } })).toBe(0);
  });
});

describe("정보 고치기", () => {
  it("읽지 못한 딜을 사람이 채우면 진행 가능한 상태가 된다", async () => {
    const { dealId } = await capture({
      ...VISION_FULL,
      brand: null,
      productName: null,
      styleCode: null,
      listPrice: null,
      salePrice: null,
      couponPrice: null,
    });
    await db.deal.update({ where: { id: dealId }, data: { parseSource: "none" } });

    const result = await updateDealFacts(dealId, {
      brand: "쿠어",
      productName: "오버핏 맨투맨",
      listPrice: 89000,
      salePrice: 53400,
      productUrl: "https://www.musinsa.com/products/1234567?utm_term=ABC", // 커미션 파라미터는 정규화로 제거
    });
    expect(result).toEqual({ ok: true, rerendered: false });

    const deal = await db.deal.findUniqueOrThrow({ where: { id: dealId }, include: { product: true } });
    expect(deal.parseSource).toBe("manual");
    expect(deal.product.brandName).toBe("쿠어");
    expect(deal.product.listPrice).toBe(89000);
    expect(deal.salePrice).toBe(53400);
    expect(deal.product.musinsaGoodsNo).toBe("1234567");
    expect(deal.product.canonicalUrl).toBe("https://www.musinsa.com/products/1234567");
    expect(await db.auditLog.findFirst({ where: { action: "deal.edited" } })).toBeTruthy();
  });

  it("발행 승인 단계의 딜을 고치면 카드를 새 버전으로 다시 렌더한다", async () => {
    const { dealId } = await capture();
    await attachCuratorLink(dealId, CURATOR_LINK);

    const result = await updateDealFacts(dealId, { salePrice: 49900, couponDesc: "큐레이터 10%" });
    expect(result).toEqual({ ok: true, rerendered: true });

    const dto = await dealDTO(dealId);
    expect(dto.cards.find((c) => c.channel === "KAKAO_OPEN")?.bodyText).toContain("49,900원");
    expect(await db.contentCard.count({ where: { dealId, channel: "KAKAO_OPEN" } })).toBe(2);
  });

  it("잘못된 값은 거부한다", async () => {
    const { dealId } = await capture();
    expect((await updateDealFacts(dealId, { brand: "  " })).ok).toBe(false);
    expect((await updateDealFacts(dealId, { listPrice: -1 })).ok).toBe(false);
    expect((await updateDealFacts(dealId, { discountRate: 140 })).ok).toBe(false);
    expect((await updateDealFacts(dealId, { productUrl: "https://evil.example.com/x" })).ok).toBe(false);
  });
});
