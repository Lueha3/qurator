import { NextRequest, NextResponse } from "next/server";
import { runDigest } from "@/lib/push";

// 아침 알림 크론 — docs/08 §4.0.5. Vercel Cron이 vercel.json의 스케줄대로 이 주소를 부른다.
//
// 인증은 `Authorization: Bearer <CRON_SECRET>`이다. Vercel이 크론 요청에 이 헤더를 붙여준다 —
// 크론은 우리 쿠키도 x-app-token도 실을 수 없기 때문이다(docs/03 §5.4).
// proxy.ts가 이미 같은 검사를 하지만 여기서 한 번 더 한다: matcher가 바뀌거나 라우트가
// 다른 곳으로 옮겨져도 이 주소가 열려 있으면 안 된다.

export const runtime = "nodejs"; // web-push가 node:crypto를 쓴다
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // 미설정 시 전면 거부(fail closed) — proxy.ts와 같은 원칙.
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const run = await runDigest(new Date());
  // 상태를 그대로 돌려준다 — Vercel 크론 로그만 보고도 왜 안 왔는지 알 수 있어야 한다.
  return NextResponse.json(run);
}
