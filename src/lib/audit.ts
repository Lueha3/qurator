// 감사 로그 — docs/03-account-safety.md §11.
//
// 목적은 두 가지다:
//   ① 플랫폼이 계정을 제재했을 때 "전부 사람이 승인한, 공식 경로 사용"임을 입증
//   ② 공정위 이슈 시 고지문 삽입 이력 입증
//
// 규칙: append-only. 토큰·개인정보는 기록하지 않는다. 기록 실패가 본 작업을 막지 않는다.

import { createHash } from "node:crypto";
import { db } from "./db";
import type { Actor } from "@prisma/client";

interface AuditEntry {
  actor: Actor;
  action: string;
  channel?: string;
  approvalRef?: string;
  /** 무엇을 승인했는지의 스냅샷. 해시는 자동 계산된다. */
  payloadSnapshot?: string;
  responseCode?: number;
  responseId?: string;
  detail?: string;
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actor: entry.actor,
        action: entry.action,
        channel: entry.channel,
        approvalRef: entry.approvalRef,
        payloadSnapshot: entry.payloadSnapshot,
        payloadHash: entry.payloadSnapshot
          ? createHash("sha256").update(entry.payloadSnapshot).digest("hex")
          : undefined,
        responseCode: entry.responseCode,
        responseId: entry.responseId,
        detail: entry.detail,
      },
    });
  } catch (err) {
    // 감사 기록 실패가 승인·발행을 막지는 않는다. 다만 조용히 삼키면 증적이 비는 줄도 모르게 되므로
    // 콘솔에는 반드시 남긴다.
    console.error("[audit] 기록 실패:", entry.action, err);
  }
}
