import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { handleUpdate, type TgUpdate } from "@/lib/telegram/handler";

// 프로덕션 경로. 로컬 개발은 폴링(scripts/bot-poll.ts)을 쓴다 —
// 텔레그램은 같은 봇 토큰에서 webhook과 getUpdates를 동시에 허용하지 않는다(409 Conflict).

export const dynamic = "force-dynamic";

/** setWebhook의 secret_token과 대조. 길이가 달라도 타이밍이 새지 않게 상수시간 비교. */
function secretMatches(received: string | null): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return false; // 미설정 시 전면 거부 (fail closed)
  if (!received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!secretMatches(req.headers.get("x-telegram-bot-api-secret-token"))) {
    // 시크릿이 없으면 누구나 우리 게이트웨이로 무신사 요청을 시킬 수 있다.
    return new NextResponse("forbidden", { status: 403 });
  }

  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return NextResponse.json({ ok: true }); // 파싱 실패해도 텔레그램에는 200을 준다(재전송 폭주 방지)
  }

  // 텔레그램은 몇 초 안에 200을 기대하고, 늦으면 같은 업데이트를 재전송한다.
  // 무신사 fetch는 최소 간격 5초+지터가 걸려 있어 그 안에 못 끝난다 →
  // 즉시 200을 주고 처리는 뒤에서 이어간다. (핸들러는 update_id 멱등성을 스스로 보장하지 않으므로
  // 재전송이 오면 중복 캡처가 생길 수 있다 — 아래 seen 캐시로 막는다.)
  if (alreadySeen(update.update_id)) {
    return NextResponse.json({ ok: true });
  }

  void handleUpdate(update).catch((err) => {
    console.error("[telegram] 업데이트 처리 실패", update.update_id, err);
  });

  return NextResponse.json({ ok: true });
}

// 재전송 중복 방지. 프로세스 메모리라 재시작 시 비지만, 재전송 창(수 분)만 버티면 충분하다.
const seen = new Map<number, number>();
const SEEN_TTL_MS = 10 * 60_000;

function alreadySeen(updateId: number): boolean {
  const now = Date.now();
  for (const [id, ts] of seen) {
    if (now - ts > SEEN_TTL_MS) seen.delete(id);
  }
  if (seen.has(updateId)) return true;
  seen.set(updateId, now);
  return false;
}
