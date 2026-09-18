import type { ApprovalStageDTO } from "./api-types";

// 승인 단계의 이름과 색 — 행(DealListRow)·시트(DealStageCard)·홈이 같은 것을 쓴다.
// 세 곳이 각자 표를 갖고 있으면 한 곳만 고쳐지는 날이 온다.

export const STAGE_LABEL: Record<ApprovalStageDTO, string> = {
  CANDIDATE: "후보",
  AWAITING_LINK: "링크 대기",
  READY_TO_PUBLISH: "승인 대기",
  APPROVED: "승인 완료",
  SKIPPED: "기록 완료",
};

/**
 * 상태 점의 Tailwind 클래스. null이면 점을 찍지 않는다.
 * 기록 완료(SKIPPED)에 색이 없는 이유: 끝난 일에 색을 쓰면 정작 지금 해야 할 일의 색이 묻힌다.
 */
export const STAGE_DOT: Record<ApprovalStageDTO, string | null> = {
  CANDIDATE: "bg-stage-candidate",
  AWAITING_LINK: "bg-stage-awaiting",
  READY_TO_PUBLISH: "bg-stage-ready",
  APPROVED: "bg-stage-approved",
  SKIPPED: null,
};

/** 홈 "오늘 할 일"이 보여주는 순서 — 지금 눌러야 끝나는 것이 위. 승인 대기는 승인 한 번이면 끝난다 */
export const TODO_STAGES: ApprovalStageDTO[] = ["READY_TO_PUBLISH", "AWAITING_LINK", "CANDIDATE"];

/** 딜 탭 필터 키 — 홈 딥링크가 이 값으로 연다 */
export const STAGE_FILTER: Record<ApprovalStageDTO, string> = {
  CANDIDATE: "candidate",
  AWAITING_LINK: "awaiting",
  READY_TO_PUBLISH: "ready",
  APPROVED: "approved",
  SKIPPED: "skipped",
};
