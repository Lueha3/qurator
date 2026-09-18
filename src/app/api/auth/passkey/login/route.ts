import { NextRequest, NextResponse } from "next/server";
import { authenticationOptions, verifyAuthentication } from "@/lib/passkey";
import { setSessionCookie } from "@/lib/session";
import { setActorCookie } from "@/lib/actor";

// 패스키 로그인 — docs/03 §7.1. **게이트 앞에 열려 있는 경로다**(proxy.ts PUBLIC_PATHS).
// 로그인하기 전에 닿아야 하기 때문이다.
//
// 열려 있어도 열쇠가 되지 않는 이유: 여기서 나가는 것은 무작위 챌린지와 성공 여부뿐이고,
// 통과 조건은 **기기 보안 요소 안 개인키의 서명**이다. 그 키는 폰을 떠나지 않는다.
// 챌린지는 서버가 낸 것을 한 번만 쓸 수 있고(쓰면 지운다), 출처·RP ID·사용자 확인(Face ID)까지
// 전부 대조한 뒤에야 세션 쿠키가 나간다.

export const runtime = "nodejs"; // @simplewebauthn/server가 node:crypto를 쓴다
export const dynamic = "force-dynamic";

export async function GET() {
  const options = await authenticationOptions();
  if (!options) {
    // 등록된 패스키가 없거나 PUBLIC_BASE_URL이 없다. 어느 쪽인지는 말하지 않는다.
    return NextResponse.json({ error: "unavailable" }, { status: 404 });
  }
  return NextResponse.json(options);
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad-request" }, { status: 400 });
  }

  const token = process.env.APP_ACCESS_TOKEN;
  if (!token) return NextResponse.json({ error: "not-configured" }, { status: 503 });

  const result = await verifyAuthentication(body as Parameters<typeof verifyAuthentication>[0]);
  if (!result.ok) {
    // 실패 이유를 자세히 알려주지 않는다 — 어떤 자격증명이 존재하는지 알려주는 꼴이 된다.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const secure = req.nextUrl.protocol === "https:";
  const res = NextResponse.json({ ok: true });
  setSessionCookie(res, token, secure);
  // 이 세션이 누구인지 이름표를 함께 심는다 — 이후 작업 기록에 이 이름이 남는다(docs/03 §7.2).
  if (result.label) setActorCookie(res, result.label, secure);
  return res;
}
