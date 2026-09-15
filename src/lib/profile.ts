// 크리에이터 프로필 — 설정 탭에서 고치는 두 값(허브 한 줄 소개, 큐레이션 샵 주소).
//
// 두 값 모두 **링크로 렌더되거나 공개 허브에 실린다.** 그래서 저장 전에 여기서 막는다:
//   - 샵 주소는 https + 무신사 도메인만 받는다. javascript:·data: 같은 스킴을 원천 차단하고,
//     공개 지면에 엉뚱한 도메인이 실리는 사고도 함께 막는다.
//   - 소개는 한 줄이다. 길면 허브 머리가 본문을 밀어낸다.

import { db } from "./db";
import { getDefaultCreator } from "./creator";

/** 허브 상단 한 줄 — 제목 아래 한 줄로 읽혀야 한다 */
export const MAX_BIO_LENGTH = 60;

export type ProfileResult = { ok: true } | { ok: false; reason: string };

export function validateCuratorShopUrl(raw: string): { ok: true; value: string | null } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "주소 형식이 올바르지 않습니다. https://로 시작하는 전체 주소를 넣어주세요." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "https:// 주소만 넣을 수 있습니다." };
  }
  if (url.hostname !== "musinsa.com" && !url.hostname.endsWith(".musinsa.com")) {
    return { ok: false, reason: "무신사 주소만 넣을 수 있습니다 (musinsa.com)." };
  }
  return { ok: true, value: url.toString() };
}

export async function updateProfile(input: { bio: string; curatorShopUrl: string }): Promise<ProfileResult> {
  const shop = validateCuratorShopUrl(input.curatorShopUrl);
  if (!shop.ok) return shop;

  const bio = input.bio.trim().replace(/\s+/g, " ");
  if (bio.length > MAX_BIO_LENGTH) {
    return { ok: false, reason: `소개는 ${MAX_BIO_LENGTH}자까지 넣을 수 있습니다.` };
  }

  const creator = await getDefaultCreator();
  await db.creator.update({
    where: { id: creator.id },
    data: { bio: bio || null, curatorShopUrl: shop.value },
  });
  return { ok: true };
}
