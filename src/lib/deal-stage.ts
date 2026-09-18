import type { ApprovalStageDTO } from "./api-types";

// 단계의 이름과 색 — 행(DealListRow)·시트(DealStageCard)·홈이 같은 것을 쓴다.
// 세 곳이 각자 표를 갖고 있으면 한 곳만 고쳐지는 날이 온다.
//
// 이름은 "지금 무엇을 하면 되는가"로 지었다(docs/08 §4.0.7). 예전 이름(후보·링크 대기·승인 대기·승인 완료·기록 완료)은
// 개발자의 상태 기계 용어라, 큐레이터가 "후보"를 보고 무엇을 해야 하는지 몰랐다.
// 코드 식별자(CANDIDATE 등)와 docs의 단계 이름은 그대로다 — 바뀐 것은 화면에 보이는 말뿐이다.

export const STAGE_LABEL: Record<ApprovalStageDTO, string> = {
  CANDIDATE: "올릴지 정하기",
  AWAITING_LINK: "링크 붙이기",
  READY_TO_PUBLISH: "문구 확정하기",
  APPROVED: "확정됨",
  SKIPPED: "안 올림",
};

/**
 * 홈 "오늘 할 일"의 문구. 처음엔 상태명(결정 전·링크 필요·문구 준비됨)과 따로 뒀는데, 검수에서 "홈에서 '카톡 문구 받기'를
 * 누르면 행에는 '문구 준비됨'이라 적혀 있어 매번 머릿속에서 번역한다"고 짚었다 — 그래서 한 벌로 합쳤다.
 * 진행 중인 단계는 전부 할 일 동사이고, 끝난 단계만 상태다(확정됨·안 올림).
 */
export const TODO_LABEL: Record<ApprovalStageDTO, string> = STAGE_LABEL;

/**
 * 상태 점의 Tailwind 클래스. null이면 점을 찍지 않는다.
 * 안 올림(SKIPPED)에 색이 없는 이유: 끝난 일에 색을 쓰면 정작 지금 해야 할 일의 색이 묻힌다.
 */
export const STAGE_DOT: Record<ApprovalStageDTO, string | null> = {
  CANDIDATE: "bg-stage-candidate",
  AWAITING_LINK: "bg-stage-awaiting",
  READY_TO_PUBLISH: "bg-stage-ready",
  APPROVED: "bg-stage-approved",
  SKIPPED: null,
};

/** 홈 "오늘 할 일"이 보여주는 순서 — 지금 눌러야 끝나는 것이 위. 문구 준비됨은 한 번이면 끝난다 */
export const TODO_STAGES: ApprovalStageDTO[] = ["READY_TO_PUBLISH", "AWAITING_LINK", "CANDIDATE"];

/** 딜 탭 필터 키 — 홈 딥링크가 이 값으로 연다 */
export const STAGE_FILTER: Record<ApprovalStageDTO, string> = {
  CANDIDATE: "candidate",
  AWAITING_LINK: "awaiting",
  READY_TO_PUBLISH: "ready",
  APPROVED: "approved",
  SKIPPED: "skipped",
};
