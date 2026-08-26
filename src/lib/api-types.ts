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
}

export interface CreateDealResponse {
  deal: DealDTO;
}

export interface ApiErrorResponse {
  error: string;
  code?: string;
}
