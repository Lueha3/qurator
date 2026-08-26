import { describe, expect, it } from "vitest";
import { looksLikeNonProductPage, parseProductPage } from "../product-parser";
import { parseCuratorLink } from "../curator-link";

const JSON_LD_PAGE = `<!doctype html><html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "오버핏 맨투맨",
  "mpn": "CO-123",
  "brand": { "@type": "Brand", "name": "쿠어" },
  "image": ["https://image.msscdn.net/x.jpg"],
  "offers": { "@type": "Offer", "price": "53400", "priceCurrency": "KRW" }
}
</script>
</head><body>${"본문 ".repeat(2000)}</body></html>`;

describe("상품 파서 — JSON-LD", () => {
  it("JSON-LD Product에서 필드를 뽑는다", () => {
    const p = parseProductPage(JSON_LD_PAGE);
    expect(p.source).toBe("json-ld");
    expect(p.brandName).toBe("쿠어");
    expect(p.productName).toBe("오버핏 맨투맨");
    expect(p.salePrice).toBe(53400);
    expect(p.styleCode).toBe("CO-123");
    expect(p.imageUrl).toBe("https://image.msscdn.net/x.jpg");
  });

  it("@graph로 감싸인 구조에서도 Product를 찾는다", () => {
    const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[
      {"@type":"BreadcrumbList"},
      {"@type":"Product","name":"티셔츠","offers":{"price":19000}}
    ]}</script></head><body>${"x".repeat(4000)}</body></html>`;
    const p = parseProductPage(html);
    expect(p.productName).toBe("티셔츠");
    expect(p.salePrice).toBe(19000);
  });

  it("가격 문자열의 쉼표·단위를 처리한다", () => {
    const html = `<html><head><script type="application/ld+json">
    {"@type":"Product","name":"바지","offers":{"price":"129,000원"}}</script></head><body>${"x".repeat(4000)}</body></html>`;
    expect(parseProductPage(html).salePrice).toBe(129000);
  });
});

describe("상품 파서 — OpenGraph 폴백", () => {
  it("JSON-LD가 없으면 OG 메타로 폴백한다", () => {
    const html = `<html><head>
      <meta property="og:title" content="후드 집업" />
      <meta property="og:image" content="https://image.msscdn.net/y.jpg" />
      <meta property="product:price:amount" content="78000" />
      <meta property="product:brand" content="아워데이즈" />
    </head><body>${"x".repeat(4000)}</body></html>`;
    const p = parseProductPage(html);
    expect(p.source).toBe("opengraph");
    expect(p.productName).toBe("후드 집업");
    expect(p.brandName).toBe("아워데이즈");
    expect(p.salePrice).toBe(78000);
  });

  it("JSON-LD의 빈 필드를 OG가 메운다", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"Product","name":"코트"}</script>
      <meta property="og:image" content="https://image.msscdn.net/z.jpg" />
    </head><body>${"x".repeat(4000)}</body></html>`;
    const p = parseProductPage(html);
    expect(p.productName).toBe("코트");
    expect(p.imageUrl).toBe("https://image.msscdn.net/z.jpg");
  });
});

describe("상품 파서 — 절대 throw하지 않는다 (수동 입력 폴백 보장)", () => {
  it("깨진 JSON-LD를 만나도 조용히 넘어간다", () => {
    const html = `<html><head>
      <script type="application/ld+json">{ 이건 JSON이 아님 }</script>
      <meta property="og:title" content="정상 상품" />
    </head><body>${"x".repeat(4000)}</body></html>`;
    const p = parseProductPage(html);
    expect(p.productName).toBe("정상 상품");
  });

  it("빈 문자열·쓰레기 입력에도 예외 없이 fieldCount 0을 반환한다", () => {
    for (const junk of ["", "<html></html>", "그냥 텍스트", "<script>{}</script>"]) {
      const p = parseProductPage(junk);
      expect(p.fieldCount).toBe(0);
      expect(p.source).toBe("none");
    }
  });

  it("구조가 전혀 없고 본문이 짧으면 차단 페이지로 의심한다", () => {
    const challenge = "<html><body>Just a moment...</body></html>";
    const p = parseProductPage(challenge);
    expect(looksLikeNonProductPage(challenge, p)).toBe(true);
  });

  it("정상 파싱된 페이지는 차단 의심 대상이 아니다", () => {
    const p = parseProductPage(JSON_LD_PAGE);
    expect(looksLikeNonProductPage(JSON_LD_PAGE, p)).toBe(false);
  });
});

describe("큐레이터 링크 파서 — 네트워크를 건드리지 않는다", () => {
  it("utm_term ULID와 상품번호를 뽑는다", () => {
    const result = parseCuratorLink(
      "https://www.musinsa.com/products/1234567?utm_source=curator&utm_term=01HZX8QK9M"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.link.ulid).toBe("01HZX8QK9M");
    expect(result.link.goodsNo).toBe("1234567");
    expect(result.link.hasCommissionParams).toBe(true);
  });

  it("원본 URL을 무변조로 보존한다 (링크 변조 금지 조항)", () => {
    const raw = "https://www.musinsa.com/products/1?utm_source=curator&utm_term=ABC&af_dp=x%3A%2F%2F";
    const result = parseCuratorLink(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.link.rawUrl).toBe(raw);
  });

  it("앞뒤에 말이 붙어 있어도 링크를 찾아낸다", () => {
    const result = parseCuratorLink(
      "이거 링크임 https://www.musinsa.com/products/999?utm_term=XYZ 확인해줘"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.link.goodsNo).toBe("999");
  });

  it("커미션 파라미터가 없으면 표시해 사람이 확인하게 한다", () => {
    const result = parseCuratorLink("https://www.musinsa.com/products/1234567");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.link.hasCommissionParams).toBe(false);
  });

  it("무신사가 아닌 링크와 링크 없는 메시지를 거부한다", () => {
    expect(parseCuratorLink("https://evil.example.com/x").ok).toBe(false);
    expect(parseCuratorLink("링크 없이 그냥 말").ok).toBe(false);
  });
});
