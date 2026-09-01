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
  // FK 의존 순서대로 — 자식부터 지운다
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

// 회귀: 무신사 앱 "공유하기"가 실제로 만드는 링크는 musinsa.onelink.me(AppsFlyer OneLink)이고
// www.musinsa.com/products/{번호}로 302 리다이렉트된다. 게이트웨이가 그 리다이렉트를 따라가
// 최종 도달한 URL을 finalUrl로 돌려주는데, 예전 코드는 리다이렉트 전(onelink.me) URL에서
// goodsNo를 뽑았다 — 항상 null이 되어 같은 상품 재전송 시 dedup(upsert)이 깨지고,
// canonicalUrl에 상품과 무관한 공유 링크 자체가 저장됐다.
describe("회귀: 공유 링크 리다이렉트는 finalUrl 기준으로 정본화된다", () => {
  it("onelink.me로 들어와도 실제 도달한 상품 URL에서 goodsNo·canonicalUrl을 뽑는다", async () => {
    gatewayFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: PRODUCT_HTML,
      finalUrl: "https://www.musinsa.com/products/9988776",
    });

    await handleUpdate(userMessage("https://musinsa.onelink.me/PvkC/mq1u9fu0"));

    // 게이트웨이에는 리다이렉트 전 원본 URL이 그대로 전달된다 — 리다이렉트를 따라가는 건
    // 게이트웨이 자신의 책임이다(호출부가 미리 풀어줄 필요가 없다).
    expect(gatewayFetch).toHaveBeenCalledWith({
      url: "https://musinsa.onelink.me/PvkC/mq1u9fu0",
      trigger: "USER_URL",
    });

    const deal = await db.deal.findFirstOrThrow({ include: { product: true } });
    expect(deal.product.musinsaGoodsNo).toBe("9988776");
    expect(deal.product.canonicalUrl).toBe("https://www.musinsa.com/products/9988776");
    // 원본 공유 링크 자체는 감사·재현을 위해 sourceUrlRaw에 그대로 남는다.
    expect(deal.sourceUrlRaw).toBe("https://musinsa.onelink.me/PvkC/mq1u9fu0");
  });

  it("같은 공유 링크를 다시 던져도(재고 갱신 등) 같은 상품으로 upsert된다", async () => {
    gatewayFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: PRODUCT_HTML,
      finalUrl: "https://www.musinsa.com/products/9988776",
    });

    await handleUpdate(userMessage("https://musinsa.onelink.me/PvkC/aaa111"));
    await handleUpdate(userMessage("https://musinsa.onelink.me/PvkC/bbb222"));

    const products = await db.product.findMany({ where: { musinsaGoodsNo: "9988776" } });
    expect(products).toHaveLength(1);
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

// ── 리뷰가 잡아낸 결함들의 회귀 테스트 ──────────────────────────────────
// 이 블록이 깨지면 계정 안전 또는 제품 동작이 실제로 망가진 것이다.

describe("회귀: 딜 2건이 동시에 링크를 기다리면 안 된다", () => {
  it("두 번째 딜에 [이거 올릴래]를 누르면 첫 딜의 대기가 해제된다", async () => {
    gatewayFetch.mockResolvedValue({ ok: true, status: 200, body: PRODUCT_HTML, finalUrl: "x" });

    await handleUpdate(userMessage("https://www.musinsa.com/products/444"));
    await handleUpdate(userMessage("https://www.musinsa.com/products/555"));
    const deals = await db.deal.findMany({ orderBy: { createdAt: "asc" } });
    expect(deals).toHaveLength(2);

    await handleUpdate(buttonTap(CB.interested(deals[0].id)));
    await handleUpdate(buttonTap(CB.interested(deals[1].id)));

    // 대기 중인 딜은 항상 최대 1건 — 아니면 붙여넣은 링크가 엉뚱한 딜에 붙는다
    const pending = await db.deal.findMany({ where: { pendingInput: { not: null } } });
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(deals[1].id);
  });
});

describe("회귀: 링크가 다른 상품을 가리키면 승인 화면에 경고가 뜬다", () => {
  it("goodsNo 불일치를 감지해 경고하고 감사 로그를 남긴다", async () => {
    gatewayFetch.mockResolvedValue({ ok: true, status: 200, body: PRODUCT_HTML, finalUrl: "x" });
    await handleUpdate(userMessage("https://www.musinsa.com/products/1234567"));
    const deal = await db.deal.findFirstOrThrow();
    await handleUpdate(buttonTap(CB.interested(deal.id)));

    edited.length = 0;
    // 딜은 #1234567인데 #9999999 링크를 붙여넣는다
    await handleUpdate(
      userMessage("https://www.musinsa.com/products/9999999?utm_source=curator&utm_term=ZZZ")
    );

    const card = edited.find((e) => e.text.includes("다른 상품"));
    expect(card, "승인 카드에 링크 불일치 경고가 없다").toBeDefined();
    expect(card!.text).toContain("#9999999");

    const logged = await db.auditLog.findFirst({ where: { action: "link.warning" } });
    expect(logged).toBeTruthy();
  });

  it("커미션 파라미터가 없으면 경고한다", async () => {
    gatewayFetch.mockResolvedValue({ ok: true, status: 200, body: PRODUCT_HTML, finalUrl: "x" });
    await handleUpdate(userMessage("https://www.musinsa.com/products/1234567"));
    const deal = await db.deal.findFirstOrThrow();
    await handleUpdate(buttonTap(CB.interested(deal.id)));

    sent.length = 0;
    // 커미션 파라미터 없는 상품 URL → 링크인지 새 딜인지 되묻는다
    await handleUpdate(userMessage("https://www.musinsa.com/products/1234567"));
    expect(sent.some((s) => s.text.includes("커미션 파라미터가 없는 상품 링크"))).toBe(true);
  });
});

describe("회귀: [훅 교체] 후 보낸 문구가 훅으로 반영된다", () => {
  it("훅 문구가 큐레이터 링크 파서로 새지 않는다", async () => {
    gatewayFetch.mockResolvedValue({ ok: true, status: 200, body: PRODUCT_HTML, finalUrl: "x" });
    await handleUpdate(userMessage("https://www.musinsa.com/products/1234567"));
    const deal = await db.deal.findFirstOrThrow();
    await handleUpdate(buttonTap(CB.interested(deal.id)));
    await handleUpdate(
      userMessage("https://www.musinsa.com/products/1234567?utm_source=curator&utm_term=AAA")
    );

    await handleUpdate(buttonTap(CB.rehook(deal.id)));
    const waiting = await db.deal.findUniqueOrThrow({ where: { id: deal.id } });
    expect(waiting.pendingInput).toBe("HOOK");

    await handleUpdate(userMessage("이 가격에 S부터 품절각"));

    const after = await db.deal.findUniqueOrThrow({ where: { id: deal.id } });
    expect(after.hookLine).toBe("이 가격에 S부터 품절각");
    expect(after.pendingInput).toBeNull();
  });
});

describe("회귀: 승인은 항상 최신 버전 카드를 발행한다", () => {
  it("카드가 재렌더되면 v1이 아니라 v2가 나간다", async () => {
    gatewayFetch.mockResolvedValue({ ok: true, status: 200, body: PRODUCT_HTML, finalUrl: "x" });
    await handleUpdate(userMessage("https://www.musinsa.com/products/1234567"));
    const deal = await db.deal.findFirstOrThrow();
    await handleUpdate(buttonTap(CB.interested(deal.id)));
    await handleUpdate(
      userMessage("https://www.musinsa.com/products/1234567?utm_source=curator&utm_term=AAA")
    );

    // 훅을 교체해 v2를 만든다
    await handleUpdate(buttonTap(CB.rehook(deal.id)));
    await handleUpdate(userMessage("새로운 훅 문구 V2"));

    const versions = await db.contentCard.findMany({
      where: { dealId: deal.id, channel: "KAKAO_OPEN" },
      orderBy: { version: "asc" },
    });
    expect(versions.length).toBeGreaterThanOrEqual(2);

    sent.length = 0;
    await handleUpdate(buttonTap(CB.approve(deal.id)));

    const delivery = sent.find((s) => s.text.includes("<pre>"));
    expect(delivery).toBeDefined();
    // 보인 것 = 나가는 것: 최신 훅이 담겨야 한다
    expect(delivery!.text).toContain("새로운 훅 문구 V2");

    const post = await db.post.findFirstOrThrow({ where: { dealId: deal.id } });
    const latest = versions[versions.length - 1];
    expect(post.contentCardId).toBe(latest.id);
  });
});

describe("회귀: 같은 상품 URL을 두 번 던져도 죽지 않는다", () => {
  it("Product 유니크 제약에 걸리지 않고 두 번째 딜이 생성된다", async () => {
    gatewayFetch.mockResolvedValue({ ok: true, status: 200, body: PRODUCT_HTML, finalUrl: "x" });

    await handleUpdate(userMessage("https://www.musinsa.com/products/1234567"));
    // 두 번째 전송 — 이전 구현은 여기서 예외로 조용히 죽었다
    await handleUpdate(userMessage("https://www.musinsa.com/products/1234567"));

    expect(await db.deal.count()).toBe(2);
    expect(await db.product.count()).toBe(1); // 같은 상품은 하나로 유지
  });
});

describe("회귀: 파싱 실패 시 진행 버튼을 내주지 않는다", () => {
  it("아무 필드도 못 읽으면 [이거 올릴래] 없이 [직접 입력]만 제공한다", async () => {
    gatewayFetch.mockResolvedValue({ ok: false, outcome: "BOT_CHALLENGE", reason: "차단됨" });

    edited.length = 0;
    await handleUpdate(userMessage("https://www.musinsa.com/products/777"));

    const deal = await db.deal.findFirstOrThrow();
    expect(deal.parseSource).toBe("none");

    const card = edited[edited.length - 1];
    expect(card.text).toContain("읽지 못했습니다");
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
