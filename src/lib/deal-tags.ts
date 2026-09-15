// 딜 태그 — 링크허브의 섹션 묶음 (docs/08 §3.3).
//
// 저장 형태는 JSON 문자열 배열이고, 읽고 쓰는 경로가 여기 하나뿐이다.
// 태그 하나가 곧 허브의 한 섹션이므로, 사람이 아무렇게나 적어도 화면이 무너지지 않게
// 여기서 다듬는다: 공백 정리 → 빈 값 제거 → 중복 제거 → 개수·길이 상한.

/** 한 딜에 붙일 수 있는 태그 수. 섹션이 늘어날수록 허브가 길어지므로 낮게 잡는다. */
export const MAX_TAGS = 3;
/** 태그 한 개의 최대 길이 — 섹션 제목으로 한 줄에 들어와야 한다 */
export const MAX_TAG_LENGTH = 20;

export function normalizeTags(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    const tag = value.trim().replace(/\s+/g, " ").slice(0, MAX_TAG_LENGTH);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** 폼 입력("가을 아우터, BF 픽") → 태그 배열 */
export function parseTagInput(input: string): string[] {
  return normalizeTags(input.split(","));
}

/** DB 값 → 태그 배열. 깨진 JSON이 허브를 죽이지 않게 조용히 빈 배열로 떨어진다. */
export function parseTags(stored: string | null): string[] {
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return normalizeTags(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return [];
  }
}

/** 태그 배열 → DB 값. 비었으면 null로 저장해 "없음"을 한 가지 형태로만 남긴다. */
export function serializeTags(tags: string[]): string | null {
  const normalized = normalizeTags(tags);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

/** 폼 표시용 — 태그 배열을 다시 한 줄로 */
export function formatTagInput(tags: string[]): string {
  return tags.join(", ");
}
