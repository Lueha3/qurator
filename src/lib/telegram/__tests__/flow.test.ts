import { beforeEach, describe, expect, it, vi } from "vitest";

// 텔레그램 API와 무신사 게이트웨이를 가로채고, 그 사이의 **상태 머신과 DB는 진짜로** 돌린다.
// 검증 대상: 후보 → 링크 대기 → 발행 승인 → 승인 완료 전이가 실제로 일어나는가,
// 그리고 각 단계에서 계정 안전 불변식이 지켜지는가.

const sent: Array<{ chatId: string | number; text: string; keyboard?: unknown }> = [];
const edited: Array<{ messageId: number; text: string }> = [];
let nextMessageId = 100;

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>();
  return {
    ...actual,
    sendMessage: vi.fn(async (opts: { chatId: string | number; text: string; keyboard?: unknown }) => {
      sent.push(opts);
      return { message_id: nextMessageId++ };
    }),
    editMessage: vi.fn(async (opts: { messageId: number; text: string }) => {
      edited.push(opts);
    }),
    answerCallback: vi.fn(async () => {}),
  };
});

const gatewayFetch = vi.fn();
vi.mock("../../fetch-gateway", () => ({
  gatewayFetch: (...args: unknown[]) => gatewayFetch(...args),
  USER_AGENT: "HoneyFlowBot/1.0",
}));

// AI 훅은 네트워크를 타므로 끈다 — 훅 없이도 파이프라인이 도는지가 검증 포인트다.
vi.mock("../../ai-hook", () => ({ draftHookLine: vi.fn(async () => null) }));

const { handleUpdate, extractUrls } = await import("../handler");
const { db } = await import("../../db");
const { CB } = await import("../cards");

const CHAT_ID = "555000";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = CHAT_ID;

const PRODUCT_HTML = `<!doctype html><html><head>
<script type="application/ld+json">
{"@type":"Product","name":"오버핏 맨투맨","mpn":"CO-123",
 "brand":{"name":"쿠어"},"image":["https://image.msscdn.net/x.jpg"],
 "offers":{"price":"53400"}}
</script></head><body>${"본문 ".repeat(2000)}</body></html>`;

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

async function resetDb() {
  await db.post.deleteMany();
  await db.contentCard.deleteMany();
  await db.curatorLink.deleteMany();
  await db.deal.deleteMany();
  await db.productVariant.deleteMany();
  await db.product.deleteMany();
  await db.auditLog.deleteMany();
}

beforeEach(async () => {
  sent.length = 0;
  edited.length = 0;
  gatewayFetch.mockReset();
  await resetDb();
});

describe("URL 추출", () => {
  it("entity 기반과 정규식 폴백 양쪽에서 URL을 찾는다", () => {
    const text = "이거 봐 https://www.musinsa.com/products/1 어때";
    expect(extractUrls(text, undefined)).toEqual(["https://www.musinsa.com/products/1"]);
    expect(
      extractUrls("https://www.musinsa.com/products/2", [
        { type: "url", offset: 0, length: 38 },
      ])
    ).toEqual(["https://www.musinsa.com/products/2"]);
  });

  it("한글·이모지가 섞여도 offset이 어긋나지 않는다 (UTF-16 코드유닛)", () => {
    const url = "https://www.musinsa.com/products/7";
    const prefix = "꿀템 🔥 ";
    const text = prefix + url;
    const extracted = extractUrls(text, [
      { type: "url", offset: prefix.length, length: url.length },
    ]);
    expect(extracted).toEqual([url]);
  });
});

describe("전체 흐름: URL → 후보 → 링크 대기 → 승인", () => {
  it("해피패스가 끝까지 돈다", async () => {
    gatewayFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: PRODUCT_HTML,
      finalUrl: "https://www.musinsa.com/products/1234567",
    });

    // ① URL 던지기 → 후보 카드
    await handleUpdate(userMessage("https://www.musinsa.com/products/1234567"));

    let deal = await db.deal.findFirstOrThrow({ include: { product: true } });
    expect(deal.approvalStage).toBe("CANDIDATE");
    expect(deal.product.brandName).toBe("쿠어");
    expect(deal.product.productName).toBe("오버핏 맨투맨");
    expect(deal.salePrice).toBe(53400);

    // 게이트웨이에는 정규화된 URL이, USER_URL 트리거로 전달되어야 한다
    expect(gatewayFetch).toHaveBeenCalledWith({
      url: "https://www.musinsa.com/products/1234567",
      trigger: "USER_URL",
    });

    // ② [이거 올릴래] → 링크 대기
    await handleUpdate(buttonTap(CB.interested(deal.id)));
    deal = await db.deal.findUniqueOrThrow({ where: { id: deal.id }, include: { product: true } });
    expect(deal.approvalStage).toBe("AWAITING_LINK");

    // ③ 큐레이터 링크 붙여넣기 → 카드 렌더 + 발행 승인 대기
    await handleUpdate(
      userMessage("https://www.musinsa.com/products/1234567?utm_source=curator&utm_term=01HZX8QK9M")
    );
    deal = await db.deal.findUniqueOrThrow({ where: { id: deal.id }, include: { product: true } });
    expect(deal.approvalStage).toBe("READY_TO_PUBLISH");
    expect(deal.status).toBe("READY");

    const link = await db.curatorLink.findFirstOrThrow({ where: { dealId: deal.id } });
    expect(link.ulid).toBe("01HZX8QK9M");
    // 원본 무변조 보존 (링크 변조 금지 조항)
    expect(link.rawUrl).toContain("utm_term=01HZX8QK9M");

    const cards = await db.contentCard.findMany({ where: { dealId: deal.id } });
    expect(cards).toHaveLength(4);
    expect(cards.every((c) => c.disclosureOk)).toBe(true);

    // ④ [승인] → 카톡 문구 전달
    sent.length = 0;
    await handleUpdate(buttonTap(CB.approve(deal.id)));
    deal = await db.deal.findUniqueOrThrow({ where: { id: deal.id }, include: { product: true } });
    expect(deal.approvalStage).toBe("APPROVED");
    expect(deal.status).toBe("PUBLISHED");

    const post = await db.post.findFirstOrThrow({ where: { dealId: deal.id } });
    expect(post.mode).toBe("SEMI_COPIED"); // 카톡은 반자동 — 사람이 전송한다
    expect(post.channel).toBe("KAKAO_OPEN");

    // 카톡 전달 메시지에 고지문이 첫 줄로 들어가 있어야 한다
    const delivery = sent.find((s) => s.text.includes("<pre>"));
    expect(delivery).toBeDefined();
    expect(delivery!.text).toContain("(광고) 아래 링크로 구매 시 수수료를 받습니다");

    // 승인 사실이 감사 로그에 남는다 (제재 시 "사람이 승인했다"의 증적)
    const approved = await db.auditLog.findFirst({ where: { action: "deal.approved" } });
    expect(approved?.actor).toBe("HUMAN");
    expect(approved?.payloadHash).toBeTruthy();
  });
});

describe("게이트웨이가 막혀도 파이프라인이 죽지 않는다 (절대 원칙 2)", () => {
  it("차단 감지 시 딜은 생성되고 수동 입력을 안내한다", async () => {
    gatewayFetch.mockResolvedValue({
      ok: false,
      outcome: "BOT_CHALLENGE",
      reason: "무신사가 자동 요청을 차단하고 있습니다.",
    });

    await handleUpdate(userMessage("https://www.musinsa.com/products/999"));

    // 크롤링이 실패해도 딜은 만들어진다 — 수동 입력으로 이어가야 하므로
    const deal = await db.deal.findFirstOrThrow({ include: { product: true } });
    expect(deal.approvalStage).toBe("CANDIDATE");
    expect(deal.product.brandName).toBe("(브랜드 미입력)");

    // 사용자에게 차단 사유가 전달된다 (조용한 실패 금지)
    const notice = edited.find((e) => e.text.includes("차단"));
    expect(notice).toBeDefined();
  });
});

describe("접근 통제 (docs/03 §3.7)", () => {
  it("화이트리스트에 없는 사용자는 아무 일도 일으키지 못한다", async () => {
    gatewayFetch.mockResolvedValue({ ok: true, status: 200, body: PRODUCT_HTML, finalUrl: "x" });

    await handleUpdate(userMessage("https://www.musinsa.com/products/1", 999999));

    expect(await db.deal.count()).toBe(0);
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0); // 봇의 존재조차 확인시켜 주지 않는다

    const denied = await db.auditLog.findFirst({ where: { action: "telegram.unauthorized" } });
    expect(denied).toBeTruthy();
  });
});

describe("URL 가드가 봇 경로에서도 적용된다", () => {
  it("무신사가 아닌 링크는 게이트웨이까지 가지 않는다", async () => {
    await handleUpdate(userMessage("https://evil.example.com/products/1"));

    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(await db.deal.count()).toBe(0);
    expect(sent.some((s) => s.text.includes("무신사 상품 페이지 주소만"))).toBe(true);
  });

  it("커미션 파라미터가 붙은 URL을 던져도 정규화된 URL만 fetch한다", async () => {
    gatewayFetch.mockResolvedValue({ ok: true, status: 200, body: PRODUCT_HTML, finalUrl: "x" });

    await handleUpdate(
      userMessage("https://www.musinsa.com/products/1234567?utm_source=curator&utm_term=ABC")
    );

    // 자기 클릭이 어뷰징 실적으로 잡히는 사고를 막는 핵심 불변식
    const calledWith = gatewayFetch.mock.calls[0][0] as { url: string };
    expect(calledWith.url).toBe("https://www.musinsa.com/products/1234567");
    expect(calledWith.url).not.toContain("utm_");
  });
});

describe("스킵", () => {
  it("스킵하면 상태가 SKIPPED로 남고 감사 로그가 기록된다", async () => {
    gatewayFetch.mockResolvedValue({ ok: true, status: 200, body: PRODUCT_HTML, finalUrl: "x" });
    await handleUpdate(userMessage("https://www.musinsa.com/products/1234567"));
    const deal = await db.deal.findFirstOrThrow();

    await handleUpdate(buttonTap(CB.skip(deal.id)));

    const after = await db.deal.findUniqueOrThrow({ where: { id: deal.id } });
    expect(after.approvalStage).toBe("SKIPPED");
    expect(await db.auditLog.findFirst({ where: { action: "deal.skipped" } })).toBeTruthy();
  });
});
