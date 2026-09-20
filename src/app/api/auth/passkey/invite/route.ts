import { NextRequest, NextResponse } from "next/server";
import {
  consumeInvite,
  inviteIsLive,
  registrationOptions,
  resolveLabel,
  verifyRegistration,
} from "@/lib/passkey";
import { setSessionCookie } from "@/lib/session";
import { setActorCookie } from "@/lib/actor";

// 1회용 초대로 패스키 등록 — docs/03 §7.2. **게이트 앞에 열려 있는 경로다**(proxy.ts PUBLIC_PATHS).
//
// 열려 있는 등록 경로이므로 이 앱에서 가장 조심해야 하는 표면이다. 지키는 것:
//   · 초대 코드는 32바이트 난수 — 추측으로는 못 맞춘다
//   · 7일 · 1회용 — 성공했을 때만 소비하고, 갱신된 행 수로 판정해 동시 사용을 막는다
//   · 코드가 죽어 있으면 등록 옵션조차 만들지 않는다
//   · 성공하면 초대가 닫힌다 — 링크를 다시 눌러도 아무 일이 없어야 한다

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!(await inviteIsLive(code))) {
    return NextResponse.json({ error: "invalid-invite" }, { status: 403 });
  }
  // excludeCredentials를 보내지 않는다 — iCloud로 동기화된 패스키 때문에 "이미 등록됨"으로
  // 막히면, 로그인까지 안 되는 사람은 들어올 길이 없어진다. passkey.ts의 주석 참고.
  const options = await registrationOptions({ excludeExisting: false });
  if (!options) return NextResponse.json({ error: "not-configured" }, { status: 503 });
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

  const { code, credential, label: provided } = body as {
    code?: unknown;
    credential?: unknown;
    label?: unknown;
  };
  if (typeof code !== "string" || !(await inviteIsLive(code))) {
    return NextResponse.json({ error: "invalid-invite" }, { status: 403 });
  }

  const label = resolveLabel(provided, req.headers.get("user-agent"));
  const result = await verifyRegistration(
    credential as Parameters<typeof verifyRegistration>[0],
    label
  );
  if (!result.ok) {
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }

  // 등록이 실제로 성공한 뒤에만 초대를 닫는다 — 중간에 실패하면 다시 시도할 수 있어야 한다.
  // 여기서 false가 나오면 그 사이 누가 먼저 썼다는 뜻이라, 세션을 주지 않는다.
  if (!(await consumeInvite(code))) {
    return NextResponse.json({ error: "invalid-invite" }, { status: 403 });
  }

  const secure = req.nextUrl.protocol === "https:";
  const res = NextResponse.json({ ok: true, label });
  setSessionCookie(res, token, secure);
  setActorCookie(res, label, secure);
  return res;
}
