// 결정론적 렌더러 — docs/02-architecture.md §4 정본 구현.
//
// 절대 규칙 (docs/03-account-safety.md 불변식 I-3와 직결):
//   - 사실(가격/재고/쿠폰/링크)과 고지는 이 파일이 조립한다. AI는 hookLine·curatorNote 같은
//     "문장 필드" 값만 제공할 뿐, 최종 텍스트를 조립하지 않는다 (사실/문체 분리).
//   - 고지문은 채널별 상수(disclosure.ts)를 항상 첫 줄에 하드코딩 삽입한다. 템플릿에 disclosure를
//     끌 수 있는 옵션은 존재하지 않는다.
//   - 렌더는 AI 가용성에 의존하지 않는다: hookLine이 비어 있어도(AI 장애·미입력) 정상 렌더된다.

import type { Channel } from "@prisma/client";
import { DISCLOSURE, verifyDisclosure } from "./disclosure";
import { formatEndsAt, formatKRW } from "./format";

export interface DealLink {
  label: string; // "대표 링크" | 색상명
  url: string;
}

export interface DealFacts {
  brand: string;
  productName: string;
  styleCode?: string | null;
  listPrice: number;
  salePrice?: number | null;
  discountRate?: number | null;
  couponCode?: string | null;
  couponDesc?: string | null;
  finalPrice?: number | null;
  endsAt?: Date | null;
  hookLine?: string | null;
  hookSource?: "ai" | "human"; // 미지정 시 'human' — aiGeneratedFields 추적용(docs/02 §3.2)
  curatorNote?: string | null;
  links: DealLink[];
}

export interface RenderedCard {
  channel: Channel;
  bodyText: string;
  charCount: number;
  disclosureOk: boolean;
  truncated: boolean;
  warnings: string[];
  aiGeneratedFields: string[];
}

export type RenderError = { code: "NO_LIVE_LINK" | "EXPIRED"; message: string };
export type RenderResult =
  | { ok: true; card: RenderedCard }
  | { ok: false; error: RenderError };

// 채널별 하드 제약. 값이 없으면(kakao_open·notion) Phase 0에서는 무제한 —
// 카톡 200자 제약은 memo API 전용이며 Phase 0엔 memo API가 없다(docs/02 §4.3).
// IG 댓글 2,200자는 인스타그램 플랫폼 자체 한도(공식 문서 기준 실측치).
const CHAR_LIMIT: Partial<Record<Channel, number>> = {
  THREADS: 480,
  INSTAGRAM_COMMENT: 2200,
};

function priceLine(f: DealFacts): string {
  const effective = f.finalPrice ?? f.salePrice ?? f.listPrice;
  if (f.salePrice != null && f.salePrice < f.listPrice) {
    const pct = f.discountRate != null ? ` (${f.discountRate}%)` : "";
    return `${formatKRW(f.listPrice)} → ${formatKRW(effective)}${pct}`;
  }
  return formatKRW(f.listPrice);
}

function couponLine(f: DealFacts): string | null {
  if (!f.couponCode && !f.couponDesc) return null;
  const code = f.couponCode ? `${f.couponCode} ` : "";
  const desc = f.couponDesc ?? "쿠폰";
  const applied =
    f.finalPrice != null ? ` 적용가 ${formatKRW(f.finalPrice)}` : "";
  return `쿠폰 ${code}${desc}${applied}`.trim();
}

function endsLine(f: DealFacts): string | null {
  if (!f.endsAt) return null;
  return `~${formatEndsAt(f.endsAt)} 마감`;
}

function titleLine(f: DealFacts): string {
  const style = f.styleCode ? ` (${f.styleCode})` : "";
  return `${f.brand} · ${f.productName}${style}`;
}

function linksBlock(links: DealLink[]): string {
  if (links.length === 1) return links[0].url;
  return links.map((l) => `${l.label} → ${l.url}`).join("\n");
}

function collapsedLinksBlock(links: DealLink[]): string {
  if (links.length <= 1) return linksBlock(links);
  return `${links[0].url} (색상 옵션은 클릭 후 선택 가능)`;
}

interface Parts {
  hook: string | null;
  title: string;
  price: string;
  coupon: string | null;
  ends: string | null;
  note: string | null;
  links: string;
}

function assemble(disclosure: string, p: Parts): string {
  const lines = [disclosure, "", ...(p.hook ? [p.hook] : []), p.title, p.price];
  if (p.coupon) lines.push(p.coupon);
  if (p.ends) lines.push(p.ends);
  if (p.note) lines.push(p.note);
  lines.push(p.links);
  return lines.join("\n");
}

/**
 * 채널당 하나의 카드를 렌더링한다. 순수 함수 — 동일 입력이면 항상 동일 출력.
 * 링크가 0개면 렌더하지 않고 실패를 반환한다 (docs/02 §4.1 guard: 'NO_LIVE_LINK').
 */
export function renderCard(channel: Channel, facts: DealFacts): RenderResult {
  if (facts.links.length === 0) {
    return {
      ok: false,
      error: { code: "NO_LIVE_LINK", message: "살아있는 큐레이터 링크가 없습니다." },
    };
  }
  if (facts.endsAt && facts.endsAt.getTime() < Date.now()) {
    return {
      ok: false,
      error: { code: "EXPIRED", message: "마감 시각이 이미 지났습니다." },
    };
  }

  const disclosure = DISCLOSURE[channel];
  const warnings: string[] = [];

  if (channel === "INSTAGRAM_COMMENT" && (facts.hookLine ?? "").includes("#")) {
    warnings.push("해시태그는 고정댓글 채널에서 지양됩니다 (docs/02 §4.3).");
  }

  const parts: Parts = {
    hook: facts.hookLine?.trim() || null,
    title: titleLine(facts),
    price: priceLine(facts),
    coupon: couponLine(facts),
    ends: endsLine(facts),
    note: facts.curatorNote?.trim() || null,
    links: linksBlock(facts.links),
  };

  let bodyText = assemble(disclosure, parts);
  let truncated = false;

  const limit = CHAR_LIMIT[channel];
  if (limit != null && bodyText.length > limit) {
    truncated = true;
    // 축소 사다리 — docs/02 §4.1 "위반 시 자동 축약 전략 적용, 재검증".
    // 고지문과 최소 1개 링크는 어떤 단계에서도 제거하지 않는다.
    const ladder: Array<() => void> = [
      () => {
        parts.links = collapsedLinksBlock(facts.links);
      },
      () => {
        parts.note = null;
      },
      () => {
        parts.ends = null;
      },
      () => {
        parts.coupon = null;
      },
    ];
    for (const step of ladder) {
      if (bodyText.length <= limit) break;
      step();
      bodyText = assemble(disclosure, parts);
    }
    if (bodyText.length > limit && parts.hook) {
      const fixedLen = assemble(disclosure, { ...parts, hook: null }).length;
      const budget = limit - fixedLen - 1; // 훅 줄 + 개행 1개
      parts.hook =
        budget > 1 ? `${parts.hook.slice(0, budget - 1)}…` : null;
      bodyText = assemble(disclosure, parts);
    }
    if (bodyText.length > limit) {
      // 최후 안전망: disclosure·title·price·links는 보존, 그래도 넘치면 그대로 두고 경고만.
      warnings.push(
        `채널 한도(${limit}자)를 초과했습니다(${bodyText.length}자). 상품명/가격 정보를 줄여주세요.`
      );
    }
  }

  const disclosureOk = verifyDisclosure(channel, bodyText);
  const aiGeneratedFields =
    facts.hookLine && facts.hookSource === "ai" ? ["hookLine"] : [];

  return {
    ok: true,
    card: {
      channel,
      bodyText,
      charCount: bodyText.length,
      disclosureOk,
      truncated,
      warnings,
      aiGeneratedFields,
    },
  };
}

export const ALL_CHANNELS: Channel[] = [
  "KAKAO_OPEN",
  "THREADS",
  "INSTAGRAM_COMMENT",
  "NOTION",
];

export function renderAllChannels(facts: DealFacts): RenderResult[] {
  return ALL_CHANNELS.map((ch) => renderCard(ch, facts));
}
