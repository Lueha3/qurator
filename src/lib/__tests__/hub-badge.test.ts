import { describe, expect, it } from "vitest";
import { hubBadge, COUPON_URGENT_DAYS } from "../hub-badge";
import type { SnapshotLike } from "../price-analysis";

// 배지는 팔로워에게 나가는 말이다. "최저가"라고 적어놓고 사실이 아니면 신뢰가 깎인다 —
// 그래서 이 테스트는 "언제 배지를 달지 않는가"를 주로 본다.

const DAY = 86_400_000;
const NOW = new Date("2026-09-15T12:00:00+09:00");

function snap(daysAgo: number, salePrice: number | null, source: SnapshotLike["source"] = "SCREENSHOT"): SnapshotLike {
  return {
    capturedAt: new Date(NOW.getTime() - daysAgo * DAY),
    listPrice: 89000,
    salePrice,
    couponPrice: null,
    source,
    eventTag: null,
  };
}

const badge = (snapshots: SnapshotLike[], couponExpiresAt: Date | null = null) =>
  hubBadge({ snapshots, couponExpiresAt, now: NOW });

describe("허브 배지", () => {
  it("기록이 1건뿐이면 아무 배지도 달지 않는다", () => {
    expect(badge([snap(0, 50000)])).toBeNull();
  });

  it("지난번보다 내렸으면 '가격 인하'", () => {
    expect(badge([snap(3, 55000), snap(0, 50000)])).toEqual({ kind: "drop", label: "가격 인하" });
  });

  it("올랐거나 같으면 배지가 없다 — 없는 소식을 지어내지 않는다", () => {
    expect(badge([snap(3, 45000), snap(0, 50000)])).toBeNull();
    expect(badge([snap(3, 50000), snap(0, 50000)])).toBeNull();
  });

  it("표본 3건 이상에서 모든 기록보다 낮으면 '최저가'", () => {
    expect(badge([snap(9, 55000), snap(5, 52000), snap(0, 50000)])).toEqual({
      kind: "lowest",
      label: "최저가",
    });
  });

  it("표본이 2건이면 최저가라고 말하지 않는다 — 그냥 가격 인하다", () => {
    expect(badge([snap(3, 55000), snap(0, 50000)])).toEqual({ kind: "drop", label: "가격 인하" });
  });

  it("과거에 더 싼 적이 있으면 최저가가 아니다", () => {
    expect(badge([snap(9, 45000), snap(5, 60000), snap(0, 50000)])).toEqual({
      kind: "drop",
      label: "가격 인하",
    });
  });

  it("수동 입력(작년 행사가)은 최저가 판정의 표본이 아니다", () => {
    // 작년 BF 39,900이 있어도 "지금이 최저가"는 자동 기록 3건 기준으로 판단한다
    const snapshots = [snap(300, 39900, "MANUAL"), snap(9, 55000), snap(5, 52000), snap(0, 50000)];
    expect(badge(snapshots)).toEqual({ kind: "lowest", label: "최저가" });
  });

  it("쿠폰 마감이 가장 우선한다 — 오늘 지나면 못 받는 혜택이다", () => {
    const soon = new Date(NOW.getTime() + 2 * DAY);
    expect(badge([snap(9, 55000), snap(5, 52000), snap(0, 50000)], soon)).toEqual({
      kind: "coupon",
      label: "D-2 마감",
    });
  });

  it("오늘 자정에 끝나면 'D-0'이 아니라 '오늘 마감'", () => {
    const tonight = new Date("2026-09-15T23:59:00+09:00");
    expect(badge([snap(0, 50000)], tonight)).toEqual({ kind: "coupon", label: "오늘 마감" });
  });

  it("먼 훗날 쿠폰은 급한 소식이 아니라 배지를 내주지 않는다", () => {
    const far = new Date(NOW.getTime() + (COUPON_URGENT_DAYS + 3) * DAY);
    expect(badge([snap(3, 55000), snap(0, 50000)], far)).toEqual({ kind: "drop", label: "가격 인하" });
  });

  it("이미 지난 쿠폰은 배지가 되지 않는다", () => {
    const past = new Date(NOW.getTime() - DAY);
    expect(badge([snap(0, 50000)], past)).toBeNull();
  });

  it("가격을 못 읽은 기록은 세지 않는다", () => {
    expect(badge([snap(9, null), snap(5, null), snap(3, 55000), snap(0, 50000)])).toEqual({
      kind: "drop",
      label: "가격 인하",
    });
  });
});
