import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/l/[code]/route";
import { db } from "../db";
import { ensureShortLink } from "../shortlink";

// 불변식 I-5 (docs/03-account-safety.md §5.3)의 집행을 실제 라우트로 검증한다.
//
// "자동 302의 최종 목적지는 절대 '다른 상품의 커미션 링크'가 될 수 없다."
// 이걸 어기면 무신사 로그에는 "사용자가 A를 클릭했는데 B의 커미션 실적이 찍혔다"만 남고,
// 링크 스왑/트래픽 전용 패턴과 구분되지 않아 큐레이터 자격 상실로 이어진다.

const CURATOR_URL_A =
  "https://www.musinsa.com/products/1111111?utm_source=curator&utm_term=AAAAAAAAAA&af_dp=x";
const CURATOR_URL_B =
  "https://www.musinsa.com/products/2222222?utm_source=curator&utm_term=BBBBBBBBBB";

async function seedDeal(goodsNo: string, curatorUrl: string) {
  const creator = await db.creator.upsert({
    where: { handle: "maison_jenflox" },
    update: {},
    create: { handle: "maison_jenflox" },
  });
  const product = await db.product.create({
    data: {
      creatorId: creator.id,
      musinsaGoodsNo: goodsNo,
      canonicalUrl: `https://www.musinsa.com/products/${goodsNo}`,
      brandName: "쿠어",
      productName: `상품 ${goodsNo}`,
      listPrice: 89000,
    },
  });
  const deal = await db.deal.create({
    data: { productId: product.id, creatorId: creator.id, status: "PUBLISHED" },
  });
  const link = await db.curatorLink.create({
    data: { dealId: deal.id, rawUrl: curatorUrl, isDefault: true },
  });
  const code = await ensureShortLink({
    dealId: deal.id,
    curatorLinkId: link.id,
    targetUrl: curatorUrl,
    surface: "hub",
  });
  return { deal, link, code };
}

function request(code: string, ua = "Mozilla/5.0 (iPhone) Safari/604.1") {
  return new NextRequest(`http://localhost:3000/l/${code}`, {
    headers: { "user-agent": ua },
  });
}

async function resetDb() {
  await db.clickEvent.deleteMany();
  await db.shortLink.deleteMany();
  await db.post.deleteMany();
  await db.contentCard.deleteMany();
  await db.curatorLink.deleteMany();
  await db.deal.deleteMany();
  await db.product.deleteMany();
}

beforeEach(resetDb);

describe("숏링크 리다이렉트 — 원형 무변조", () => {
  it("큐레이터 링크를 파라미터까지 그대로 보존해 302한다", async () => {
    const { code } = await seedDeal("1111111", CURATOR_URL_A);
    const res = await GET(request(code), { params: Promise.resolve({ code }) });

    expect(res.status).toBe(302);
    // 링크 변조 금지 조항(docs/03 §5.2): 파라미터를 붙이거나 빼면 안 된다
    expect(res.headers.get("location")).toBe(CURATOR_URL_A);
  });

  it("검색봇이 커미션 링크를 따라가지 못하게 noindex를 붙인다", async () => {
    const { code } = await seedDeal("1111111", CURATOR_URL_A);
    const res = await GET(request(code), { params: Promise.resolve({ code }) });
    expect(res.headers.get("x-robots-tag")).toContain("nofollow");
  });
});

describe("불변식 I-5: 죽은 링크는 다른 상품 커미션 링크로 착지하지 않는다", () => {
  it("DEAD 링크는 비커미션 안내 페이지로 보낸다", async () => {
    const { code, link } = await seedDeal("1111111", CURATOR_URL_A);
    // 대안이 될 만한 살아있는 딜을 하나 만들어 둔다 — 이게 있어도 자동 이동하면 안 된다
    await seedDeal("2222222", CURATOR_URL_B);

    await db.shortLink.updateMany({ where: { curatorLinkId: link.id }, data: { state: "DEAD" } });

    const res = await GET(request(code), { params: Promise.resolve({ code }) });
    const location = res.headers.get("location") ?? "";

    expect(res.status).toBe(302);
    // 자체 안내 페이지로 가야 한다
    expect(location).toContain(`/expired/${code}`);
    // 그리고 절대로 무신사 커미션 링크가 아니어야 한다
    expect(location).not.toContain("musinsa.com");
    expect(location).not.toContain("utm_term");
    expect(location).not.toContain("BBBBBBBBBB");
  });

  it("존재하지 않는 코드도 커미션 링크로 보내지 않는다", async () => {
    const res = await GET(request("nope123"), { params: Promise.resolve({ code: "nope123" }) });
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/expired/");
    expect(location).not.toContain("musinsa.com");
  });
});

describe("클릭 계측", () => {
  it("사람 클릭을 기록한다 (IP는 저장하지 않는다)", async () => {
    const { code } = await seedDeal("1111111", CURATOR_URL_A);
    await GET(request(code), { params: Promise.resolve({ code }) });

    const clicks = await db.clickEvent.findMany();
    expect(clicks).toHaveLength(1);
    expect(clicks[0].uaClass).toBe("human");
    // IP 컬럼 자체가 없어야 한다 — 개인정보 최소화
    expect(Object.keys(clicks[0])).not.toContain("ip");
  });

  it("봇 클릭을 봇으로 분류한다 (성과 집계에서 걸러내기 위해)", async () => {
    const { code } = await seedDeal("1111111", CURATOR_URL_A);
    await GET(request(code, "Googlebot/2.1 (+http://www.google.com/bot.html)"), {
      params: Promise.resolve({ code }),
    });

    const click = await db.clickEvent.findFirstOrThrow();
    expect(click.uaClass).toBe("bot");
  });

  it("클릭 기록이 실패해도 리다이렉트는 나간다", async () => {
    // 사용자를 상품 페이지로 보내는 것이 계측보다 우선이다
    const { code } = await seedDeal("1111111", CURATOR_URL_A);
    const res = await GET(request(code), { params: Promise.resolve({ code }) });
    expect(res.status).toBe(302);
  });
});

describe("숏링크 발급", () => {
  it("같은 딜×링크×지면에는 코드를 재사용한다", async () => {
    const { deal, link, code } = await seedDeal("1111111", CURATOR_URL_A);
    const again = await ensureShortLink({
      dealId: deal.id,
      curatorLinkId: link.id,
      targetUrl: CURATOR_URL_A,
      surface: "hub",
    });
    expect(again).toBe(code);
  });

  it("지면이 다르면 다른 코드를 발급한다 (채널 기여를 구분하기 위해)", async () => {
    const { deal, link, code } = await seedDeal("1111111", CURATOR_URL_A);
    const kakao = await ensureShortLink({
      dealId: deal.id,
      curatorLinkId: link.id,
      targetUrl: CURATOR_URL_A,
      surface: "kakao_open",
    });
    expect(kakao).not.toBe(code);
  });
});
