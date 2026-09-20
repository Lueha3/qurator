// Face ID 로그인(패스키) — docs/03 §7.1.
//
// `?k=<토큰>`은 "알고 있으면 누구나"인 비밀번호다. 주소창·리퍼러·스크린샷·어깨너머로
// 샐 경로가 계속 있고, 한 번 새면 그 값을 아는 모든 사람이 커미션 링크를 본다.
// 패스키는 개인키가 **기기 보안 요소를 떠나지 않으므로 훔쳐갈 문자열 자체가 없다**.
//
// 토큰 경로를 없애지는 않는다. 패스키를 처음 등록하려면 이미 로그인돼 있어야 하고
// (아니면 아무나 자기 얼굴을 등록해 주인이 된다), 폰을 잃었을 때 돌아올 길도 있어야 한다.
// 즉 `?k=`는 **부트스트랩과 비상구**로 남고, 평소 문은 패스키다.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { randomBytes } from "node:crypto";
import { db } from "./db";
import { audit } from "./audit";
import { cleanDeviceName } from "./actor";

/** 챌린지 수명. 사람이 Face ID를 보는 시간은 몇 초라, 길게 둘 이유가 없다. */
const CHALLENGE_TTL_MS = 3 * 60 * 1000;

/** 이 앱에는 사용자가 한 명뿐이다. WebAuthn이 요구하는 사용자 식별자를 고정값으로 둔다. */
const USER_ID = "qurator-owner";
const USER_NAME = "qurator";

export interface RelyingParty {
  /** 패스키가 묶이는 도메인. 이게 틀리면 브라우저가 패스키를 아예 안 보여준다 */
  rpID: string;
  /** 서명 검증 때 대조할 출처 */
  origin: string;
}

/**
 * 어느 도메인의 패스키인가. `PUBLIC_BASE_URL` 하나에서 끌어온다 —
 * 요청 헤더(Host)에서 뽑으면 공격자가 헤더를 바꿔 다른 도메인의 패스키를 받아낼 수 있다.
 */
export function relyingParty(): RelyingParty | null {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) return null;
  try {
    const url = new URL(base);
    return { rpID: url.hostname, origin: url.origin };
  } catch {
    return null;
  }
}

export async function passkeyCount(): Promise<number> {
  return db.passkey.count();
}

export interface PasskeyRow {
  id: string;
  label: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export async function listPasskeys(): Promise<PasskeyRow[]> {
  return db.passkey.findMany({
    select: { id: true, label: true, createdAt: true, lastUsedAt: true },
    orderBy: { createdAt: "asc" },
  });
}

// ── 챌린지 ──────────────────────────────────────────────────────────────

async function rememberChallenge(challenge: string, purpose: "register" | "login"): Promise<void> {
  // 만료된 것은 이때 같이 치운다 — 청소 전용 크론을 하나 더 두지 않으려고.
  await db.authChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await db.authChallenge.create({
    data: { challenge, purpose, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) },
  });
}

/**
 * 챌린지를 **쓰면서 지운다**. 한 번 쓴 챌린지가 남아 있으면 같은 응답을 다시 보내
 * 통과할 수 있다(재전송 공격). 지워진 개수로 성공을 판정한다 — 동시에 두 번 들어와도
 * 한쪽만 1을 받는다.
 */
async function consumeChallenge(challenge: string, purpose: "register" | "login"): Promise<boolean> {
  const { count } = await db.authChallenge.deleteMany({
    where: { challenge, purpose, expiresAt: { gt: new Date() } },
  });
  return count > 0;
}

// ── 등록 ────────────────────────────────────────────────────────────────

/**
 * @param excludeExisting 이미 등록된 자격증명을 브라우저가 거부하게 할지.
 *
 * 설정 화면(이미 로그인된 상태)에서는 켠다 — "이미 등록한 폰이면 안 눌러도 돼요"가 참이 된다.
 * **초대 등록에서는 끈다**: iCloud 키체인은 같은 애플 계정의 기기끼리 패스키를 동기화하므로,
 * 다른 기기에서 한 번 등록했으면 새 기기도 "이미 등록됨"으로 막힌다. 그 상태에서 로그인까지
 * 안 되면 들어올 길이 아예 없어진다(2026-09-20, 실사용자가 이 교착에 걸렸다). 초대 링크의
 * 존재 이유가 "이 사람에게 이 기기로 들어올 길을 준다"이므로 여기서 막으면 안 된다.
 * 재등록 자체는 안전하다 — verifyRegistration이 credentialId로 upsert한다.
 */
export async function registrationOptions({ excludeExisting = true } = {}) {
  const rp = relyingParty();
  if (!rp) return null;

  const existing = excludeExisting
    ? await db.passkey.findMany({ select: { credentialId: true, transports: true } })
    : [];

  const options = await generateRegistrationOptions({
    rpName: "qurator",
    rpID: rp.rpID,
    userID: new TextEncoder().encode(USER_ID),
    userName: USER_NAME,
    attestationType: "none", // 인증기 제조사 증명은 필요 없다. 우리는 한 사람만 쓴다
    excludeCredentials: existing.map((p) => ({
      id: p.credentialId,
      transports: parseTransports(p.transports),
    })),
    authenticatorSelection: {
      residentKey: "required", // 기기에 저장 → 다음에 아이디 입력 없이 얼굴만으로 로그인
      userVerification: "required", // Face ID/암호 없이는 서명하지 않는다
    },
  });

  await rememberChallenge(options.challenge, "register");
  return options;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export async function verifyRegistration(
  response: RegistrationResponseJSON,
  label: string
): Promise<VerifyResult & { label?: string }> {
  const rp = relyingParty();
  if (!rp) return { ok: false, reason: "not-configured" };

  const challenge = expectedChallengeOf(response.response?.clientDataJSON);
  if (!challenge || !(await consumeChallenge(challenge, "register"))) {
    return { ok: false, reason: "challenge" };
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
  } catch {
    return { ok: false, reason: "verify" };
  }
  if (!verification.verified) return { ok: false, reason: "verify" };

  const { credential } = verification.registrationInfo;
  await db.passkey.upsert({
    where: { credentialId: credential.id },
    create: {
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: credential.transports ? JSON.stringify(credential.transports) : null,
      label,
    },
    update: { counter: credential.counter, label },
  });

  await audit({ actor: "HUMAN", action: "passkey.registered", detail: `${label} 등록` });
  return { ok: true, label };
}

export async function deletePasskey(id: string): Promise<boolean> {
  const { count } = await db.passkey.deleteMany({ where: { id } });
  if (count > 0) await audit({ actor: "HUMAN", action: "passkey.deleted", detail: id });
  return count > 0;
}

// ── 로그인 ──────────────────────────────────────────────────────────────

export async function authenticationOptions() {
  const rp = relyingParty();
  if (!rp) return null;
  // 등록된 패스키가 없으면 로그인 창을 띄우지 않는다 — 띄워봐야 사람만 헷갈린다.
  if ((await passkeyCount()) === 0) return null;

  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: "required",
    // allowCredentials를 비워 둔다: 기기에 저장된 패스키(residentKey)를 브라우저가
    // 알아서 고르게 해, **로그인 화면이 어떤 자격증명이 존재하는지 알려주지 않게** 한다.
  });

  await rememberChallenge(options.challenge, "login");
  return options;
}

export async function verifyAuthentication(
  response: AuthenticationResponseJSON
): Promise<VerifyResult & { label?: string }> {
  const rp = relyingParty();
  if (!rp) return { ok: false, reason: "not-configured" };

  const challenge = expectedChallengeOf(response.response?.clientDataJSON);
  if (!challenge || !(await consumeChallenge(challenge, "login"))) {
    return { ok: false, reason: "challenge" };
  }

  const stored = await db.passkey.findUnique({ where: { credentialId: response.id } });
  if (!stored) return { ok: false, reason: "unknown-credential" };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true, // Face ID를 통과했다는 증거가 없으면 거절
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64url")),
        counter: stored.counter,
        transports: parseTransports(stored.transports),
      },
    });
  } catch {
    return { ok: false, reason: "verify" };
  }
  if (!verification.verified) return { ok: false, reason: "verify" };

  await db.passkey.update({
    where: { id: stored.id },
    data: { counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() },
  });
  await audit({
    actor: "HUMAN",
    action: "passkey.login",
    detail: `${stored.label ?? "기기"}에서 Face ID로 로그인`,
  });
  return { ok: true, label: stored.label ?? "기기" };
}

// ── 잡동사니 ────────────────────────────────────────────────────────────

/**
 * 응답 안의 clientDataJSON에서 챌린지를 꺼낸다. 이 값을 **믿으려고** 꺼내는 게 아니라
 * DB에서 찾아 지우기 위한 열쇠로만 쓴다 — 실제 검증은 라이브러리가 서명까지 대조해서 한다.
 * 그래서 여기서 위조된 값을 넣어봐야 DB에 없으므로 그대로 떨어진다.
 */
function expectedChallengeOf(clientDataJSON: string | undefined): string | null {
  if (!clientDataJSON) return null;
  try {
    const parsed = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8"));
    return typeof parsed.challenge === "string" ? parsed.challenge : null;
  } catch {
    return null;
  }
}

function parseTransports(raw: string | null): AuthenticatorTransportLike[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AuthenticatorTransportLike[]) : undefined;
  } catch {
    return undefined;
  }
}

type AuthenticatorTransportLike = "ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";

/** UA에서 추정한 기기 이름 — 목록에서 "이게 어느 폰이지"를 알아볼 수 있게. */
export function deviceLabel(userAgent: string | null): string {
  const ua = userAgent ?? "";
  if (/iPhone/i.test(ua)) return "아이폰";
  if (/iPad/i.test(ua)) return "아이패드";
  if (/Android/i.test(ua)) return "안드로이드";
  if (/Macintosh/i.test(ua)) return "맥";
  if (/Windows/i.test(ua)) return "PC";
  return "기기";
}

// ── 1회용 등록 초대 ─────────────────────────────────────────────────────
// docs/03 §7.2. 실사용자(현표)에게 패스키를 등록시키려고 마스터 토큰을 통째로 넘기지 않기 위한 길.
// 이 코드는 **게이트를 여는 열쇠**이므로 취급이 토큰과 같아야 한다: 높은 엔트로피, 짧은 수명, 1회용.

/** 초대 수명. 카톡으로 보내고 시간 여유를 두고 등록할 수 있게 7일. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Invite {
  code: string;
  expiresAt: Date;
}

export async function createInvite(note: string | null): Promise<Invite> {
  // 만료된 것은 이때 같이 치운다 — 청소 전용 크론을 하나 더 두지 않으려고.
  await db.passkeyInvite.deleteMany({ where: { expiresAt: { lt: new Date() } } });

  const code = randomBytes(32).toString("base64url"); // 추측으로는 못 맞춘다
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await db.passkeyInvite.create({ data: { code, note, expiresAt } });
  await audit({
    actor: "HUMAN",
    action: "passkey.invited",
    detail: note ? `${note}에게 등록 초대` : "등록 초대 발급",
  });
  return { code, expiresAt };
}

/** 아직 살아 있는 초대인가. **소비하지 않는다** — 등록에 성공했을 때만 쓴다. */
export async function inviteIsLive(code: unknown): Promise<boolean> {
  if (typeof code !== "string" || code.length < 32 || code.length > 100) return false;
  const found = await db.passkeyInvite.findFirst({
    where: { code, usedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return found !== null;
}

/**
 * 초대를 쓰면서 닫는다. 갱신된 행 수로 판정하므로 동시에 두 번 들어와도 한쪽만 1을 받는다 —
 * 링크 하나로 두 기기가 등록되는 일이 없다.
 */
export async function consumeInvite(code: string): Promise<boolean> {
  const { count } = await db.passkeyInvite.updateMany({
    where: { code, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  return count > 0;
}

export interface InviteRow {
  id: string;
  note: string | null;
  expiresAt: Date;
  usedAt: Date | null;
}

/** 살아 있는 초대만. 코드 자체는 **절대 다시 내보내지 않는다** — 발급 순간에만 화면에 뜬다. */
export async function listLiveInvites(): Promise<InviteRow[]> {
  return db.passkeyInvite.findMany({
    where: { usedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, note: true, expiresAt: true, usedAt: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function revokeInvite(id: string): Promise<boolean> {
  const { count } = await db.passkeyInvite.deleteMany({ where: { id } });
  return count > 0;
}

/** 등록 화면이 부르는 이름 정리 — 사람이 지은 이름이 있으면 그것, 없으면 UA 추정값. */
export function resolveLabel(provided: unknown, userAgent: string | null): string {
  return cleanDeviceName(provided) ?? deviceLabel(userAgent);
}
