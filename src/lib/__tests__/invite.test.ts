import { beforeEach, afterEach, describe, expect, it } from "vitest";

// 1회용 등록 초대 + 이름표 쿠키 — docs/03 §7.2.
//
// 초대 코드는 **게이트를 여는 열쇠**다(그것만 있으면 패스키를 등록하고 들어올 수 있다).
// 그래서 토큰과 같은 무게로 본다: 추측 불가, 짧은 수명, 두 번 못 씀.

const { db } = await import("../db");
const { consumeInvite, createInvite, inviteIsLive, listLiveInvites, revokeInvite, resolveLabel } =
  await import("../passkey");
const { actorCookieValue, readActorCookie, cleanDeviceName } = await import("../actor");

const original = process.env.APP_ACCESS_TOKEN;

beforeEach(async () => {
  await db.passkeyInvite.deleteMany();
  await db.auditLog.deleteMany();
  process.env.APP_ACCESS_TOKEN = "test-token-0123456789";
});

afterEach(() => {
  if (original === undefined) delete process.env.APP_ACCESS_TOKEN;
  else process.env.APP_ACCESS_TOKEN = original;
});

describe("초대 발급", () => {
  it("추측할 수 없는 코드를 낸다", async () => {
    const a = await createInvite("현표");
    const b = await createInvite("현표");
    expect(a.code).not.toBe(b.code);
    expect(a.code.length).toBeGreaterThanOrEqual(40); // 32바이트 base64url
    expect(a.code).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("30분 뒤 만료된다", async () => {
    const invite = await createInvite(null);
    const minutes = (invite.expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(25);
    expect(minutes).toBeLessThanOrEqual(30);
  });

  it("목록에 코드를 다시 내보내지 않는다 — 목록이 열쇠 보관함이 되면 안 된다", async () => {
    await createInvite("현표");
    const rows = await listLiveInvites();
    expect(Object.keys(rows[0]).sort()).toEqual(["expiresAt", "id", "note", "usedAt"]);
    expect(JSON.stringify(rows)).not.toContain("code");
  });
});

describe("초대 검사", () => {
  it("살아 있는 코드만 통과한다", async () => {
    const invite = await createInvite(null);
    expect(await inviteIsLive(invite.code)).toBe(true);
  });

  it("없는·짧은·엉뚱한 값은 전부 거절한다", async () => {
    for (const code of ["", "짧음", "a".repeat(31), "a".repeat(101), null, undefined, 42, {}]) {
      expect(await inviteIsLive(code)).toBe(false);
    }
  });

  it("만료된 코드는 거절한다", async () => {
    const invite = await createInvite(null);
    await db.passkeyInvite.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await inviteIsLive(invite.code)).toBe(false);
  });

  it("한 번 쓰면 끝이다 — 같은 링크로 두 기기가 등록되지 않는다", async () => {
    const invite = await createInvite(null);
    expect(await consumeInvite(invite.code)).toBe(true);
    expect(await consumeInvite(invite.code)).toBe(false);
    expect(await inviteIsLive(invite.code)).toBe(false);
  });

  it("취소하면 즉시 죽는다", async () => {
    const invite = await createInvite("현표");
    const [row] = await listLiveInvites();
    expect(await revokeInvite(row.id)).toBe(true);
    expect(await inviteIsLive(invite.code)).toBe(false);
  });
});

describe("이름표 쿠키", () => {
  it("심은 이름을 그대로 읽는다", () => {
    const value = actorCookieValue("현표 아이폰")!;
    expect(readActorCookie(value)).toBe("현표 아이폰");
  });

  it("이름을 바꿔치기하면 이름이 없는 것으로 친다 — 틀린 이름보다 낫다", () => {
    const value = actorCookieValue("현표 아이폰")!;
    const [, signature] = value.split(".");
    const forged = `${Buffer.from("관리자", "utf8").toString("base64url")}.${signature}`;
    expect(readActorCookie(forged)).toBeNull();
  });

  it("서명이 없거나 깨졌으면 거절한다", () => {
    expect(readActorCookie("현표아이폰")).toBeNull();
    expect(readActorCookie(`${Buffer.from("현표").toString("base64url")}.가짜서명`)).toBeNull();
    expect(readActorCookie(undefined)).toBeNull();
  });

  it("토큰이 바뀌면 옛 이름표는 통하지 않는다", () => {
    const value = actorCookieValue("현표 아이폰")!;
    process.env.APP_ACCESS_TOKEN = "완전히-다른-토큰-값입니다";
    expect(readActorCookie(value)).toBeNull();
  });

  it("긴 이름은 잘라서 저장한다", () => {
    const long = "아".repeat(50);
    expect(readActorCookie(actorCookieValue(long)!)?.length).toBe(24);
  });
});

describe("기기 이름 정리", () => {
  it("사람이 지은 이름이 있으면 그것을, 없으면 UA 추정값을 쓴다", () => {
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)";
    expect(resolveLabel("현표 아이폰", ua)).toBe("현표 아이폰");
    expect(resolveLabel("   ", ua)).toBe("아이폰");
    expect(resolveLabel(undefined, ua)).toBe("아이폰");
    expect(resolveLabel(123, null)).toBe("기기");
  });

  it("공백을 정리하고 길이를 제한한다", () => {
    expect(cleanDeviceName("  현표   아이폰  ")).toBe("현표 아이폰");
    expect(cleanDeviceName("아".repeat(100))?.length).toBe(24);
    expect(cleanDeviceName("")).toBeNull();
  });
});
