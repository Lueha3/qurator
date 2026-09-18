import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { ACTOR_NAME_MAX } from "./session";

// "누가 했는가" — docs/03 §7.2.
//
// 쓰는 손이 둘이 되면서(협업자 + 현표) 감사 로그의 `actor: HUMAN`만으로는 "누가 승인했지"를
// 답할 수 없게 됐다. 패스키로 로그인하면 그 패스키 이름을 **서명된 쿠키**에 담아, 이후 작업
// 기록에 그 이름이 남게 한다.
//
// 세션 쿠키와 따로 두는 이유: 게이트(proxy.ts)는 건드리지 않는다. 이 값은 **권한이 아니라 이름표**라,
// 들어올 수 있는지는 기존 게이트가 그대로 판정하고 여기서는 누구인지만 말한다.
// 서명하는 이유: 이름표라도 클라이언트가 마음대로 쓰게 두면 기록이 기록이 아니게 된다.

const ACTOR_COOKIE = "qurator_actor";
const MAX_NAME_LENGTH = ACTOR_NAME_MAX;

/** 세션 쿠키와 같은 수명 — 이름표만 먼저 사라져 "누군지 모르는 로그인"이 되지 않게. */
const ACTOR_MAX_AGE = 60 * 60 * 24 * 90;

function signingKey(): string | null {
  // 별도 시크릿을 하나 더 만들지 않는다. 게이트 토큰에서 파생시키되 용도를 섞지 않게 라벨을 붙인다.
  const token = process.env.APP_ACCESS_TOKEN;
  return token ? `actor-name:${token}` : null;
}

function sign(value: string, key: string): string {
  return createHmac("sha256", key).update(value).digest("base64url");
}

export function actorCookieValue(name: string): string | null {
  const key = signingKey();
  if (!key) return null;
  const clean = name.slice(0, MAX_NAME_LENGTH);
  const encoded = Buffer.from(clean, "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, key)}`;
}

export function setActorCookie(res: NextResponse, name: string, secure: boolean): void {
  const value = actorCookieValue(name);
  if (!value) return;
  res.cookies.set(ACTOR_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: ACTOR_MAX_AGE,
  });
}

export function clearActorCookie(res: NextResponse): void {
  res.cookies.set(ACTOR_COOKIE, "", { path: "/", maxAge: 0 });
}

/** 쿠키에서 이름을 꺼낸다. 서명이 맞지 않으면 **이름이 없는 것으로 친다** — 틀린 이름보다 낫다. */
export function readActorCookie(raw: string | undefined): string | null {
  const key = signingKey();
  if (!key || !raw) return null;

  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const encoded = raw.slice(0, dot);
  const provided = raw.slice(dot + 1);

  const expected = sign(encoded, key);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const name = Buffer.from(encoded, "base64url").toString("utf8");
    return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null;
  } catch {
    return null;
  }
}

/**
 * 지금 요청을 보낸 사람의 이름. 요청 밖(크론 등)에서 부르면 조용히 null이다 —
 * 기록을 남기려다 본 작업을 망가뜨리지 않는다(audit()과 같은 원칙).
 */
export async function currentActor(): Promise<string | null> {
  try {
    const store = await cookies();
    return readActorCookie(store.get(ACTOR_COOKIE)?.value);
  } catch {
    return null;
  }
}

/** 기기 이름 입력값 정리. 빈 값이면 호출자가 UA 추정값을 쓴다. */
export function cleanDeviceName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed.slice(0, MAX_NAME_LENGTH) : null;
}

