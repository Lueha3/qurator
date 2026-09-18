import { afterEach, beforeEach, describe, expect, it } from "vitest";

// 아침 알림 — docs/08 §4.0.5 (V2-G).
//
// 이 모듈에서 값어치가 있는 건 "보내는 것"이 아니라 **"보내지 않는 경우"**다:
// 할 일이 없는 날, 이미 보낸 날, 형식이 이상한 구독. 매일 오는 "할 일 없음"과
// 하루 두 통은 둘 다 알림 전체를 무시하게 만든다.

const { db } = await import("../db");
const {
  alreadySentToday,
  collectDigest,
  deviceLabel,
  digestMessage,
  kstStartOfDay,
  pushKeys,
  removeSubscription,
  runDigest,
  saveSubscription,
  validateSubscription,
  DIGEST_ACTION,
} = await import("../push");

const ENDPOINT = "https://web.push.apple.com/abc123";
const VALID = { endpoint: ENDPOINT, keys: { p256dh: "BPa1_key-material", auth: "c2VjcmV0" } };

const originalPublic = process.env.VAPID_PUBLIC_KEY;
const originalPrivate = process.env.VAPID_PRIVATE_KEY;

// collectDigest는 홈 화면과 같은 숫자를 센다 — 즉 딜·워치·정책을 전부 읽는다.
// 다른 스위트가 남긴 딜이 있으면 "할 일이 없는 날"을 만들 수 없으므로 비우고 시작한다
// (watch-remind.test.ts와 같은 방식. vitest는 fileParallelism: false라 안전하다).
async function resetDb() {
  await db.clickEvent.deleteMany();
  await db.shortLink.deleteMany();
  await db.post.deleteMany();
  await db.contentCard.deleteMany();
  await db.curatorLink.deleteMany();
  await db.deal.deleteMany();
  await db.productVariant.deleteMany();
  await db.priceSnapshot.deleteMany();
  await db.watchItem.deleteMany();
  await db.product.deleteMany();
  await db.creator.deleteMany();
  await db.policy.deleteMany();
  await db.auditLog.deleteMany();
  await db.pushSubscription.deleteMany();
}

beforeEach(async () => {
  await resetDb();
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

afterEach(() => {
  if (originalPublic === undefined) delete process.env.VAPID_PUBLIC_KEY;
  else process.env.VAPID_PUBLIC_KEY = originalPublic;
  if (originalPrivate === undefined) delete process.env.VAPID_PRIVATE_KEY;
  else process.env.VAPID_PRIVATE_KEY = originalPrivate;
});

describe("구독 정보 검증", () => {
  it("정상 구독을 받는다", () => {
    expect(validateSubscription(VALID)).toEqual(VALID);
  });

  it("https가 아닌 endpoint는 거부한다 — 우리 서버가 아무 데나 요청하게 둘 수 없다", () => {
    for (const endpoint of [
      "http://web.push.apple.com/abc",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://",
      "not a url",
    ]) {
      expect(validateSubscription({ ...VALID, endpoint })).toBeNull();
    }
  });

  it("내부 주소를 가리키는 endpoint는 거부한다 — 우리 서버가 내부망을 두드리는 발판이 될 수 없다", () => {
    for (const endpoint of [
      "https://localhost:3000/push",
      "https://127.0.0.1/push",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/push",
      "https://[::1]/push",
      "https://internal-service/push", // 점 없는 단일 라벨 호스트
    ]) {
      expect(validateSubscription({ ...VALID, endpoint })).toBeNull();
    }
  });

  it("진짜 푸시 서비스 주소는 통과한다", () => {
    for (const endpoint of [
      "https://web.push.apple.com/abc",
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
    ]) {
      expect(validateSubscription({ ...VALID, endpoint })?.endpoint).toBe(endpoint);
    }
  });

  it("키가 비었거나 base64url이 아니면 거부한다", () => {
    expect(validateSubscription({ ...VALID, keys: { p256dh: "", auth: "c2VjcmV0" } })).toBeNull();
    expect(validateSubscription({ ...VALID, keys: { p256dh: "BP@!", auth: "c2VjcmV0" } })).toBeNull();
    expect(validateSubscription({ endpoint: ENDPOINT })).toBeNull();
    expect(validateSubscription(null)).toBeNull();
    expect(validateSubscription("구독해주세요")).toBeNull();
  });

  it("지나치게 긴 값은 거부한다", () => {
    expect(validateSubscription({ ...VALID, endpoint: `https://x.com/${"a".repeat(1000)}` })).toBeNull();
    expect(
      validateSubscription({ ...VALID, keys: { p256dh: "a".repeat(201), auth: "c2VjcmV0" } })
    ).toBeNull();
  });
});

describe("구독 저장", () => {
  it("같은 기기가 다시 켜도 행이 늘지 않는다", async () => {
    expect(await saveSubscription(VALID, "iPhone")).toBe(true);
    expect(await saveSubscription({ ...VALID, keys: { ...VALID.keys, auth: "bmV3" } }, "iPhone")).toBe(
      true
    );

    const rows = await db.pushSubscription.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].auth).toBe("bmV3"); // 키는 갱신된다
    expect(rows[0].label).toBe("아이폰");
  });

  it("형식이 틀린 구독은 저장하지 않는다", async () => {
    expect(await saveSubscription({ endpoint: "http://x" }, "iPhone")).toBe(false);
    expect(await db.pushSubscription.count()).toBe(0);
  });

  it("끄면 지운다", async () => {
    await saveSubscription(VALID, "iPhone");
    expect(await removeSubscription(ENDPOINT)).toBe(true);
    expect(await db.pushSubscription.count()).toBe(0);
    expect(await removeSubscription(ENDPOINT)).toBe(false); // 두 번 눌러도 조용히
  });

  it("UA로 기기 이름을 붙인다", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("아이폰");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14)")).toBe("안드로이드");
    expect(deviceLabel(null)).toBe("기기");
  });
});

describe("알림 문구", () => {
  it("할 일이 없으면 아무것도 만들지 않는다", () => {
    expect(digestMessage({ reminders: 0, corrections: 0, ready: 0 })).toBeNull();
  });

  it("있는 숫자만 나열한다", () => {
    expect(digestMessage({ reminders: 3, corrections: 0, ready: 2 })?.body).toBe(
      "다시 찍어 올릴 상품 3개 · 문구 확정할 딜 2건"
    );
    expect(digestMessage({ reminders: 0, corrections: 1, ready: 0 })?.body).toBe("품절 안내 1건");
  });

  it("상품명·가격·링크를 싣지 않는다 — 잠금화면은 옆 사람도 본다", () => {
    const payload = digestMessage({ reminders: 2, corrections: 1, ready: 1 });
    expect(payload?.body).toBe("다시 찍어 올릴 상품 2개 · 품절 안내 1건 · 문구 확정할 딜 1건");
    expect(payload?.url).toBe("/"); // 딥링크도 홈 하나뿐이다
    expect(JSON.stringify(payload)).not.toMatch(/musinsa|http/i);
  });

  it("며칠치가 쌓이지 않게 같은 태그를 쓴다", () => {
    expect(digestMessage({ reminders: 1, corrections: 0, ready: 0 })?.tag).toBe("qurator-digest");
  });
});

describe("하루 한 통", () => {
  it("KST 자정을 기준으로 오늘을 센다", () => {
    // 2026-09-16 00:30 KST = 2026-09-15 15:30 UTC → 오늘의 시작은 15일 15:00 UTC
    const start = kstStartOfDay(new Date("2026-09-15T15:30:00Z"));
    expect(start.toISOString()).toBe("2026-09-15T15:00:00.000Z");
  });

  it("오늘 이미 보냈으면 알아본다", async () => {
    const now = new Date("2026-09-16T02:00:00Z"); // 11:00 KST
    expect(await alreadySentToday(now)).toBe(false);

    await db.auditLog.create({
      data: { actor: "SYSTEM", action: DIGEST_ACTION, ts: new Date("2026-09-16T00:10:00Z") },
    });
    expect(await alreadySentToday(now)).toBe(true);

    // 어제 것은 오늘이 아니다
    await db.auditLog.deleteMany();
    await db.auditLog.create({
      data: { actor: "SYSTEM", action: DIGEST_ACTION, ts: new Date("2026-09-14T23:00:00Z") },
    });
    expect(await alreadySentToday(now)).toBe(false);
  });
});

describe("전송 판단", () => {
  it("키가 없으면 조용히 꺼진다 — 500을 내지 않는다", async () => {
    expect(pushKeys()).toBeNull();
    const run = await runDigest(new Date());
    expect(run.status).toBe("not-configured");
    expect(await db.auditLog.count({ where: { action: DIGEST_ACTION } })).toBe(0);
  });

  it("할 일이 없는 날은 보내지 않는다", async () => {
    process.env.VAPID_PUBLIC_KEY = "pub";
    process.env.VAPID_PRIVATE_KEY = "priv";
    await saveSubscription(VALID, "iPhone");

    const counts = await collectDigest(new Date());
    expect(counts.reminders + counts.corrections + counts.ready).toBe(0);

    const run = await runDigest(new Date());
    expect(run.status).toBe("nothing-to-do");
    expect(await db.auditLog.count({ where: { action: DIGEST_ACTION } })).toBe(0);
  });

  it("구독한 기기가 없으면 보낼 곳이 없다", async () => {
    process.env.VAPID_PUBLIC_KEY = "pub";
    process.env.VAPID_PRIVATE_KEY = "priv";
    const run = await runDigest(new Date());
    // 할 일이 없는 DB라 문구 판단이 먼저 걸린다 — 둘 다 "보내지 않는다"로 끝난다
    expect(["nothing-to-do", "no-subscription"]).toContain(run.status);
    expect(run.result).toBeUndefined();
  });

  it("이미 보낸 날은 두 번 보내지 않는다 (크론이 두 번 울려도)", async () => {
    process.env.VAPID_PUBLIC_KEY = "pub";
    process.env.VAPID_PRIVATE_KEY = "priv";
    const now = new Date();
    await db.auditLog.create({ data: { actor: "SYSTEM", action: DIGEST_ACTION, ts: now } });

    expect((await runDigest(now)).status).toBe("already-sent");
  });
});
