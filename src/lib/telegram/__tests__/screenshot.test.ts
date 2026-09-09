import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// flow.test.ts·price-entry.test.ts와 같은 방식: 텔레그램 API·게이트웨이·Vision을 가로채고
// 그 사이의 상태 머신과 DB는 진짜로 돌린다. 검증 대상은 docs/06 §3-§4의 캡처 흐름과,
// 이 경로가 무신사에 요청을 전혀 보내지 않는다는 계정 안전 불변식이다.

const sent: Array<{ chatId: string | number; text: string; keyboard?: unknown }> = [];
const edited: Array<{ messageId: number; text: string; keyboard?: unknown }> = [];
let nextMessageId = 900;

const callMethodMock = vi.fn();

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>();
  return {
    ...actual,
    sendMessage: vi.fn(
      async (opts: { chatId: string | number; text: string; keyboard?: unknown }) => {
        sent.push(opts);
        return { message_id: nextMessageId++ };
      }
    ),
    editMessage: vi.fn(
      async (opts: { messageId: number; text: string; keyboard?: unknown }) => {
        edited.push(opts);
      }
    ),
    answerCallback: vi.fn(async () => {}),
    // getFile("파일 위치 조회")만 이 흐름에서 쓰인다 — 실제 다운로드는 전역 fetch로 별도 처리된다.
    callMethod: (...args: unknown[]) => callMethodMock(...args),
  };
});

const gatewayFetch = vi.fn();
vi.mock("../../fetch-gateway", () => ({
  gatewayFetch: (...args: unknown[]) => gatewayFetch(...args),
  USER_AGENT: "HoneyFlowBot/1.0",
}));

vi.mock("../../ai-hook", () => ({ draftHookLine: vi.fn(async () => null) }));

const extractFromScreenshot = vi.fn();
vi.mock("../../vision-extract", () => ({
  extractFromScreenshot: (...args: unknown[]) => extractFromScreenshot(...args),
}));

const { handleUpdate } = await import("../handler");
const { db } = await import("../../db");
const { CB } = await import("../cards");

const CHAT_ID = "555000";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = CHAT_ID;
process.env.TELEGRAM_BOT_TOKEN = "test-token";

const fetchMock = vi.fn();

function photoMessage(userId = Number(CHAT_ID)) {
  return {
    update_id: nextMessageId++,
    message: {
      message_id: nextMessageId++,
      from: { id: userId },
      chat: { id: Number(CHAT_ID) },
      // 텔레그램은 사진 1장을 여러 해상도로 보낸다 — 마지막 원소가 가장 큰 사이즈다.
      photo: [
        { file_id: "photo-small", width: 90, height: 90 },
        { file_id: "photo-large", width: 1280, height: 1706, file_size: 234_567 },
      ],
    },
  };
}

function userMessage(text: string, userId = Number(CHAT_ID)) {
  return {
    update_id: nextMessageId++,
    message: {
      message_id: nextMessageId++,
      from: { id: userId },
      chat: { id: Number(CHAT_ID) },
      text,
      entities: [{ type: "url", offset: 0, length: text.length }],
    },
  };
}

function buttonTap(data: string) {
  return {
    update_id: nextMessageId++,
    callback_query: {
      id: `cb${nextMessageId++}`,
      from: { id: Number(CHAT_ID) },
      data,
      message: { message_id: 1, chat: { id: Number(CHAT_ID) } },
    },
  };
}

const VISION_RESULT_FULL = {
  isProductPage: true,
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

const VISION_RESULT_NOT_PRODUCT_PAGE = {
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
  notes: null,
};

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

beforeEach(async () => {
  sent.length = 0;
  edited.length = 0;
  gatewayFetch.mockReset();
  extractFromScreenshot.mockReset();
  callMethodMock.mockReset();
  callMethodMock.mockResolvedValue({ file_path: "photos/file_1.jpg" });

  // getFile이 알려준 file_path를 다운로드하는 마지막 단계 — 텔레그램 자체 CDN이라
  // gatewayFetch가 아니라 전역 fetch를 직접 쓴다. fetch-gateway.test.ts와 같은 방식으로 스텁한다.
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    arrayBuffer: async () => new TextEncoder().encode("가짜 jpeg 바이트열").buffer,
  });
  vi.stubGlobal("fetch", fetchMock);

  await resetDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("스크린샷 해피패스 (docs/06 §3-4)", () => {
  it("사진 1장 → 즉시 상태 메시지 → Vision 성공 → Deal · PriceSnapshot(SCREENSHOT) · 후보 카드", async () => {
    extractFromScreenshot.mockResolvedValue(VISION_RESULT_FULL);

    await handleUpdate(photoMessage());

    // (a) 즉시 피드백 — 상태 메시지가 먼저 나간다
    expect(sent.some((s) => s.text.includes("스크린샷 확인하는 중"))).toBe(true);

    // (b) 가장 큰 사이즈(마지막 원소)의 file_id로 getFile을 부른다
    expect(callMethodMock).toHaveBeenCalledWith("getFile", { file_id: "photo-large" });

    const deal = await db.deal.findFirstOrThrow({ include: { product: true } });
    expect(deal.approvalStage).toBe("CANDIDATE");
    expect(deal.status).toBe("DRAFT");
    expect(deal.parseSource).toBe("vision");
    expect(deal.parseFieldCount).toBe(4); // brand·productName·listPrice·salePrice
    expect(deal.salePrice).toBe(53400);
    expect(deal.product.brandName).toBe("쿠어");
    expect(deal.product.productName).toBe("스탠다드 오버셔츠");
    expect(deal.product.styleCode).toBe("CO-999");
    expect(deal.product.source).toBe("SCREENSHOT");

    const snapshot = await db.priceSnapshot.findFirstOrThrow({
      where: { productId: deal.productId },
    });
    expect(snapshot.source).toBe("SCREENSHOT");
    expect(snapshot.listPrice).toBe(89000);
    expect(snapshot.salePrice).toBe(53400);
    expect(snapshot.couponPrice).toBe(45000);

    // 후보 카드가 상태 메시지 자리에 렌더된다 (editMessageText로 같은 메시지를 갱신)
    const card = edited.at(-1);
    expect(card?.text).toContain("쿠어");
    expect(card?.text).toContain("스탠다드 오버셔츠");

    const log = await db.auditLog.findFirst({ where: { action: "deal.captured" } });
    expect(log?.detail).toContain("스크린샷");
    // 이미지 바이트·base64는 어디에도(로그 포함) 남지 않는다 (docs/06 §4.3)
    expect(log?.detail ?? "").not.toMatch(/가짜 jpeg|base64/i);
    expect(log?.payloadSnapshot).toBeFalsy();
  });
});

describe("Vision 실패 — API 장애/타임아웃 (docs/06 §3.3)", () => {
  it("extractFromScreenshot이 null이면 Deal을 만들지 않고 사과 메시지만 보낸다", async () => {
    extractFromScreenshot.mockResolvedValue(null);

    await handleUpdate(photoMessage());

    expect(await db.deal.count()).toBe(0);
    expect(await db.priceSnapshot.count()).toBe(0);

    const card = edited.at(-1);
    expect(card?.text).toContain("읽지 못했습니다");
  });
});

describe("상품 페이지가 아닌 화면 (docs/06 §3.3)", () => {
  it("isProductPage:false → 지정된 안내 문구만 보내고 Deal·스냅샷은 만들지 않는다", async () => {
    extractFromScreenshot.mockResolvedValue(VISION_RESULT_NOT_PRODUCT_PAGE);

    await handleUpdate(photoMessage());

    expect(await db.deal.count()).toBe(0);
    expect(await db.priceSnapshot.count()).toBe(0);

    const card = edited.at(-1);
    expect(card?.text).toBe("상품 페이지 상단(브랜드·상품명·가격이 보이는 화면)을 찍어주세요.");
  });
});

describe("계정 안전: 무신사 Fetch Gateway는 절대 호출되지 않는다", () => {
  it("해피패스·Vision실패·오분류 화면 어느 경로에서도 gatewayFetch가 한 번도 불리지 않는다", async () => {
    extractFromScreenshot.mockResolvedValueOnce(VISION_RESULT_FULL);
    await handleUpdate(photoMessage());

    extractFromScreenshot.mockResolvedValueOnce(null);
    await handleUpdate(photoMessage());

    extractFromScreenshot.mockResolvedValueOnce(VISION_RESULT_NOT_PRODUCT_PAGE);
    await handleUpdate(photoMessage());

    // 스크린샷 경로는 애초에 게이트웨이를 지나가지 않는다 — 외부(무신사) 요청이 없다 (docs/06 §7).
    expect(gatewayFetch).not.toHaveBeenCalled();
  });
});

// 회귀: 적대적 검증에서 발견된 결함 — 스크린샷 상품의 canonicalUrl은 큐레이터 링크가
// 붙을 때 실제 URL로 채워져야 한다. 안 그러면 승인 뒤 헬스체커·워치가 합성 sentinel
// ("screenshot-pending:...")을 게이트웨이에 넘기다 BLOCKED_POLICY로 사이클 전체가 멈춘다
// (docs/06 §4.2 — "나중에 큐레이터 링크가 오면 그 Product에 goodsNo를 채운다").
describe("회귀: 스크린샷 상품에 큐레이터 링크가 오면 canonicalUrl을 백필한다", () => {
  it("정상 케이스 — musinsaGoodsNo·canonicalUrl이 실제 URL로 채워진다", async () => {
    extractFromScreenshot.mockResolvedValue(VISION_RESULT_FULL);
    await handleUpdate(photoMessage());

    let deal = await db.deal.findFirstOrThrow({ include: { product: true } });
    expect(deal.product.musinsaGoodsNo).toBeNull();
    expect(deal.product.canonicalUrl).toContain("screenshot-pending:");

    await handleUpdate(buttonTap(CB.interested(deal.id)));
    await handleUpdate(
      userMessage("https://www.musinsa.com/products/8888888?utm_source=curator&utm_term=ABC123")
    );

    deal = await db.deal.findUniqueOrThrow({ where: { id: deal.id }, include: { product: true } });
    expect(deal.approvalStage).toBe("READY_TO_PUBLISH"); // 백필해도 정상 흐름은 그대로 이어진다
    expect(deal.product.musinsaGoodsNo).toBe("8888888");
    expect(deal.product.canonicalUrl).toBe("https://www.musinsa.com/products/8888888");

    // 백필됐으니 다음 헬스체크·워치 사이클이 이 canonicalUrl로 정상 조회를 시도할 수 있다.
    const card = edited.at(-1);
    expect(card?.text ?? "").not.toContain("다른 상품");
  });

  it("goodsNo 충돌 — 이미 등록된 상품이면 백필하지 않고 경고만 남긴다", async () => {
    // getDefaultCreator()가 찾는 것과 같은 handle로 미리 만들어, 같은 creator 스코프에 놓는다.
    // upsert인 이유: 이 파일의 resetDb()는 creator를 지우지 않아(다른 테스트가 이미
    // getDefaultCreator()로 같은 handle을 만들어 뒀을 수 있다), create만 쓰면 실행 순서에
    // 따라 유니크 제약 위반이 날 수 있다.
    const creator = await db.creator.upsert({
      where: { handle: "maison_jenflox" },
      update: {},
      create: { handle: "maison_jenflox" },
    });
    await db.product.create({
      data: {
        creatorId: creator.id,
        musinsaGoodsNo: "7777777",
        canonicalUrl: "https://www.musinsa.com/products/7777777",
        brandName: "이미등록",
        productName: "먼저 링크로 들어온 상품",
        listPrice: 50000,
      },
    });

    extractFromScreenshot.mockResolvedValue(VISION_RESULT_FULL);
    await handleUpdate(photoMessage());

    let deal = await db.deal.findFirstOrThrow({
      where: { product: { musinsaGoodsNo: null } },
      include: { product: true },
    });

    await handleUpdate(buttonTap(CB.interested(deal.id)));
    await handleUpdate(
      userMessage("https://www.musinsa.com/products/7777777?utm_source=curator&utm_term=XYZ999")
    );

    deal = await db.deal.findUniqueOrThrow({ where: { id: deal.id }, include: { product: true } });
    // 충돌 시엔 두 Product를 자동으로 합치지 않는다 — sentinel이 그대로 남는다.
    expect(deal.product.musinsaGoodsNo).toBeNull();
    expect(deal.product.canonicalUrl).toContain("screenshot-pending:");

    const card = edited.at(-1);
    expect(card?.text).toContain("중복 상품");

    // 그래도 링크 붙여넣기 자체는 막지 않는다 (기존 mismatch 경고와 동일한 동작).
    const link = await db.curatorLink.findFirst({ where: { dealId: deal.id } });
    expect(link).toBeTruthy();
  });
});

describe("접근 통제는 사진 경로에도 그대로 적용된다", () => {
  it("화이트리스트에 없는 사용자의 사진은 무시한다", async () => {
    await handleUpdate(photoMessage(999999));

    expect(await db.deal.count()).toBe(0);
    expect(sent).toHaveLength(0);
    expect(extractFromScreenshot).not.toHaveBeenCalled();
  });
});
