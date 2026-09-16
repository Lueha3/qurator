import { NextRequest, NextResponse } from "next/server";
import { captureFromScreenshots, MAX_CAPTURE_IMAGES } from "@/lib/deal-flow";
import type { CaptureResponse } from "@/lib/api-types";

// 스크린샷 업로드 → Vision 캡처 (docs/06). 서버 액션이 아니라 라우트 핸들러인 이유:
// 서버 액션 본문은 기본 1MB 상한이고, 폰 스크린샷 몇 장은 그걸 넘는다.
// proxy.ts의 인증 게이트 뒤에 있다 — 공개 경로가 아니다.

export const dynamic = "force-dynamic";

/** Vision 추출(최대 20초)에 DB 쓰기까지 더해지므로 기본 10초로는 잘린다. */
export const maxDuration = 60;

/** 클라이언트가 리사이즈해 보내지만(ScreenshotCapture.tsx), 서버도 스스로 상한을 둔다. */
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

function reply(body: CaptureResponse, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return reply({ kind: "error", error: "잘못된 요청입니다." }, 400);
  }

  const files = form.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return reply({ kind: "error", error: "스크린샷을 선택해주세요." }, 400);
  if (files.length > MAX_CAPTURE_IMAGES) {
    return reply({ kind: "error", error: `한 번에 최대 ${MAX_CAPTURE_IMAGES}장까지 올릴 수 있습니다.` }, 400);
  }
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_TOTAL_BYTES) {
    return reply({ kind: "error", error: "이미지 용량이 너무 큽니다. 장수를 줄여 다시 올려주세요." }, 413);
  }

  // 이미지 바이트는 이 요청의 메모리에만 존재한다 — 디스크·DB·로그에 쓰지 않는다 (docs/06 §4.3).
  const images = await Promise.all(
    files.map(async (file) => ({
      data: Buffer.from(await file.arrayBuffer()).toString("base64"),
      mediaType: file.type || "image/jpeg",
    }))
  );

  const result = await captureFromScreenshots(images);
  if (result.kind === "created") {
    return reply({
      kind: "created",
      dealId: result.dealId,
      priceChangeNote: result.priceChangeNote,
      reused: result.reused,
    });
  }
  return reply({ kind: result.kind });
}
