"use server";

// 대시보드의 버튼이 부르는 서버 액션. 전부 proxy.ts의 APP_ACCESS_TOKEN 게이트 뒤에 있다
// (서버 액션은 페이지 경로로 POST되므로 같은 게이트를 지난다). 입력은 딜/상품의 id와 사람이
// 바꾼 값뿐이고, 나머지는 DB에서 다시 읽는다 — 클라이언트가 보낸 행 내용을 믿지 않는다.
//
// 상태 전이 자체는 src/lib/deal-flow.ts가 담당한다. 여기서는 호출·재검증(revalidatePath)만 한다.

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import {
  approveDeal,
  attachCuratorLink,
  markInterested,
  replaceHook,
  reopenDeal,
  startDealFromProduct,
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
import { parseTagInput } from "@/lib/deal-tags";
import { updateProfile, type ProfileResult } from "@/lib/profile";
import { markSoldOut, restoreDeal, type LinkHealthResult } from "@/lib/link-health";
import { applyDedupe, planDedupe, type DedupePlan } from "@/lib/dedupe";
import { deleteDeals, type DeleteDealsResult } from "@/lib/deal-delete";
import { createInvite, deletePasskey, revokeInvite } from "@/lib/passkey";
import {
  removeSubscription,
  saveSubscription,
  sendTestPush,
  type DigestRun,
} from "@/lib/push";

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

export async function startDealAction(
  productId: string
): Promise<{ ok: true; dealId: string; reused: boolean } | { ok: false; reason: string }> {
  const result = await startDealFromProduct(productId);
  revalidateApp();
  return result;
}

export async function reopenAction(dealId: string): Promise<{ ok: boolean; reason?: string }> {
  const result = await reopenDeal(dealId);
  revalidateApp();
  return result;
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
  /** 쉼표로 구분한 허브 섹션 태그 ("가을 아우터, BF 픽") */
  tags: string;
}

function intOrNull(raw: string, label: string): number | null | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return { error: `${label}는 숫자만 적어주세요.` };
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
  patch.tags = parseTagInput(input.tags);
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

export async function markSoldOutAction(dealId: string): Promise<LinkHealthResult> {
  const result = await markSoldOut(dealId);
  revalidateApp();
  revalidatePath("/hub");
  return result;
}

export async function restoreDealAction(dealId: string): Promise<LinkHealthResult> {
  const result = await restoreDeal(dealId);
  revalidateApp();
  revalidatePath("/hub");
  return result;
}

/** 무엇을 닫을지 계산만 한다 — 이 액션은 DB를 바꾸지 않는다. */
export async function dedupePreviewAction(): Promise<DedupePlan> {
  return planDedupe();
}

export async function dedupeApplyAction(): Promise<{ closed: number }> {
  // 계획은 서버가 다시 계산한다 — 클라이언트가 보낸 목록을 믿지 않는다.
  const result = await applyDedupe();
  revalidateApp();
  return result;
}

/** 딜 탭 체크박스 다중 선택 삭제 — src/lib/deal-delete.ts 참고. */
export async function deleteDealsAction(dealIds: string[]): Promise<DeleteDealsResult> {
  const result = await deleteDeals(dealIds);
  revalidateApp();
  return result;
}

export async function updateProfileAction(input: {
  bio: string;
  curatorShopUrl: string;
}): Promise<ProfileResult> {
  const result = await updateProfile(input);
  revalidateApp();
  revalidatePath("/hub");
  return result;
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

// ── 아침 알림 (V2-G) ────────────────────────────────────────────────────
// 구독 정보는 브라우저가 만들어 주고 우리는 저장만 한다. 클라이언트가 보낸 값이라
// saveSubscription 안에서 형식을 다시 검증한다 — 임의의 주소가 들어오면 우리 서버가
// 그리로 요청을 보내는 발판이 된다.

export async function pushSubscribeAction(subscription: unknown): Promise<boolean> {
  const ua = (await headers()).get("user-agent");
  const ok = await saveSubscription(subscription, ua);
  revalidatePath("/settings");
  return ok;
}

export async function pushUnsubscribeAction(endpoint: string): Promise<boolean> {
  const ok = await removeSubscription(endpoint);
  revalidatePath("/settings");
  return ok;
}

export async function pushTestAction(): Promise<DigestRun> {
  return sendTestPush();
}

export async function deletePasskeyAction(id: string): Promise<boolean> {
  const ok = await deletePasskey(id);
  revalidatePath("/settings");
  return ok;
}

// ── 패스키 초대 (V2 협업) ───────────────────────────────────────────────
// 실사용자(현표)에게 마스터 토큰을 넘기지 않고 패스키만 등록시키는 길 — docs/03 §7.2.

export async function createInviteAction(note: string): Promise<{ url: string; expiresAt: string }> {
  const invite = await createInvite(note.trim() || null);
  const base = process.env.PUBLIC_BASE_URL ?? "";
  revalidatePath("/settings");
  return {
    url: `${base}/login?invite=${encodeURIComponent(invite.code)}`,
    expiresAt: invite.expiresAt.toISOString(),
  };
}

export async function revokeInviteAction(id: string): Promise<boolean> {
  const ok = await revokeInvite(id);
  revalidatePath("/settings");
  return ok;
}
