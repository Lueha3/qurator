import { describe, expect, it } from "vitest";
import {
  analyzeSnapshots,
  buildPriceChangeNote,
  computeBaseline,
  discountRate,
  median,
  summarizeEvents,
  type SnapshotLike,
} from "../price-analysis";
import type { SnapshotSource } from "@prisma/client";

const DAY = 86_400_000;
const BF_START = new Date("2026-11-16T19:00:00+09:00");

/** 기준가 창(행사 직전 45일) 안의 시각 */
function beforeEvent(days: number): Date {
  return new Date(BF_START.getTime() - days * DAY);
}

function snap(
  capturedAt: Date,
  salePrice: number | null,
  extra: Partial<SnapshotLike> = {}
): SnapshotLike {
  return {
    capturedAt,
    salePrice,
    listPrice: extra.listPrice ?? null,
    couponPrice: extra.couponPrice ?? null,
    discountRateShown: extra.discountRateShown ?? null,
    source: (extra.source ?? "HEALTH_CHECK") as SnapshotSource,
    eventTag: extra.eventTag ?? null,
  };
}

describe("median", () => {
  it("홀수 개는 가운데 값", () => {
    expect(median([30, 10, 20])).toBe(20);
  });

  it("짝수 개는 가운데 둘의 평균(원 단위 반올림)", () => {
    expect(median([10, 20, 30, 41])).toBe(25);
  });

  it("표본이 없으면 null", () => {
    expect(median([])).toBeNull();
  });
});

describe("discountRate", () => {
  it("정상 할인율을 % 정수로", () => {
    expect(discountRate(89000, 39900)).toBe(55);
  });

  it("기준가가 없거나 0 이하면 계산하지 않는다", () => {
    expect(discountRate(null, 1000)).toBeNull();
    expect(discountRate(0, 1000)).toBeNull();
    expect(discountRate(-1, 1000)).toBeNull();
  });

  it("가격이 올랐으면 음수를 그대로 돌려준다 (사실을 숨기지 않는다)", () => {
    expect(discountRate(50000, 60000)).toBe(-20);
  });
});

describe("computeBaseline — 행사 직전 창의 중앙값", () => {
  it("창 안 표본만 쓰고, 3건 이상이면 sufficient", () => {
    const snapshots = [
      snap(beforeEvent(60), 99000), // 창 밖 (45일 초과) — 제외
      snap(beforeEvent(30), 50000),
      snap(beforeEvent(20), 52000),
      snap(beforeEvent(10), 51000),
      snap(new Date(BF_START.getTime() + DAY), 39900), // 행사 중 — 창 밖(windowEnd 이후)
    ];
    const baseline = computeBaseline(snapshots, BF_START);
    expect(baseline.sampleSize).toBe(3);
    expect(baseline.price).toBe(51000);
    expect(baseline.sufficient).toBe(true);
  });

  it("표본 3건 미만이면 sufficient=false (실할인율 표시 금지 신호)", () => {
    const baseline = computeBaseline(
      [snap(beforeEvent(10), 50000), snap(beforeEvent(5), 52000)],
      BF_START
    );
    expect(baseline.sampleSize).toBe(2);
    expect(baseline.sufficient).toBe(false);
  });

  it("수동 입력은 기준가 표본에서 제외한다", () => {
    const snapshots = [
      snap(beforeEvent(30), 50000),
      snap(beforeEvent(20), 52000),
      snap(beforeEvent(10), 10000, { source: "MANUAL" }), // 기억에 의존한 값 — 중앙값을 흔들면 안 된다
    ];
    const baseline = computeBaseline(snapshots, BF_START);
    expect(baseline.sampleSize).toBe(2);
    expect(baseline.sufficient).toBe(false);
  });
});

describe("summarizeEvents — 위장 인상을 거른다", () => {
  it("정가를 올려도 실할인율은 진실을 말한다", () => {
    // 시나리오: 평상시 50,000원에 팔던 상품. 행사 직전 정가를 100,000원으로 올리고
    // 행사가 45,000원 = "정가 대비 55% 할인"이라고 광고. 실제 인하율은 10%다.
    const snapshots = [
      snap(beforeEvent(40), 50000, { listPrice: 60000 }),
      snap(beforeEvent(30), 50000, { listPrice: 60000 }),
      snap(beforeEvent(20), 50000, { listPrice: 60000 }),
      snap(new Date(BF_START.getTime() + DAY), 45000, {
        listPrice: 100000,
        eventTag: "BF2026",
      }),
    ];

    const [event] = summarizeEvents(snapshots);
    expect(event.eventTag).toBe("BF2026");
    expect(event.realDiscountRate).toBe(10); // 기준가 50,000 대비
    expect(event.listDiscountRate).toBe(55); // 정가 100,000 대비 — 참고값일 뿐
  });

  it("기준가 표본이 부족하면 실할인율을 계산하지 않는다", () => {
    const snapshots = [
      snap(beforeEvent(20), 50000),
      snap(new Date(BF_START.getTime() + DAY), 45000, { listPrice: 90000, eventTag: "BF2026" }),
    ];
    const [event] = summarizeEvents(snapshots);
    expect(event.realDiscountRate).toBeNull();
    expect(event.baseline.sampleSize).toBe(1);
    // 정가 대비 값은 남는다 — 아무것도 못 보여주는 것보다 낫고, UI가 출처를 함께 표기한다
    expect(event.listDiscountRate).toBe(50);
  });

  it("행사 기간 중 최저가를 그 행사의 대표가로 삼는다", () => {
    const snapshots = [
      snap(new Date(BF_START.getTime() + DAY), 45000, { eventTag: "BF2026" }),
      snap(new Date(BF_START.getTime() + 2 * DAY), 39900, { eventTag: "BF2026" }),
      snap(new Date(BF_START.getTime() + 3 * DAY), 42000, { eventTag: "BF2026" }),
    ];
    const [event] = summarizeEvents(snapshots);
    expect(event.salePrice).toBe(39900);
    expect(event.snapshotCount).toBe(3);
  });

  it("전부 수동 입력인 행사는 manualOnly로 표시된다", () => {
    const snapshots = [
      snap(new Date("2025-11-21T12:00:00+09:00"), 39900, {
        source: "MANUAL",
        eventTag: "BF2025",
        listPrice: 89000,
      }),
    ];
    const [event] = summarizeEvents(snapshots);
    expect(event.manualOnly).toBe(true);
    expect(event.listDiscountRate).toBe(55);
    expect(event.realDiscountRate).toBeNull(); // 그 이전 이력이 없으므로 기준가가 없다
  });

  it("행사를 시간순으로 정렬한다 (작년 → 올해)", () => {
    const snapshots = [
      snap(new Date(BF_START.getTime() + DAY), 45000, { eventTag: "BF2026" }),
      snap(new Date("2025-11-21T12:00:00+09:00"), 39900, {
        source: "MANUAL",
        eventTag: "BF2025",
      }),
    ];
    expect(summarizeEvents(snapshots).map((e) => e.eventTag)).toEqual(["BF2025", "BF2026"]);
  });

  it("판매가가 없는 태그는 비교 대상이 아니다", () => {
    expect(summarizeEvents([snap(BF_START, null, { eventTag: "BF2026" })])).toEqual([]);
  });
});

describe("analyzeSnapshots — 현재가", () => {
  const now = new Date("2026-09-01T12:00:00+09:00");

  it("가장 최근 자동 스냅샷을 현재가로 쓴다", () => {
    const analysis = analyzeSnapshots(
      [
        snap(new Date("2026-08-30T00:00:00+09:00"), 55000),
        snap(new Date("2026-08-31T00:00:00+09:00"), 53400),
      ],
      now
    );
    expect(analysis.current?.salePrice).toBe(53400);
    expect(analysis.snapshotCount).toBe(2);
  });

  it("수동 입력(과거 행사가)은 현재가가 될 수 없다", () => {
    // /bf2025는 capturedAt을 2025년으로 찍지만, 설령 최신 시각으로 들어와도 현재가가 되면 안 된다.
    const analysis = analyzeSnapshots(
      [
        snap(new Date("2026-08-31T00:00:00+09:00"), 53400),
        snap(new Date("2026-09-01T00:00:00+09:00"), 39900, {
          source: "MANUAL",
          eventTag: "BF2025",
        }),
      ],
      now
    );
    expect(analysis.current?.salePrice).toBe(53400);
  });

  it("스냅샷이 없으면 current는 null", () => {
    const analysis = analyzeSnapshots([], now);
    expect(analysis.current).toBeNull();
    expect(analysis.events).toEqual([]);
  });
});

describe("analyzeSnapshots — 첫 기록 (이벤트 태그 없는 일반 기간 비교)", () => {
  const now = new Date("2027-03-01T12:00:00+09:00");

  it("자동 스냅샷이 2건 이상이면 가장 오래된 것을 first로 준다", () => {
    const analysis = analyzeSnapshots(
      [
        snap(new Date("2026-09-01T00:00:00+09:00"), 55000),
        snap(new Date("2027-02-28T00:00:00+09:00"), 39900),
      ],
      now
    );
    expect(analysis.first?.salePrice).toBe(55000);
    expect(analysis.current?.salePrice).toBe(39900);
  });

  it("자동 스냅샷이 1건뿐이면 first는 null이다 (자기 자신과 비교 금지)", () => {
    const analysis = analyzeSnapshots([snap(new Date("2027-02-28T00:00:00+09:00"), 39900)], now);
    expect(analysis.first).toBeNull();
    expect(analysis.current?.salePrice).toBe(39900);
  });

  it("MANUAL 스냅샷은 first 후보에서 제외된다", () => {
    const analysis = analyzeSnapshots(
      [
        snap(new Date("2025-11-21T00:00:00+09:00"), 39900, { source: "MANUAL", eventTag: "BF2025" }),
        snap(new Date("2027-02-28T00:00:00+09:00"), 45000),
      ],
      now
    );
    // 자동 스냅샷이 1건뿐이므로(MANUAL 제외) first는 null
    expect(analysis.first).toBeNull();
  });
});

describe("analyzeSnapshots — previous (바로 직전 기록, 재촬영 비교용)", () => {
  const now = new Date("2026-09-10T12:00:00+09:00");

  it("자동 스냅샷이 2건이면 두 번째로 최신인 것이 previous다", () => {
    const analysis = analyzeSnapshots(
      [
        snap(new Date("2026-09-10T10:00:00+09:00"), 48000),
        snap(new Date("2026-09-10T11:00:00+09:00"), 42900),
      ],
      now
    );
    expect(analysis.current?.salePrice).toBe(42900);
    expect(analysis.previous?.salePrice).toBe(48000);
  });

  it("자동 스냅샷이 1건뿐이면 previous는 null이다", () => {
    const analysis = analyzeSnapshots([snap(new Date("2026-09-10T11:00:00+09:00"), 42900)], now);
    expect(analysis.previous).toBeNull();
  });
});

describe("buildPriceChangeNote — 재촬영 시 '지난번 vs 지금' 한 줄", () => {
  const now = new Date("2026-09-10T12:00:00+09:00");

  it("가격이 내렸으면 하락률과 함께 알린다", () => {
    const analysis = analyzeSnapshots(
      [
        snap(new Date("2026-09-10T10:00:00+09:00"), 48000),
        snap(new Date("2026-09-10T11:00:00+09:00"), 42900),
      ],
      now
    );
    const note = buildPriceChangeNote(analysis);
    expect(note).toContain("48,000원");
    expect(note).toContain("42,900원");
    expect(note).toContain("내렸어요");
    expect(note).toContain("11%"); // (1 - 42900/48000) ≈ 10.6% → 반올림 11%
  });

  it("가격이 올랐으면 상승률과 함께 알린다", () => {
    const analysis = analyzeSnapshots(
      [
        snap(new Date("2026-09-10T10:00:00+09:00"), 42900),
        snap(new Date("2026-09-10T11:00:00+09:00"), 48000),
      ],
      now
    );
    const note = buildPriceChangeNote(analysis);
    expect(note).toContain("올랐어요");
  });

  it("판매가가 같으면 '지난번과 같은 가격'이라고 말한다", () => {
    const analysis = analyzeSnapshots(
      [
        snap(new Date("2026-09-10T10:00:00+09:00"), 42900),
        snap(new Date("2026-09-10T11:00:00+09:00"), 42900),
      ],
      now
    );
    expect(buildPriceChangeNote(analysis)).toContain("같은 가격");
  });

  it("비교할 이전 기록이 없으면(첫 기록) null — 침묵이 아니라 '비교 대상 없음'의 정직한 표현", () => {
    const analysis = analyzeSnapshots([snap(new Date("2026-09-10T11:00:00+09:00"), 42900)], now);
    expect(buildPriceChangeNote(analysis)).toBeNull();
  });

  it("analysis 자체가 없으면(방어적) null", () => {
    expect(buildPriceChangeNote(undefined)).toBeNull();
  });

  it("정가를 둘 다 읽었고 같으면, 할인율 변화를 '전 → 후'로 보여준다", () => {
    const analysis = analyzeSnapshots(
      [
        snap(new Date("2026-09-10T10:00:00+09:00"), 48000, { listPrice: 89000 }),
        snap(new Date("2026-09-10T11:00:00+09:00"), 42900, { listPrice: 89000 }),
      ],
      now
    );
    const note = buildPriceChangeNote(analysis);
    // 40%(=1-48000/89000) → 52%(=1-42900/89000)
    expect(note).toContain("정가 89,000원 대비 할인 46% → 52%");
  });

  it("정가가 이번에만 읽혔으면(직전엔 못 읽음) 전후 비교 없이 지금 값만 보여준다", () => {
    const analysis = analyzeSnapshots(
      [
        snap(new Date("2026-09-10T10:00:00+09:00"), 48000), // listPrice 없음
        snap(new Date("2026-09-10T11:00:00+09:00"), 42900, { listPrice: 89000 }),
      ],
      now
    );
    const note = buildPriceChangeNote(analysis);
    expect(note).toContain("정가 89,000원 대비 할인 52%");
    expect(note).not.toContain("→ 52%"); // 지어낸 "전" 수치가 없어야 한다
  });

  it("정가가 그 사이 달라졌으면(위장 인상 등) 전후 비교를 지어내지 않고 지금 정가 기준만 보여준다", () => {
    const analysis = analyzeSnapshots(
      [
        snap(new Date("2026-09-10T10:00:00+09:00"), 48000, { listPrice: 80000 }),
        snap(new Date("2026-09-10T11:00:00+09:00"), 42900, { listPrice: 89000 }),
      ],
      now
    );
    const note = buildPriceChangeNote(analysis);
    expect(note).toContain("정가 89,000원 대비 할인 52%");
    expect(note).not.toMatch(/할인율 \d+% → /);
  });

  it("쿠폰가가 바뀌지 않았으면 지금 쿠폰가만 할인율과 함께 보여준다", () => {
    const analysis = analyzeSnapshots(
      [
        snap(new Date("2026-09-10T10:00:00+09:00"), 53400, {
          listPrice: 89000,
          couponPrice: 45000,
        }),
        snap(new Date("2026-09-10T11:00:00+09:00"), 42900, {
          listPrice: 89000,
          couponPrice: 45000,
        }),
      ],
      now
    );
    const note = buildPriceChangeNote(analysis);
    expect(note).toContain("쿠폰 쓰면 45,000원 (49% 할인)");
  });

  it("쿠폰가도 바뀌었으면 '지난번 → 지금'으로 비교해서 보여준다", () => {
    const analysis = analyzeSnapshots(
      [
        snap(new Date("2026-09-10T10:00:00+09:00"), 53400, {
          listPrice: 89000,
          couponPrice: 48000,
        }),
        snap(new Date("2026-09-10T11:00:00+09:00"), 42900, {
          listPrice: 89000,
          couponPrice: 38900,
        }),
      ],
      now
    );
    const note = buildPriceChangeNote(analysis);
    expect(note).toContain("쿠폰 쓰면 지난번 48,000원 → 지금 38,900원");
  });

  it("쿠폰가가 이번에 안 보였으면(화면에 없었음) 쿠폰 줄 자체를 내지 않는다", () => {
    const analysis = analyzeSnapshots(
      [
        snap(new Date("2026-09-10T10:00:00+09:00"), 53400, {
          listPrice: 89000,
          couponPrice: 45000,
        }),
        snap(new Date("2026-09-10T11:00:00+09:00"), 42900, { listPrice: 89000 }), // 쿠폰가 없음
      ],
      now
    );
    const note = buildPriceChangeNote(analysis);
    expect(note).not.toContain("쿠폰");
  });
});
