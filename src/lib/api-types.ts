// 폼(클라이언트) ↔ API 라우트가 공유하는 타입. Prisma 모델을 직접 노출하지 않고
// 여기서 한 번 정리해, 스키마가 바뀌어도 클라이언트 코드 변경 범위를 좁힌다.

import type { VisionFailReason } from "./vision-extract";

export interface ColorLinkInput {
  label: string;
  url: string;
}

export interface CreateDealInput {
  brand: string;
  productName: string;
  styleCode?: string;
  canonicalUrl: string;
  listPrice: number;
  salePrice?: number;
  discountRate?: number;
  couponCode?: string;
  couponDesc?: string;
  finalPrice?: number;
  endsAt?: string; // ISO — 폼에서 datetime-local 값
  curatorNote?: string;
  hookLine?: string; // 비어있고 useAiHook=true면 서버가 AI 초안을 시도
  useAiHook: boolean;
  defaultLinkUrl?: string;
  colorLinks: ColorLinkInput[];
}

export interface CardDTO {
  id: string;
  channel: "KAKAO_OPEN" | "THREADS" | "INSTAGRAM_COMMENT" | "NOTION";
  bodyText: string;
  charCount: number;
  disclosureOk: boolean;
  truncated: boolean;
  warnings: string[];
  aiGeneratedFields: string[];
}

/** 행사(BF) 1건의 요약 — docs/05 §4.4. 수치 계산은 전부 서버(price-analysis)에서 끝난다. */
export interface PriceEventDTO {
  eventTag: string;
  salePrice: number;
  couponPrice: number | null;
  /** 기준가(행사 직전 중앙값) 대비 실할인율. null이면 표본 부족 — 화면에 %를 띄우면 안 된다 */
  realDiscountRate: number | null;
  /** 정가 대비 할인율 (참고값) */
  listDiscountRate: number | null;
  /** 기준가 대비, 쿠폰가까지 반영한 실할인율. couponPrice가 없으면 null */
  couponDiscountRate: number | null;
  /** 전부 수동 입력이면 true → "수동" 배지 */
  manualOnly: boolean;
  /** 기준가 표본 수 — "기준가 수집 중 (2/3)" 표시에 쓴다 */
  baselineSampleSize: number;
  baselineSufficient: boolean;
}

export interface PriceHistoryDTO {
  events: PriceEventDTO[]; // 시간순 (작년 → 올해)
  currentSalePrice: number | null;
  currentCouponPrice: number | null;
  /** 서버에서 계산한 상대 시각 문자열 ("3시간 전"). 하이드레이션 불일치 방지 */
  currentCapturedLabel: string | null;
  /**
   * 가장 오래된 자동 스냅샷 — BF 이벤트 태그가 없어도 "몇 달 전 vs 지금"을 보여주기 위한 값.
   * 자동 스냅샷이 2건 미만이면(비교 대상이 없으면) null.
   */
  firstSalePrice: number | null;
  firstCouponPrice: number | null;
  /** "6개월 전" 같은 상대 시각. currentCapturedLabel과 동일한 규칙으로 서버에서 확정한다 */
  firstCapturedLabel: string | null;
  /** 첫 기록 대비 현재가 변화율(%). 양수=하락, 음수=상승. 계산 불가하면 null */
  firstChangeRate: number | null;
  snapshotCount: number;
}

export type ApprovalStageDTO =
  | "CANDIDATE"
  | "AWAITING_LINK"
  | "READY_TO_PUBLISH"
  | "APPROVED"
  | "SKIPPED";

export interface DealDTO {
  id: string;
  productId: string;
  brand: string;
  productName: string;
  styleCode: string | null;
  canonicalUrl: string;
  /** 무신사 상품번호. 스크린샷 상품은 큐레이터 링크가 붙기 전까지 null */
  musinsaGoodsNo: string | null;
  listPrice: number;
  salePrice: number | null;
  finalPrice: number | null;
  discountRate: number | null;
  couponCode: string | null;
  couponDesc: string | null;
  endsAt: string | null;
  curatorNote: string | null;
  hookLine: string | null;
  hookSource: "ai" | "human" | null;
  /** 링크허브 섹션 태그 (docs/08 §3.3). 없으면 빈 배열 */
  tags: string[];
  status: string;
  /** 승인 카드가 어느 단계에 있는가 — 후보→링크대기→발행승인→승인/기록완료 (docs/02 §6) */
  approvalStage: ApprovalStageDTO;
  /** 'vision' | 'manual' | 'json-ld' | 'opengraph' | 'none' — "읽지 못함"이면 진행 버튼을 내주지 않는다 */
  parseSource: string | null;
  /** Vision이 스스로 매긴 확신도 — "low"면 후보 카드가 재확인을 청한다. parseSource가 'vision'일 때만 의미 있다 */
  visionConfidence: string | null;
  /** Vision이 남긴 애매한 점(예: "가격이 두 개 보임") */
  visionNotes: string | null;
  /** 붙어 있는 큐레이터 링크 수 */
  linkCount: number;
  /** 이 상품이 가격 추적(워치) 중인가 */
  watchActive: boolean;
  /** 품절·만료로 내려간 딜인가 — 허브에서 빠지고 숏링크가 안내 페이지로 간다 */
  soldOut: boolean;
  /** "지난번 ○○원 → 지금 ○○원" 한 줄. 비교할 직전 기록이 없으면 null */
  priceChangeNote: string | null;
  createdAt: string;
  cards: CardDTO[];
  /** 가격 이력 요약. 스냅샷이 없으면 null (BF 스트립을 그리지 않는다) */
  priceHistory: PriceHistoryDTO | null;
}

export interface CreateDealResponse {
  deal: DealDTO;
}

/** POST /api/capture 응답 — 스크린샷 캡처 결과 (docs/06 §3.3의 세 갈래 + 요청 오류) */
export type CaptureResponse =
  | { kind: "created"; dealId: string; priceChangeNote: string | null; reused: boolean }
  /** 좋아요 목록을 통째로 담은 결과 (docs/06 §4.6) — 딜이 아니라 지켜보는 상품이 된다 */
  | { kind: "grid"; added: number; updated: number; cheaper: number; skipped: number }
  | { kind: "not_product_page" }
  /** reason이 있어야 설정 누락(키 없음)과 사진 문제를 화면에서 구분할 수 있다 (docs/06 §4.1) */
  | { kind: "vision_failed"; reason?: VisionFailReason }
  | { kind: "error"; error: string };

export interface ApiErrorResponse {
  error: string;
  code?: string;
}
