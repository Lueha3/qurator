// 무신사 상품 페이지 파서.
//
// 설계 원칙 (docs/02-architecture.md §5.1):
//   1. **절대 throw하지 않는다.** 파싱 실패는 정상적인 결과다 — 수동 입력 폴백으로 이어진다.
//      "크롤링이 전부 막혀도 가치가 남는 구조"라는 절대 원칙 2가 여기서 지켜진다.
//   2. 추출 순서: JSON-LD → OpenGraph → 없으면 포기. DOM 셀렉터는 쓰지 않는다.
//      기계 소비용으로 사이트가 자발적으로 공개한 구조화 데이터만 읽는다는 뜻이고,
//      리뉴얼마다 깨지는 셀렉터 유지보수도 피한다.
//   3. **필드 화이트리스트.** 상품명·브랜드·가격·이미지만 뽑는다. 리뷰 영역은 건드리지 않는다
//      (닉네임 등 개인정보가 있을 수 있다 — 수집 범위를 좁히는 것이 법적으로도 안전하다).
//   4. 결과는 해당 딜 카드에 종속된 스냅샷이다. 전 상품을 조회 가능한 테이블로 축적하지 않는다
//      (저작권법 제93조 제2항 단서의 '체계적 수집'과 거리를 둔다).

export interface ParsedProduct {
  brandName: string | null;
  productName: string | null;
  listPrice: number | null;
  salePrice: number | null;
  styleCode: string | null;
  imageUrl: string | null;
  /** 어느 경로로 뽑혔는지 — 사람에게 "얼마나 믿을 만한지" 알려주기 위해 남긴다 */
  source: "json-ld" | "opengraph" | "none";
  /** 파싱된 필드 수. 0이면 완전 실패(수동 입력으로 폴백해야 함) */
  fieldCount: number;
  /**
   * 재고 판정용 — **최상위 Product의 offers만** 집계한다.
   * 헬스체커가 HTML 전문을 문자열로 훑으면 추천상품·연관상품의 품절 표기까지 걸려
   * 잘 팔리는 상품이 품절로 확정되는 사고가 난다. 그래서 구조화된 offer만 센다.
   */
  offers: { total: number; inStock: number; hasAvailabilityInfo: boolean };
}

const NO_OFFERS = { total: 0, inStock: 0, hasAvailabilityInfo: false };

const EMPTY: ParsedProduct = {
  brandName: null,
  productName: null,
  listPrice: null,
  salePrice: null,
  styleCode: null,
  imageUrl: null,
  source: "none",
  fieldCount: 0,
  offers: NO_OFFERS,
};

function toPrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
  if (typeof value === "string") {
    // "89,000" / "89000원" / "89000.00" 형태를 모두 받는다
    const digits = value.replace(/[^\d.]/g, "");
    if (!digits) return null;
    const n = Number(digits);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  return null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : null;
}

/** HTML에서 <script type="application/ld+json"> 블록들을 꺼낸다 (JSON 파싱 실패는 무시) */
function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(match[1].trim()));
    } catch {
      // 깨진 JSON-LD는 흔하다. 조용히 넘어가고 다음 블록을 본다.
    }
  }
  return blocks;
}

/**
 * JSON-LD는 @graph, 최상위 배열, WebPage.mainEntity 등 여러 형태로 Product를 감싼다.
 * @graph만 따라가면 mainEntity 안의 Product를 놓치므로 모든 객체 값을 순회한다.
 * guard로 순회 횟수를 묶어 순환 참조·거대 문서에서도 멈춘다.
 */
function findProductNode(blocks: unknown[]): Record<string, unknown> | null {
  const queue: unknown[] = [...blocks];
  const seen = new Set<unknown>();
  let guard = 0;

  while (queue.length > 0 && guard++ < 2000) {
    const node = queue.shift();
    if (!node || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }
    const obj = node as Record<string, unknown>;

    const type = obj["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => typeof t === "string" && t.toLowerCase() === "product")) {
      return obj;
    }

    // 중첩된 어디든 Product가 있을 수 있다 (@graph, mainEntity, itemListElement…)
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return null;
}

interface OfferPrices {
  salePrice: number | null;
  listPrice: number | null;
  /** 재고 판정용 집계 — 최상위 Product의 offers만 반영된다 */
  stats: { total: number; inStock: number; hasAvailabilityInfo: boolean };
}

/** priceSpecification은 단일 객체나 배열로 오고, ListPrice 타입이 정가를 담는다 */
function listPriceFromSpec(spec: unknown): number | null {
  const specs = Array.isArray(spec) ? spec : [spec];
  let fallback: number | null = null;
  for (const s of specs) {
    if (!s || typeof s !== "object") continue;
    const obj = s as Record<string, unknown>;
    const price = toPrice(obj.price);
    if (price === null) continue;
    const type = String(obj["@type"] ?? obj.priceType ?? "").toLowerCase();
    if (type.includes("listprice")) return price;
    fallback ??= price;
  }
  return fallback;
}

function hasAvailability(offer: Record<string, unknown>): boolean {
  return String(offer.availability ?? "").trim().length > 0;
}

function isInStock(offer: Record<string, unknown>): boolean {
  const availability = String(offer.availability ?? "").toLowerCase();
  if (!availability) return true; // 표기가 없으면 판매 중으로 본다
  return !availability.includes("outofstock") && !availability.includes("soldout");
}

/**
 * offers에서 판매가·정가를 뽑는다.
 * 무신사처럼 옵션이 많은 상품은 offers가 배열이거나 AggregateOffer로 온다:
 *  - 배열: 첫 번째를 무조건 쓰면 품절 옵션의 정가가 잡힐 수 있다 → 재고 있는 것 중 최저가
 *  - AggregateOffer: price가 없고 lowPrice/highPrice만 있다 → 이걸 못 읽으면 가격이 0원이 된다
 */
function extractOfferPrices(offersRaw: unknown): OfferPrices {
  if (!offersRaw || typeof offersRaw !== "object") {
    return { salePrice: null, listPrice: null, stats: { ...NO_OFFERS } };
  }

  const offers = (Array.isArray(offersRaw) ? offersRaw : [offersRaw]).filter(
    (o): o is Record<string, unknown> => !!o && typeof o === "object"
  );

  let salePrice: number | null = null;
  let listPrice: number | null = null;
  const stats = { total: 0, inStock: 0, hasAvailabilityInfo: false };

  for (const offer of offers) {
    const type = String(offer["@type"] ?? "").toLowerCase();

    if (type.includes("aggregateoffer")) {
      // AggregateOffer는 옵션별 재고를 알려주지 않는다 — 재고 판정 불가로 남긴다.
      const low = toPrice(offer.lowPrice);
      const high = toPrice(offer.highPrice);
      if (low !== null && (salePrice === null || low < salePrice)) salePrice = low;
      if (high !== null && (listPrice === null || high > listPrice)) listPrice = high;
      continue;
    }

    stats.total++;
    if (hasAvailability(offer)) stats.hasAvailabilityInfo = true;
    if (!isInStock(offer)) continue;
    stats.inStock++;

    const price = toPrice(offer.price);
    if (price !== null && (salePrice === null || price < salePrice)) salePrice = price;

    const spec = listPriceFromSpec(offer.priceSpecification);
    if (spec !== null && (listPrice === null || spec > listPrice)) listPrice = spec;
  }

  // 재고 있는 오퍼가 하나도 없으면(전 옵션 품절) 최소한 가격 표기는 살린다
  if (salePrice === null) {
    for (const offer of offers) {
      const price = toPrice(offer.price);
      if (price !== null && (salePrice === null || price < salePrice)) salePrice = price;
    }
  }

  return { salePrice, listPrice, stats };
}

function parseJsonLd(html: string): ParsedProduct | null {
  const product = findProductNode(extractJsonLdBlocks(html));
  if (!product) return null;

  const brandRaw = product.brand;
  const brandName =
    cleanText(brandRaw) ??
    (brandRaw && typeof brandRaw === "object"
      ? cleanText((brandRaw as Record<string, unknown>).name)
      : null);

  const { salePrice, listPrice, stats } = extractOfferPrices(product.offers);

  const imageRaw = product.image;
  const imageUrl = cleanText(Array.isArray(imageRaw) ? imageRaw[0] : imageRaw);

  const parsed: ParsedProduct = {
    brandName,
    productName: cleanText(product.name),
    listPrice,
    salePrice,
    styleCode: cleanText(product.mpn) ?? cleanText(product.sku),
    imageUrl,
    source: "json-ld",
    fieldCount: 0,
    offers: stats,
  };
  parsed.fieldCount = countFields(parsed);
  return parsed.fieldCount > 0 ? parsed : null;
}

function metaContent(html: string, property: string): string | null {
  // property= 와 name= 양쪽을 받고, content가 앞에 오는 순서도 처리한다.
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeHtmlEntities(m[1]);
  }
  return null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function parseOpenGraph(html: string): ParsedProduct | null {
  const parsed: ParsedProduct = {
    brandName: cleanText(metaContent(html, "product:brand")),
    productName: cleanText(metaContent(html, "og:title")),
    listPrice: null,
    salePrice: toPrice(metaContent(html, "product:price:amount")),
    styleCode: null,
    imageUrl: cleanText(metaContent(html, "og:image")),
    source: "opengraph",
    fieldCount: 0,
    // OG 메타에는 옵션별 재고 정보가 없다
    offers: { ...NO_OFFERS },
  };
  parsed.fieldCount = countFields(parsed);
  return parsed.fieldCount > 0 ? parsed : null;
}

function countFields(p: ParsedProduct): number {
  return [p.brandName, p.productName, p.listPrice, p.salePrice, p.styleCode, p.imageUrl].filter(
    (v) => v !== null
  ).length;
}

/**
 * 상품 페이지 HTML에서 쓸 수 있는 필드를 뽑는다. 절대 throw하지 않는다.
 * 반환값의 fieldCount가 0이면 "파싱 실패" — 호출부는 수동 입력을 요청해야 한다.
 */
export function parseProductPage(html: string): ParsedProduct {
  try {
    const fromJsonLd = parseJsonLd(html);
    const fromOg = parseOpenGraph(html);

    if (!fromJsonLd) return fromOg ?? EMPTY;
    if (!fromOg) return fromJsonLd;

    // JSON-LD를 기본으로 하되 빈 필드만 OG로 메운다 (source는 주된 출처를 유지)
    const merged: ParsedProduct = {
      brandName: fromJsonLd.brandName ?? fromOg.brandName,
      productName: fromJsonLd.productName ?? fromOg.productName,
      listPrice: fromJsonLd.listPrice ?? fromOg.listPrice,
      salePrice: fromJsonLd.salePrice ?? fromOg.salePrice,
      styleCode: fromJsonLd.styleCode ?? fromOg.styleCode,
      imageUrl: fromJsonLd.imageUrl ?? fromOg.imageUrl,
      source: "json-ld",
      fieldCount: 0,
      offers: fromJsonLd.offers,
    };
    merged.fieldCount = countFields(merged);
    return merged;
  } catch {
    // 어떤 예외도 밖으로 내보내지 않는다 — 파싱 실패가 파이프라인을 멈추면 안 된다.
    return EMPTY;
  }
}

/**
 * 200 응답인데 상품 구조가 전혀 없으면 차단 페이지일 가능성이 높다 (리서치의 '부정형 판정').
 * 헛되이 재시도해서 진짜 차단을 부르는 것이 최악이므로, 이 신호는 재시도가 아니라
 * 수동 입력 폴백으로 이어져야 한다.
 */
export function looksLikeNonProductPage(html: string, parsed: ParsedProduct): boolean {
  if (parsed.fieldCount > 0) return false;
  // 본문이 비정상적으로 짧으면 챌린지/에러 페이지
  return html.length < 3000 || !html.toLowerCase().includes("<html");
}
