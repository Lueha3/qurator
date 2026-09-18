import { beforeEach, describe, expect, it } from "vitest";

// 성과 집계를 진짜 DB로 검증한다.
// 이 모듈이 틀리면 조용히 틀린다 — 화면에는 그럴듯한 숫자가 뜨고, 현표는 그 숫자를 보고
// 다음에 무엇을 올릴지 정한다. 특히 봇 클릭이 섞이면 "자기 실적처럼 보이는 숫자"가 된다.

const { db } = await import("../db");
const { loadStats, KAKAO_DAILY_LIMIT } = await import("../stats");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function resetDb() {
  await db.clickEvent.deleteMany();
  await db.hubVisit.deleteMany();
  await db.shortLink.deleteMany();
  await db.post.deleteMany();
  await db.contentCard.deleteMany();
  await db.curatorLink.deleteMany();
  await db.deal.deleteMany();
  await db.productVariant.deleteMany();
  await db.priceSnapshot.deleteMany();
  await db.watchItem.deleteMany();
  await db.product.deleteMany();
  await db.creator.deleteMany();
}

/** 딜 1건 + 지면별 숏링크. 클릭은 숏링크에 달리므로 집계의 최소 단위가 이것이다. */
async function seedDeal(goodsNo: string, brand: string, productName: string) {
  const creator =
    (await db.creator.findFirst()) ?? (await db.creator.create({ data: { handle: "stats_test" } }));
  const product = await db.product.create({
    data: {
      creatorId: creator.id,
      musinsaGoodsNo: goodsNo,
      canonicalUrl: `https://www.musinsa.com/products/${goodsNo}`,
      brandName: brand,
      productName,
      listPrice: 89000,
    },
  });
  const deal = await db.deal.create({
    data: { productId: product.id, creatorId: creator.id, status: "PUBLISHED" },
  });
  const link = await db.curatorLink.create({
    data: { dealId: deal.id, rawUrl: `https://www.musinsa.com/products/${goodsNo}?utm_term=x` },
  });
  return { deal, link };
}

async function shortLink(dealId: string, curatorLinkId: string, surface: string) {
  return db.shortLink.create({
    data: {
      code: `c${Math.random().toString(36).slice(2, 8)}`,
      dealId,
      curatorLinkId,
      surface,
      targetUrl: "https://www.musinsa.com/products/1?utm_term=x",
    },
  });
}

async function click(shortLinkId: string, ago: number, uaClass: "human" | "bot" = "human") {
  await db.clickEvent.create({
    data: { shortLinkId, ts: new Date(Date.now() - ago), uaClass },
  });
}

beforeEach(async () => {
  await resetDb();
});

describe("성과 집계", () => {
  it("봇 클릭은 빼고 센다 — 자기 실적처럼 보이는 숫자를 만들지 않는다", async () => {
    const { deal, link } = await seedDeal("900001", "쿠어", "오버셔츠");
    const sl = await shortLink(deal.id, link.id, "hub");
    await click(sl.id, 1 * HOUR);
    await click(sl.id, 2 * HOUR);
    await click(sl.id, 3 * HOUR, "bot");

    const stats = await loadStats(7);
    expect(stats.clicks.value).toBe(2);
  });

  it("기간 밖 클릭은 직전 기간으로 잡힌다 — 변화량의 기준", async () => {
    const { deal, link } = await seedDeal("900002", "쿠어", "오버셔츠");
    const sl = await shortLink(deal.id, link.id, "hub");
    await click(sl.id, 1 * DAY); // 이번 주
    await click(sl.id, 9 * DAY); // 지난 주
    await click(sl.id, 20 * DAY); // 두 기간 모두 밖

    const stats = await loadStats(7);
    expect(stats.clicks.value).toBe(1);
    expect(stats.clicks.prev).toBe(1);
  });

  it("지면별로 나눠 센다", async () => {
    const { deal, link } = await seedDeal("900003", "쿠어", "오버셔츠");
    const hub = await shortLink(deal.id, link.id, "hub");
    const kakao = await shortLink(deal.id, link.id, "kakao_open");
    await click(hub.id, HOUR);
    await click(kakao.id, HOUR);
    await click(kakao.id, 2 * HOUR);

    const stats = await loadStats(7);
    expect(stats.bySurface).toEqual([
      { label: "카톡 오픈채팅", value: 2 },
      { label: "팔로워 페이지", value: 1 },
    ]);
    expect(stats.hubClicks).toBe(1);
  });

  it("딜별 클릭은 지면을 합쳐 많은 순으로 준다", async () => {
    const a = await seedDeal("900004", "쿠어", "오버셔츠");
    const b = await seedDeal("900005", "토피", "가디건");
    const aHub = await shortLink(a.deal.id, a.link.id, "hub");
    const aKakao = await shortLink(a.deal.id, a.link.id, "kakao_open");
    const bHub = await shortLink(b.deal.id, b.link.id, "hub");
    await click(aHub.id, HOUR);
    await click(aKakao.id, HOUR);
    await click(bHub.id, HOUR);

    const stats = await loadStats(7);
    expect(stats.topDeals).toHaveLength(2);
    expect(stats.topDeals[0]).toMatchObject({ brand: "쿠어", productName: "오버셔츠", clicks: 2 });
    expect(stats.topDeals[1]).toMatchObject({ brand: "토피", clicks: 1 });
  });

  it("허브 CTR은 방문이 없으면 null이다 — 0%로 그리면 거짓말이 된다", async () => {
    const { deal, link } = await seedDeal("900006", "쿠어", "오버셔츠");
    const sl = await shortLink(deal.id, link.id, "hub");
    await click(sl.id, HOUR);

    expect((await loadStats(7)).hubCtr).toBeNull();

    await db.hubVisit.createMany({
      data: [{ uaClass: "human" }, { uaClass: "human" }, { uaClass: "human" }, { uaClass: "bot" }],
    });

    const stats = await loadStats(7);
    expect(stats.hubVisits.value).toBe(3); // 봇 방문 제외
    expect(stats.hubCtr).toBe(33); // 1/3
  });

  it("오늘 카톡 게시 수만 따로 센다 — 어제 것은 오늘 페이스가 아니다", async () => {
    const { deal } = await seedDeal("900007", "쿠어", "오버셔츠");
    const card = await db.contentCard.create({
      data: {
        dealId: deal.id,
        channel: "KAKAO_OPEN",
        bodyText: "본문",
        charCount: 2,
        disclosureOk: true,
      },
    });
    const post = (publishedAt: Date, channel: "KAKAO_OPEN" | "THREADS" = "KAKAO_OPEN") =>
      db.post.create({
        data: {
          contentCardId: card.id,
          dealId: deal.id,
          channel,
          mode: "SEMI_COPIED",
          status: "SENT",
          publishedAt,
        },
      });

    const now = new Date();
    const todayNoon = new Date(now);
    todayNoon.setHours(12, 0, 0, 0);
    // 자정 이전(=어제)이면 오늘 카운트에 들어가면 안 된다
    await post(new Date(now.getTime() - 3 * DAY));
    await post(todayNoon <= now ? todayNoon : now);
    await post(now, "THREADS"); // 카톡이 아닌 채널은 페이스 계산에서 뺀다

    const stats = await loadStats(7);
    expect(stats.kakaoToday).toBe(1);
    expect(stats.posts.value).toBe(3); // 발행 총계는 채널을 가리지 않는다
    expect(KAKAO_DAILY_LIMIT).toBe(5);
  });

  it("데이터가 없으면 0과 빈 목록을 준다 — 화면이 터지지 않는다", async () => {
    const stats = await loadStats(30);
    expect(stats.clicks.value).toBe(0);
    expect(stats.bySurface).toEqual([]);
    expect(stats.topDeals).toEqual([]);
    expect(stats.hubCtr).toBeNull();
  });
});
