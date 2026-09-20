import { beforeEach, afterEach, describe, expect, it } from "vitest";

// Face ID 로그인 — docs/03 §5.5.
//
// 서명 검증 자체는 @simplewebauthn이 한다. 여기서 볼 값어치가 있는 것은 **그 주변**이다:
// 챌린지를 한 번만 쓰는가, 모르는 자격증명을 거절하는가, 어느 도메인의 패스키인가.
// 재전송 한 번이면 남이 이 앱의 주인이 되므로 "열리지 않아야 하는 경우"를 먼저 본다.

const { db } = await import("../db");
const {
  authenticationOptions,
  deviceLabel,
  listPasskeys,
  registrationOptions,
  relyingParty,
  verifyAuthentication,
  verifyRegistration,
} = await import("../passkey");

const original = process.env.PUBLIC_BASE_URL;

beforeEach(async () => {
  await db.passkey.deleteMany();
  await db.authChallenge.deleteMany();
  await db.auditLog.deleteMany();
  process.env.PUBLIC_BASE_URL = "https://qurator.example.com";
});

afterEach(() => {
  if (original === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = original;
});

/** 인증기가 보낼 법한 최소 형태. 서명은 가짜라 검증에서 떨어지는 것이 정상이다. */
function responseWithChallenge(challenge: string, credentialId = "cred-abc") {
  const clientData = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge, origin: "https://qurator.example.com" })
  ).toString("base64url");
  return {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    clientExtensionResults: {},
    response: { clientDataJSON: clientData, authenticatorData: "", signature: "" },
  };
}

describe("어느 도메인의 패스키인가", () => {
  it("PUBLIC_BASE_URL 하나에서 끌어온다 — 요청 헤더를 믿지 않는다", () => {
    expect(relyingParty()).toEqual({
      rpID: "qurator.example.com",
      origin: "https://qurator.example.com",
    });
  });

  it("설정이 없거나 깨졌으면 기능을 끈다(추측하지 않는다)", () => {
    delete process.env.PUBLIC_BASE_URL;
    expect(relyingParty()).toBeNull();
    process.env.PUBLIC_BASE_URL = "그냥 문자열";
    expect(relyingParty()).toBeNull();
  });
});

describe("등록", () => {
  it("사용자 확인(Face ID)을 요구하고 기기에 저장시킨다", async () => {
    const options = await registrationOptions();
    expect(options?.authenticatorSelection?.userVerification).toBe("required");
    expect(options?.authenticatorSelection?.residentKey).toBe("required");
    expect(options?.challenge).toBeTruthy();
  });

  it("이미 등록된 기기에 또 등록하라고 하지 않는다", async () => {
    await db.passkey.create({
      data: { credentialId: "already-here", publicKey: "x", label: "아이폰" },
    });
    const options = await registrationOptions();
    expect(options?.excludeCredentials?.map((c) => c.id)).toContain("already-here");
  });

  // iCloud는 같은 애플 계정의 기기끼리 패스키를 동기화한다. 초대 등록에서 이미 등록된 것을
  // 제외하면 "이미 등록됨"으로 막히고, 로그인까지 안 되는 사람은 들어올 길이 없어진다.
  it("초대 등록은 이미 등록된 기기여도 막지 않는다", async () => {
    await db.passkey.create({
      data: { credentialId: "already-here", publicKey: "x", label: "아이폰" },
    });
    const options = await registrationOptions({ excludeExisting: false });
    expect(options?.excludeCredentials ?? []).toHaveLength(0);
  });

  it("서버가 낸 적 없는 챌린지는 거절한다", async () => {
    const result = await verifyRegistration(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      responseWithChallenge("내가-지어낸-챌린지") as any,
      "아이폰"
    );
    expect(result).toEqual({ ok: false, reason: "challenge" });
    expect(await db.passkey.count()).toBe(0);
  });

  it("챌린지는 한 번만 쓸 수 있다 — 같은 응답을 다시 보내면 막힌다(재전송 방어)", async () => {
    const options = await registrationOptions();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = responseWithChallenge(options!.challenge) as any;

    // 서명이 가짜라 검증에서 떨어진다 — 하지만 챌린지는 이미 소비됐어야 한다
    expect((await verifyRegistration(response, "아이폰")).reason).toBe("verify");
    expect(await db.authChallenge.count()).toBe(0);

    // 두 번째는 서명까지 가지 못하고 챌린지에서 막힌다
    expect((await verifyRegistration(response, "아이폰")).reason).toBe("challenge");
  });

  it("설정이 없으면 등록 자체를 만들지 않는다", async () => {
    delete process.env.PUBLIC_BASE_URL;
    expect(await registrationOptions()).toBeNull();
  });
});

describe("로그인", () => {
  it("등록된 패스키가 없으면 로그인 창을 띄우지 않는다", async () => {
    expect(await authenticationOptions()).toBeNull();
  });

  it("어떤 자격증명이 있는지 알려주지 않는다 (allowCredentials를 비운다)", async () => {
    await db.passkey.create({ data: { credentialId: "cred-abc", publicKey: "x" } });
    const options = await authenticationOptions();
    expect(options?.allowCredentials ?? []).toHaveLength(0);
    expect(options?.userVerification).toBe("required");
  });

  it("모르는 자격증명은 거절한다", async () => {
    await db.passkey.create({ data: { credentialId: "cred-abc", publicKey: "x" } });
    const options = await authenticationOptions();
    const result = await verifyAuthentication(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      responseWithChallenge(options!.challenge, "남의-자격증명") as any
    );
    expect(result).toEqual({ ok: false, reason: "unknown-credential" });
  });

  it("서명이 맞지 않으면 세션을 주지 않는다", async () => {
    await db.passkey.create({ data: { credentialId: "cred-abc", publicKey: "x" } });
    const options = await authenticationOptions();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await verifyAuthentication(responseWithChallenge(options!.challenge) as any);
    expect(result.ok).toBe(false);
    expect(await db.auditLog.count({ where: { action: "passkey.login" } })).toBe(0);
  });

  it("만료된 챌린지는 거절한다", async () => {
    await db.passkey.create({ data: { credentialId: "cred-abc", publicKey: "x" } });
    const options = await authenticationOptions();
    await db.authChallenge.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await verifyAuthentication(responseWithChallenge(options!.challenge) as any);
    expect(result).toEqual({ ok: false, reason: "challenge" });
  });
});

describe("기기 목록", () => {
  it("공개키·자격증명 ID를 화면으로 내보내지 않는다", async () => {
    await db.passkey.create({
      data: { credentialId: "cred-abc", publicKey: "비밀은-아니지만-불필요", label: "아이폰" },
    });
    const rows = await listPasskeys();
    expect(Object.keys(rows[0]).sort()).toEqual(["createdAt", "id", "label", "lastUsedAt"]);
  });

  it("UA로 기기 이름을 붙인다", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("아이폰");
    expect(deviceLabel(null)).toBe("기기");
  });
});
