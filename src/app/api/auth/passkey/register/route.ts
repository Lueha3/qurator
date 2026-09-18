import { NextRequest, NextResponse } from "next/server";
import { registrationOptions, resolveLabel, verifyRegistration } from "@/lib/passkey";
import { setActorCookie } from "@/lib/actor";

// 패스키 등록 — **게이트 뒤에 있다**(공개 경로가 아니다).
// 이미 로그인한 사람만 등록할 수 있어야 한다. 아니면 아무나 자기 얼굴을 등록해
// 이 앱의 주인이 된다 — 패스키를 붙이면서 뒷문을 다는 셈이 된다.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const options = await registrationOptions();
  if (!options) {
    return NextResponse.json({ error: "PUBLIC_BASE_URL이 없습니다" }, { status: 503 });
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

  const { credential, label: provided } = body as { credential?: unknown; label?: unknown };
  const label = resolveLabel(provided, req.headers.get("user-agent"));

  const result = await verifyRegistration(
    credential as Parameters<typeof verifyRegistration>[0],
    label
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.reason ?? "failed" }, { status: 400 });
  }

  // 방금 등록한 기기가 곧 지금 앉아 있는 사람이다 — 이름표를 바로 심어준다.
  const res = NextResponse.json({ ok: true, label });
  setActorCookie(res, label, req.nextUrl.protocol === "https:");
  return res;
}
