// 과거 행사 가격 수동 입력 — docs/05-price-watch.md §2(a).
//
// 자동으로는 복원 불가능한 과거(2025 BF) 가격의 유일한 입력 경로다. 네트워크 요청이 전혀 없는
// 순수 DB 기록이며, 상품은 이미 캡처된 것만 받는다 — 여기서 미등록 상품을 만들면 이름 없는
// 껍데기 Product가 생기고, 그걸 채우려면 결국 스크린샷을 올려야 한다(순서만 바뀐 셈).

import { db } from "./db";
import { recordSnapshot } from "./price-snapshot";
import { BF2025_OBSERVED_AT } from "./price-analysis";
import { audit } from "./audit";

export const BF_MANUAL_TAG = "BF2025";

/** "39,000" / "39000원" 같은 사람 입력을 원 단위 정수로. 비었거나 0 이하면 null. */
export function parsePriceInput(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  const digits = value.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface ManualPriceInput {
  productId: string;
  salePrice: string | number;
  /** 미입력 시 상품의 정가를 쓴다. 0은 "미확인" 표시값이므로 정가로 취급하지 않는다 */
  listPrice?: string | number | null;
  couponPrice?: string | number | null;
}

export type ManualPriceResult =
  | {
      ok: true;
      productLabel: string;
      salePrice: number;
      listPrice: number | null;
      couponPrice: number | null;
      /** 정가 대비 할인율(%). 정가를 모르면 null */
      rate: number | null;
      couponRate: number | null;
    }
  | { ok: false; reason: string };

function rateOf(listPrice: number | null, price: number | null): number | null {
  if (!listPrice || !price || listPrice <= price) return null;
  return Math.round((1 - price / listPrice) * 100);
}

/** 작년 BF 판매가(선택: 정가·쿠폰가)를 MANUAL 스냅샷으로 기록한다. */
export async function recordManualBfPrice(input: ManualPriceInput): Promise<ManualPriceResult> {
  const salePrice = parsePriceInput(input.salePrice);
  if (salePrice === null) return { ok: false, reason: "판매가를 숫자로 입력해주세요." };

  const product = await db.product.findUnique({ where: { id: input.productId } });
  if (!product) return { ok: false, reason: "등록되지 않은 상품입니다. 스크린샷을 먼저 올려 등록해주세요." };

  const listPrice =
    parsePriceInput(input.listPrice) ?? (product.listPrice > 0 ? product.listPrice : null);
  const couponPrice = parsePriceInput(input.couponPrice);

  const saved = await recordSnapshot({
    productId: product.id,
    salePrice,
    listPrice,
    couponPrice,
    source: "MANUAL",
    eventTag: BF_MANUAL_TAG,
    // capturedAt은 "그 가격이 참이었던 시점"이다. 입력 시각(지금)으로 찍으면 작년 가격이
    // 최신 스냅샷이 되어 카드의 '현재가'와 시계열 순서가 통째로 뒤집힌다.
    capturedAt: BF2025_OBSERVED_AT,
    note: `웹에서 수동 입력 (${new Date().toISOString().slice(0, 10)} 기록)`,
  });
  if (!saved.recorded) return { ok: false, reason: "기록하지 못했습니다. 다시 시도해주세요." };

  await audit({
    actor: "HUMAN",
    action: "snapshot.manual",
    approvalRef: product.id,
    detail:
      `${BF_MANUAL_TAG} ${product.brandName} ${product.productName} — ` +
      `판매가 ${salePrice}${listPrice ? ` / 정가 ${listPrice}` : ""}${couponPrice ? ` / 쿠폰가 ${couponPrice}` : ""}`,
  });

  return {
    ok: true,
    productLabel: `${product.brandName} ${product.productName}`,
    salePrice,
    listPrice,
    couponPrice,
    rate: rateOf(listPrice, salePrice),
    couponRate: rateOf(listPrice, couponPrice),
  };
}
