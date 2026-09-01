// 가격 스냅샷 — docs/05-price-watch.md §4.3·§4.4.
//
// 원칙:
//   1. **기록은 공짜여야 한다.** USER_URL·HEALTH_CHECK 경로는 이미 내려받은 페이지의
//      파싱 결과를 저장할 뿐, 어떤 추가 아웃바운드 요청도 만들지 않는다.
//   2. **기록 실패가 본 흐름을 막지 않는다.** 스냅샷은 부가 기능이다 — 링크 캡처나
//      헬스체크가 스냅샷 오류로 죽으면 주객전도다. 이 모듈의 기록 함수는 절대 throw하지 않는다.
//   3. **가격이 하나도 없는 스냅샷은 기록하지 않는다.** 파싱 실패를 이력으로 남기면
//      기준가(중앙값) 계산이 오염되고, "이날 가격이 없었다"는 거짓 신호가 된다.

import { db } from "./db";
import type { ParsedProduct } from "./product-parser";
import type { SnapshotSource } from "@prisma/client";

/**
 * 이벤트 창 — policy 테이블의 세 키로 정의한다 (docs/05 §4.6, 수치는 [02 §13] 원칙대로 DB가 정본):
 *   watch.event.tag   예: "BF2026"
 *   watch.event.start ISO 문자열
 *   watch.event.end   ISO 문자열
 * 셋 다 있고 now가 창 안이면 그 태그를 반환한다. 무진장 BF 공지가 뜨면 사람이 이 값을 넣는다.
 */
export async function activeEventTag(now: Date = new Date()): Promise<string | null> {
  const rows = await db.policy.findMany({
    where: { key: { in: ["watch.event.tag", "watch.event.start", "watch.event.end"] } },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const tag = byKey.get("watch.event.tag");
  const start = byKey.get("watch.event.start");
  const end = byKey.get("watch.event.end");
  if (!tag || !start || !end) return null;

  const startAt = new Date(start);
  const endAt = new Date(end);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) return null;
  return startAt <= now && now <= endAt ? tag : null;
}

export interface SnapshotInput {
  productId: string;
  listPrice?: number | null;
  salePrice?: number | null;
  couponPrice?: number | null;
  source: SnapshotSource;
  /** 미지정이면 이벤트 창(policy)으로 자동 판정. MANUAL 경로는 항상 명시한다. */
  eventTag?: string | null;
  note?: string | null;
  capturedAt?: Date;
}

/**
 * 스냅샷 1건을 기록한다. 절대 throw하지 않는다.
 * 반환값의 recorded=false는 "가격이 없어 건너뜀" 또는 "기록 실패"다 — 호출부는 무시해도 되고,
 * 사람에게 보여줄 이유가 있는 경로(MANUAL)만 결과를 확인한다.
 */
export async function recordSnapshot(
  input: SnapshotInput
): Promise<{ recorded: boolean; id?: string }> {
  const listPrice = input.listPrice ?? null;
  const salePrice = input.salePrice ?? null;
  const couponPrice = input.couponPrice ?? null;
  if (listPrice === null && salePrice === null && couponPrice === null) {
    return { recorded: false };
  }

  try {
    const capturedAt = input.capturedAt ?? new Date();
    const eventTag =
      input.eventTag !== undefined ? input.eventTag : await activeEventTag(capturedAt);

    const row = await db.priceSnapshot.create({
      data: {
        productId: input.productId,
        capturedAt,
        listPrice,
        salePrice,
        couponPrice,
        source: input.source,
        eventTag,
        note: input.note ?? null,
      },
    });
    return { recorded: true, id: row.id };
  } catch (err) {
    // 스냅샷 실패는 본 흐름(캡처·헬스체크)을 절대 멈추지 않는다.
    console.error("[price-snapshot] 기록 실패", input.productId, err);
    return { recorded: false };
  }
}

/**
 * 파싱 결과에서 스냅샷을 기록한다 — USER_URL·HEALTH_CHECK 피기백 공용.
 * 가격 필드가 하나도 안 뽑혔으면(파싱 실패·차단 페이지) 조용히 건너뛴다.
 */
export async function recordParsedSnapshot(
  productId: string,
  parsed: ParsedProduct,
  source: SnapshotSource
): Promise<{ recorded: boolean }> {
  return recordSnapshot({
    productId,
    listPrice: parsed.listPrice,
    salePrice: parsed.salePrice,
    source,
  });
}
