// 폼(클라이언트) ↔ API 라우트가 공유하는 타입. Prisma 모델을 직접 노출하지 않고
// 여기서 한 번 정리해, 스키마가 바뀌어도 클라이언트 코드 변경 범위를 좁힌다.

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
  snapshotCount: number;
}

export interface DealDTO {
  id: string;
  brand: string;
  productName: string;
  styleCode: string | null;
  canonicalUrl: string;
  listPrice: number;
  salePrice: number | null;
  finalPrice: number | null;
  discountRate: number | null;
  couponDesc: string | null;
  endsAt: string | null;
  hookLine: string | null;
  hookSource: "ai" | "human" | null;
  status: string;
  createdAt: string;
  cards: CardDTO[];
  /** 가격 이력 요약. 스냅샷이 없으면 null (BF 스트립을 그리지 않는다) */
  priceHistory: PriceHistoryDTO | null;
}

export interface CreateDealResponse {
  deal: DealDTO;
}

export interface ApiErrorResponse {
  error: string;
  code?: string;
}
