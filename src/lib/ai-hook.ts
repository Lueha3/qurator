// AI 훅 초안 — docs/02-architecture.md §9 정본 구현.
//
// 3대 불변 원칙 (docs/02 §4, §9):
//   1. AI는 hookLine "문장 필드"만 생성한다 — 가격·재고·쿠폰·링크는 절대 생성하지 않는다.
//   2. 실패해도 파이프라인은 멈추지 않는다: 타임아웃/API 키 없음/에러 시 null을 반환하고,
//      렌더러는 빈 훅으로 정상 진행한다 (그레이스풀 디그레이드 — AI는 가속기, 단일 장애점이 아니다).
//   3. 출력은 입력으로 준 사실(dealFacts)에 없는 숫자·주장을 지어내지 않는다(프롬프트 강제 +
//      Phase 1+에서 출력 역검증 추가 예정 — docs/02 §9 "환각 방지 3중" 중 1차).

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 10_000;

export interface HookDraftInput {
  brand: string;
  productName: string;
  discountRate?: number | null;
  couponDesc?: string | null;
  sizeHint?: string | null; // 예: "S/M 품절 임박" 같은 재고 신호 (있으면만 전달)
}

let client: Anthropic | null | undefined;

function getClient(): Anthropic | null {
  if (client !== undefined) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  client = apiKey ? new Anthropic({ apiKey }) : null;
  return client;
}

const SYSTEM_PROMPT = `너는 무신사 패션 큐레이터 '현표'의 카피라이터다.
현표의 톤: 반말과 존댓말을 섞어 쓰는 구어체, 속보 느낌("떴다", "이건 각", "품절각"),
과장된 최상급 표현은 쓰지 않는다.

규칙:
- 정확히 1줄, 한국어, 20~40자 내외의 훅 문장만 출력한다. 다른 설명·따옴표·이모지 나열 금지.
- 제공된 사실(브랜드/상품명/할인율/쿠폰/재고 힌트)에 없는 가격·재고 수치·기능을 지어내지 마라.
- 광고 고지 문구를 스스로 넣지 마라 (시스템이 별도로 삽입한다).`;

/**
 * hookLine 초안 1개를 생성한다. 실패 시(키 없음/타임아웃/API 에러) null을 반환하며,
 * 이는 오류가 아니라 정상적인 폴백 경로다 — 호출부는 null을 "빈 훅으로 진행"으로 처리한다.
 */
export async function draftHookLine(input: HookDraftInput): Promise<string | null> {
  const anthropic = getClient();
  if (!anthropic) return null;

  const facts = [
    `브랜드: ${input.brand}`,
    `상품명: ${input.productName}`,
    input.discountRate != null ? `할인율: ${input.discountRate}%` : null,
    input.couponDesc ? `쿠폰: ${input.couponDesc}` : null,
    input.sizeHint ? `재고 힌트: ${input.sizeHint}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await anthropic.messages.create(
      {
        model: MODEL,
        max_tokens: 100,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: facts }],
      },
      { signal: controller.signal }
    );
    clearTimeout(timer);

    const block = response.content.find((c) => c.type === "text");
    if (!block || block.type !== "text") return null;

    const text = block.text.trim().replace(/^["'"]|["'"]$/g, "");
    return text.length > 0 ? text : null;
  } catch {
    // 네트워크 오류·타임아웃·레이트리밋 등 — 전부 동일하게 "AI 초안 없음"으로 처리.
    return null;
  }
}
