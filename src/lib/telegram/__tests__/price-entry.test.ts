import { beforeEach, describe, expect, it, vi } from "vitest";

// flow.test.ts와 같은 방식: 텔레그램 API와 게이트웨이만 가로채고 DB·스냅샷은 진짜로 돈다.
const sent: Array<{ chatId: string | number; text: string }> = [];

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>();
  return {
    ...actual,
    sendMessage: vi.fn(async (opts: { chatId: string | number; text: string }) => {
      sent.push(opts);
      return { message_id: nextMessageId++ };
    }),
    editMessage: vi.fn(async () => {}),
    answerCallback: vi.fn(async () => {}),
  };
});

const gatewayFetch = vi.fn();
vi.mock("../../fetch-gateway", () => ({
  gatewayFetch: (...args: unknown[]) => gatewayFetch(...args),
  USER_AGENT: "HoneyFlowBot/1.0",
}));

vi.mock("../../ai-hook", () => ({ draftHookLine: vi.fn(async () => null) }));

const { handleUpdate } = await import("../handler");
const { db } = await import("../../db");

let nextMessageId = 500;
const CHAT_ID = "555000";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = CHAT_ID;

const GOODS_NO = "777001";
const PRODUCT_URL = `https://www.musinsa.com/products/${GOODS_NO}`;
const PRODUCT_HTML = `<!doctype html><html><head>
<script type="application/ld+json">
${JSON.stringify({
  "@type": "Product",
  name: "오버핏 맨투맨",
  mpn: "CO-123",
  brand: { name: "쿠어" },
  offers: {
    "@type": "Offer",
    price: "53400",
    availability: "https://schema.org/InStock",
    priceSpecification: { priceType: "https://schema.org/ListPrice", price: "89000" },
  },
})}
</script></head><body>${"본문 ".repeat(2000)}</body></html>`;

function userMessage(text: string) {
  return {
    update_id: nextMessageId++,
    message: {
      message_id: nextMessageId++,
      from: { id: Number(CHAT_ID) },
      chat: { id: Number(CHAT_ID) },
      text,
    },
  };
}

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
}

async function captureProduct() {
  gatewayFetch.mockResolvedValue({
    ok: true,
    status: 200,
    body: PRODUCT_HTML,
    finalUrl: PRODUCT_URL,
  });
  await handleUpdate(userMessage(PRODUCT_URL));
  return db.product.findFirstOrThrow({ where: { musinsaGoodsNo: GOODS_NO } });
}

beforeEach(async () => {
  sent.length = 0;
  gatewayFetch.mockReset();
  await resetDb();
});

describe("USER_URL 피기백 — 링크를 던질 때마다 이력이 쌓인다", () => {
  it("캡처 1회가 스냅샷 1건을 남긴다 (판매가·정가)", async () => {
    const product = await captureProduct();
    const snapshots = await db.priceSnapshot.findMany({ where: { productId: product.id } });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].source).toBe("USER_URL");
    expect(snapshots[0].salePrice).toBe(53400);
    expect(snapshots[0].listPrice).toBe(89000);
  });

  it("같은 링크를 다시 던지면 덮어쓰지 않고 스냅샷이 누적된다", async () => {
    const product = await captureProduct();
    await handleUpdate(userMessage(PRODUCT_URL));
    expect(await db.priceSnapshot.count({ where: { productId: product.id } })).toBe(2);
  });

  it("파싱 실패(차단 페이지)면 스냅샷을 남기지 않는다", async () => {
    gatewayFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: "<html>짧은 차단 페이지</html>",
      finalUrl: PRODUCT_URL,
    });
    await handleUpdate(userMessage(PRODUCT_URL));
    expect(await db.priceSnapshot.count()).toBe(0);
  });
});

describe("/bf2025 — 작년 BF 가격 수동 입력 (네트워크 요청 0건)", () => {
  it("등록된 상품에 MANUAL 스냅샷을 기록하고 할인율을 알려준다", async () => {
    const product = await captureProduct();
    gatewayFetch.mockClear();

    await handleUpdate(userMessage(`/bf2025 ${PRODUCT_URL} 39,900원 89000`));

    // 수동 입력은 어떤 아웃바운드 요청도 만들지 않는다 (docs/05 §4.6)
    expect(gatewayFetch).not.toHaveBeenCalled();

    const manual = await db.priceSnapshot.findFirstOrThrow({ where: { source: "MANUAL" } });
    expect(manual.productId).toBe(product.id);
    expect(manual.salePrice).toBe(39900);
    expect(manual.listPrice).toBe(89000);
    expect(manual.eventTag).toBe("BF2025");

    const reply = sent.at(-1)?.text ?? "";
    expect(reply).toContain("기록 완료");
    expect(reply).toContain("55%"); // (1 - 39900/89000) ≈ 55%
  });

  it("상품번호만으로도 입력할 수 있고, 정가 생략 시 상품 정가를 쓴다", async () => {
    await captureProduct();
    await handleUpdate(userMessage(`/bf2025 ${GOODS_NO} 45000`));

    const manual = await db.priceSnapshot.findFirstOrThrow({ where: { source: "MANUAL" } });
    expect(manual.salePrice).toBe(45000);
    expect(manual.listPrice).toBe(89000); // 캡처 때 저장된 Product.listPrice
  });

  it("미등록 상품이면 기록하지 않고 등록 방법을 안내한다", async () => {
    await handleUpdate(userMessage("/bf2025 999999 39900"));
    expect(await db.priceSnapshot.count()).toBe(0);
    expect(sent.at(-1)?.text).toContain("등록되지 않았습니다");
  });

  it("형식이 틀리면 사용법을 안내한다", async () => {
    await handleUpdate(userMessage("/bf2025"));
    expect(sent.at(-1)?.text).toContain("사용법");
    expect(await db.priceSnapshot.count()).toBe(0);
  });

  it("링크 대기(pendingInput) 중에도 큐레이터 링크 파서로 새지 않는다", async () => {
    const product = await captureProduct();
    // [이거 올릴래]를 눌러 링크 대기 상태로 만든다
    const deal = await db.deal.findFirstOrThrow({ where: { productId: product.id } });
    await db.deal.update({
      where: { id: deal.id },
      data: { approvalStage: "AWAITING_LINK", pendingInput: "CURATOR_LINK" },
    });

    await handleUpdate(userMessage(`/bf2025 ${GOODS_NO} 39900`));

    expect(await db.priceSnapshot.count({ where: { source: "MANUAL" } })).toBe(1);
    expect(sent.at(-1)?.text).toContain("기록 완료");
    // 대기 상태는 그대로 유지된다 — 명령이 대기를 깨뜨리면 안 된다
    const after = await db.deal.findUniqueOrThrow({ where: { id: deal.id } });
    expect(after.pendingInput).toBe("CURATOR_LINK");
  });
});
