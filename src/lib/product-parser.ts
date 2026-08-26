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
}

const EMPTY: ParsedProduct = {
  brandName: null,
  productName: null,
  listPrice: null,
  salePrice: null,
  styleCode: null,
  imageUrl: null,
  source: "none",
  fieldCount: 0,
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

/** JSON-LD는 @graph 배열이나 최상위 배열로 감싸여 오는 경우가 많다 — 평탄화해서 Product를 찾는다 */
function findProductNode(blocks: unknown[]): Record<string, unknown> | null {
  const queue: unknown[] = [...blocks];
  let guard = 0;
  while (queue.length > 0 && guard++ < 200) {
    const node = queue.shift();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }
    const obj = node as Record<string, unknown>;
    const graph = obj["@graph"];
    if (Array.isArray(graph)) queue.push(...graph);

    const type = obj["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => typeof t === "string" && t.toLowerCase() === "product")) {
      return obj;
    }
  }
  return null;
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

  // offers는 단일 객체 또는 배열
  const offersRaw = product.offers;
  const offer = (Array.isArray(offersRaw) ? offersRaw[0] : offersRaw) as
    | Record<string, unknown>
    | undefined;

  const salePrice = offer ? toPrice(offer.price) : null;
  // schema.org에 정가 필드가 따로 있는 경우가 있다 (priceSpecification / highPrice)
  const listPrice =
    offer && offer.priceSpecification && typeof offer.priceSpecification === "object"
      ? toPrice((offer.priceSpecification as Record<string, unknown>).price)
      : null;

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
