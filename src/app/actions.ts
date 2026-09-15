"use server";

// 대시보드의 버튼이 부르는 서버 액션. 전부 proxy.ts의 APP_ACCESS_TOKEN 게이트 뒤에 있다
// (서버 액션은 페이지 경로로 POST되므로 같은 게이트를 지난다). 입력은 딜/상품의 id와 사람이
// 바꾼 값뿐이고, 나머지는 DB에서 다시 읽는다 — 클라이언트가 보낸 행 내용을 믿지 않는다.
//
// 상태 전이 자체는 src/lib/deal-flow.ts가 담당한다. 여기서는 호출·재검증(revalidatePath)만 한다.

import { revalidatePath } from "next/cache";
import {
  approveDeal,
  attachCuratorLink,
  markInterested,
  replaceHook,
  skipDeal,
  updateDealFacts,
  type ApproveResult,
  type AttachLinkResult,
  type DealFactsPatch,
  type HookResult,
  type UpdateFactsResult,
} from "@/lib/deal-flow";
import { addWatch, removeWatch, type AddWatchResult } from "@/lib/watch";
import { parsePriceInput, recordManualBfPrice, type ManualPriceResult } from "@/lib/price-entry";

/**
 * 딜 하나가 바뀌면 세 탭이 같이 바뀐다 — 홈(할 일 개수·최근), 딜(목록·시트), 설정(저장함 개수).
 * 셋 다 DB만 읽는 dynamic 페이지라 한 번에 무효화해도 비용이 없다.
 */
function revalidateApp(): void {
  revalidatePath("/");
  revalidatePath("/deals");
  revalidatePath("/settings");
}

export async function interestAction(dealId: string): Promise<void> {
  await markInterested(dealId);
  revalidateApp();
}

export async function skipAction(dealId: string): Promise<void> {
  await skipDeal(dealId);
  revalidateApp();
}

export async function attachLinkAction(dealId: string, text: string): Promise<AttachLinkResult> {
  const result = await attachCuratorLink(dealId, text);
  revalidateApp();
  return result;
}

export async function replaceHookAction(dealId: string, hookLine: string): Promise<HookResult> {
  const result = await replaceHook(dealId, hookLine);
  revalidateApp();
  return result;
}

export async function approveAction(dealId: string): Promise<ApproveResult> {
  const result = await approveDeal(dealId);
  revalidateApp();
  return result;
}

/** 정보 고치기 폼이 보내는 값 — 전부 문자열. 빈 문자열은 "비움"(nullable 필드) 또는 "그대로"(필수 필드)다. */
export interface FactsFormInput {
  brand: string;
  productName: string;
  styleCode: string;
  productUrl: string;
  listPrice: string;
  salePrice: string;
  discountRate: string;
  couponCode: string;
  couponDesc: string;
  finalPrice: string;
  /** datetime-local 값 (예: 2026-11-28T23:59) 또는 빈 문자열 */
  endsAt: string;
  curatorNote: string;
  hookLine: string;
}

function intOrNull(raw: string, label: string): number | null | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return { error: `${label}는 숫자로 입력해주세요.` };
  return Number(digits);
}

export async function updateFactsAction(
  dealId: string,
  input: FactsFormInput
): Promise<UpdateFactsResult> {
  const patch: DealFactsPatch = {};
  if (input.brand.trim()) patch.brand = input.brand;
  if (input.productName.trim()) patch.productName = input.productName;
  patch.styleCode = input.styleCode.trim() || null;
  patch.productUrl = input.productUrl.trim() || null;

  const listPrice = parsePriceInput(input.listPrice);
  if (listPrice !== null) patch.listPrice = listPrice;

  for (const [key, label] of [
    ["salePrice", "할인가"],
    ["finalPrice", "쿠폰 적용가"],
    ["discountRate", "할인율"],
  ] as const) {
    const parsed = intOrNull(input[key], label);
    if (parsed !== null && typeof parsed === "object") return { ok: false, reason: parsed.error };
    patch[key] = parsed;
  }

  patch.couponCode = input.couponCode;
  patch.couponDesc = input.couponDesc;
  patch.curatorNote = input.curatorNote;
  patch.hookLine = input.hookLine;
  patch.endsAt = input.endsAt.trim() ? new Date(input.endsAt) : null;

  const result = await updateDealFacts(dealId, patch);
  revalidateApp();
  return result;
}

export async function watchAction(productId: string): Promise<AddWatchResult> {
  const result = await addWatch(productId);
  revalidateApp();
  return result;
}

export async function unwatchAction(productId: string): Promise<boolean> {
  const removed = await removeWatch(productId);
  revalidateApp();
  return removed;
}

export async function manualPriceAction(input: {
  productId: string;
  salePrice: string;
  listPrice: string;
  couponPrice: string;
}): Promise<ManualPriceResult> {
  const result = await recordManualBfPrice({
    productId: input.productId,
    salePrice: input.salePrice,
    listPrice: input.listPrice || null,
    couponPrice: input.couponPrice || null,
  });
  revalidateApp();
  return result;
}
