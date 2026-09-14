// 상품 매칭 — docs/06-screenshot-capture.md §4.2.
//
// 스크린샷 경로에는 goodsNo가 없다(무신사 요청 0건이 원칙이라 링크를 따라가 확정할 수 없다).
// 그래서 "이 스크린샷이 어느 Product인가"를 추론해야 하고, 순서가 정확도의 전부다 — 뒤 단계로
// 갈수록 "추측"의 비중이 커지므로 앞 단계에서 맞으면 그 자리에서 멈춘다:
//   1) styleCode(품번) 정확 일치
//   2) (brand, productName) 정규화 일치 — 단, 후보가 정확히 1개일 때만(모호하면 추측하지 않는다,
//      "never invent data" 원칙)
//   3) 없으면 신규 Product 생성 (musinsaGoodsNo=null, source=SCREENSHOT)
// 나중에 큐레이터 링크가 오면 그 Product에 goodsNo를 채우는 것은 이 모듈의 책임이 아니다(§4.2 후반).
//
// (2026-09-14: 텔레그램 시절의 "같은 대화에서 링크를 먼저 던진 직후" 규칙은 웹 전환과 함께 사라졌다 —
//  링크 던지기 경로 자체가 없다.)

import { randomUUID } from "node:crypto";
import { db } from "./db";
import type { Product } from "@prisma/client";

export interface MatchProductInput {
  creatorId: string;
  brand: string | null;
  productName: string | null;
  styleCode: string | null;
}

export type MatchedBy = "styleCode" | "nameMatch" | "created";

export interface MatchProductResult {
  product: Product;
  matchedBy: MatchedBy;
}

/**
 * 브랜드·상품명 비교용 정규화. 무신사 상품명은 공백·구두점 표기가 들쑥날쑥해서
 * ("스탠다드 오버셔츠" vs "스탠다드-오버셔츠") 원문 그대로 비교하면 같은 상품이 다르게 잡힌다.
 * 소문자화 + 공백/흔한 구두점 제거까지만 한다 — 그 이상의 과한 정규화는 다른 상품을 같다고
 * 보는 오탐을 늘리므로 여기서 멈춘다.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[.,·/\\\-_'"!?()[\]{}~`]+/g, "");
}

/**
 * 스크린샷 1장으로 어느 Product에 스냅샷·딜을 붙일지 정한다(docs/06 §4.2). 절대 throw하지
 * 않는다는 보장은 없다 — DB 오류는 그대로 위로 던진다. 이 함수는 "어느 상품이냐"만 판단할
 * 뿐, 실패해도 괜찮은 부가 기능(AI 훅 등)이 아니라서 ai-hook.ts류의 null 폴백 패턴을 쓰지 않는다.
 */
export async function matchOrCreateProduct(
  input: MatchProductInput
): Promise<MatchProductResult> {
  // 1) styleCode(품번) 정확 일치 — creator 범위로 한정한다(다른 큐레이터의 동일 품번과 섞이지 않게).
  if (input.styleCode) {
    const byStyleCode = await db.product.findFirst({
      where: { creatorId: input.creatorId, styleCode: input.styleCode },
    });
    if (byStyleCode) {
      return { product: byStyleCode, matchedBy: "styleCode" };
    }
  }

  // 2) (brand, productName) 정규화 일치 — 정확히 1개 후보일 때만 채택한다.
  //    0개(신규로 넘어감)든 2개 이상(모호)이든 추측하지 않고 3)으로 넘어간다.
  if (input.brand && input.productName) {
    const targetBrand = normalize(input.brand);
    const targetName = normalize(input.productName);
    const candidates = await db.product.findMany({ where: { creatorId: input.creatorId } });
    const matches = candidates.filter(
      (p) => normalize(p.brandName) === targetBrand && normalize(p.productName) === targetName
    );
    if (matches.length === 1) {
      return { product: matches[0], matchedBy: "nameMatch" };
    }
  }

  // 3) 신규 Product. canonicalUrl은 NOT NULL인데 아직 실제 URL이 없으므로, 진짜 무신사 URL과
  //    절대 혼동될 수 없는 합성 sentinel 값을 쓴다(musinsa.com 형태로 짓지 않는다 — 나중에
  //    실제 URL이 온 것처럼 오인되면 dedup·헬스체크 로직이 오염된다).
  // 미확인 브랜드/상품명 placeholder는 두 입력 경로(수동 폼/스크린샷)에서 같은 "미확인" 표기가
  // 나와야 사람이 헷갈리지 않는다.
  const created = await db.product.create({
    data: {
      creatorId: input.creatorId,
      canonicalUrl: `screenshot-pending:${randomUUID()}`,
      brandName: input.brand ?? "(브랜드 미입력)",
      productName: input.productName ?? "(상품명 미입력)",
      styleCode: input.styleCode,
      listPrice: 0, // 0 = "미확인" sentinel (product-parser.ts와 동일한 관례)
      source: "SCREENSHOT",
    },
  });
  return { product: created, matchedBy: "created" };
}
