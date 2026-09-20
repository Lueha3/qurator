"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { CaptureResponse } from "@/lib/api-types";
import type { VisionFailReason } from "@/lib/vision-extract";
import { detectInAppBrowser } from "./in-app-browser";

// 캡처 진입점 — docs/08 §3.3. 모든 탭의 같은 자리(우하단)에 있고, 누르면 바로 사진첩이 열린다.
// docs/06 §2의 "입력은 2탭"을 한 탭 더 줄이는 것이 목표이고, 여기가 그 한 탭이다.
//
// 업로드 로직은 기존 ScreenshotCapture와 동일하다(리사이즈 → /api/capture). 바뀐 것은 위치와
// 결과 표시뿐 — 인라인 박스 대신 토스트를 띄우고 딜 탭에서 방금 만든 카드를 연다.

const MAX_IMAGES = 4;
/**
 * 긴 변 기준. 1600 → 2000 (2026-09-20, 실사용 오독 재현으로 확인).
 *
 * 아이폰 세로 스크린샷은 보통 2500~2800px 높이라 1600 상한에서도 **항상** 줄고 있었다 —
 * "1170~1290px는 그대로 통과"라는 예전 가정은 폭 기준이었는데 실제로 잘리는 건 높이다.
 * 30칸짜리 좋아요 목록 그리드는 칸당 텍스트가 원래도 작은데, 그 위에 줄어드니 브랜드명이
 * 통째로 오독됐다(예: "아워데이즈"→"아워이레이즈", "베를린"→"버클린"). Sonnet 5로 모델을
 * 올려도 남아 있던 문제라 해상도 쪽을 건드린다 — docs/06 §4.1에서 예고했던 다음 단계.
 *
 * API 쪽 상한도 확인했다(Anthropic vision 문서, 2026-09-20) — Sonnet 5는 "고해상도 티어"
 * 대상이라 긴 변 2576px·4784 비주얼 토큰까지는 서버가 축소하지 않는다. 2000은 그 아래라
 * 이번에 올린 만큼이 온전히 모델에 들어간다 — 헛수고가 아니다. 여전히 부족하면 다음은
 * 그 상한 쪽으로 더 올리는 것(2000→2400 정도)이고, 2576을 넘겨봐야 서버가 어차피 다시
 * 줄이므로 의미가 없다. 반대급부는 이미지당 입력 토큰 증가(비용)다 — 해상도는 픽셀
 * 면적에 비례해 토큰이 느니, 두 배씩 올리지 않는다.
 */
const MAX_EDGE = 2000;
const JPEG_QUALITY = 0.85;
const PASSTHROUGH_BYTES = 1_500_000;

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("<img> decode failed"));
    };
    img.src = url;
  });
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** createImageBitmap 경로일 때만 있다 — 캔버스에 그린 뒤 메모리를 바로 돌려준다 */
  close?: () => void;
}

/**
 * HEIC(아이폰 기본 사진 형식)는 `<img>` 디코드가 웹뷰마다 갈린다 — 카톡·인스타 인앱
 * 브라우저에서는 실패하는 경우가 실제로 있다(2026-09-20, 현표 제보 — 관리자 폰에서는
 * 재현 안 됨. 관리자는 홈 화면 아이콘·현표는 다른 진입 경로일 가능성). 실패를 한 경로에서
 * 확정 짓지 않고, 코덱 지원 범위가 더 넓은 `createImageBitmap`을 먼저 시도한 뒤에만
 * `<img>`로 폴백한다 — 어느 한쪽이 막힌 환경에서도 다른 쪽이 열어줄 여지를 남긴다.
 */
async function decodeImage(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // 다음 경로로 — 조용히 넘어간다. 둘 다 실패했을 때만 위로 알린다.
    }
  }
  const img = await loadImageElement(file);
  return { source: img, width: img.naturalWidth, height: img.naturalHeight };
}

/**
 * 업로드 전에 브라우저에서 줄인다. 서버리스 요청 본문 상한(수 MB)을 넘지 않게 하려는 것이고,
 * 작은 글씨(품번)까지 읽어야 하므로 필요 이상으로 줄이지는 않는다.
 */
async function downscale(file: File): Promise<Blob> {
  const decoded = await decodeImage(file);
  try {
    const longest = Math.max(decoded.width, decoded.height);
    const scale = Math.min(1, MAX_EDGE / longest);
    if (scale === 1 && file.type === "image/jpeg" && file.size <= PASSTHROUGH_BYTES) return file;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(decoded.width * scale);
    canvas.height = Math.round(decoded.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) =>
      canvas.toBlob((blob) => resolve(blob ?? file), "image/jpeg", JPEG_QUALITY)
    );
  } finally {
    decoded.close?.();
  }
}

type Toast = { tone: "ok" | "error"; message: string; detail?: string | null };

/**
 * 읽기 실패를 원인별로 말한다. 예전에는 전부 "사진을 못 읽었어요"였는데, 그러면
 * 관리자가 고쳐야 할 설정 문제와 현표가 다시 찍으면 되는 사진 문제가 구분되지 않았다.
 */
function visionFailMessage(reason?: VisionFailReason): string {
  switch (reason) {
    case "no-api-key":
      return "서버에 AI 설정이 없어요. 관리자에게 알려주세요.";
    case "timeout":
      return "시간이 오래 걸려 멈췄어요. 다시 해보세요.";
    case "api-error":
      return "AI 서버가 응답하지 않아요. 잠시 뒤 다시 해보세요.";
    case "truncated":
      return "상품이 너무 많아요. 나눠서 올려주세요.";
    default:
      return "사진을 못 읽었어요. ✏️ 직접 만들기로 해보세요.";
  }
}

export function CaptureFab() {
  const router = useRouter();
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  useEffect(() => {
    if (!toast) return;
    // 가격 변화 노트가 붙은 성공 토스트는 읽을 시간이 필요하다 — 실패보다 길게 둔다.
    const ms = toast.detail ? 10_000 : 6_000;
    const timer = setTimeout(() => setToast(null), ms);
    return () => clearTimeout(timer);
  }, [toast]);

  async function handleFiles(list: FileList | null) {
    const files = Array.from(list ?? []).slice(0, MAX_IMAGES);
    if (files.length === 0) return;

    setToast(null);
    try {
      setBusy("사진 준비 중…");
      let blobs: Blob[];
      try {
        blobs = await Promise.all(files.map(downscale));
      } catch {
        // 사진 자체를 못 연 것 — 네트워크 탓이 아니다. 잘못된 원인을 안내하지 않는다.
        // 흔한 원인 둘 다 HEIC(아이폰 기본 사진 형식) 디코드 제한이다:
        //   ① 인앱 브라우저(카톡·인스타) — iOS라도 WebKit 코덱 접근이 제한된다
        //   ② 맥에서 사파리가 아닌 브라우저 — 크롬·파이어폭스는 HEIC 디코더 자체가 없다
        //      (2026-09-20, 친구 맥에서 재현 — 관리자 아이폰 사파리에서는 문제없었다)
        const inApp = detectInAppBrowser(navigator.userAgent);
        setToast({
          tone: "error",
          message: inApp
            ? `${inApp.name} 안에서는 이 사진을 못 열어요. 더보기(⋯)에서 "Safari로 열기"를 눌러 다시 해보세요.`
            : `사진을 열 수 없어요. Safari로 열어보거나, 사진 앱에서 JPEG로 저장한 뒤 다시 올려주세요.`,
        });
        return;
      }

      const form = new FormData();
      blobs.forEach((blob, i) => form.append("images", blob, `screenshot-${i + 1}.jpg`));

      setBusy(files.length > 1 ? `${files.length}장 읽는 중…` : "읽는 중…");
      const res = await fetch("/api/capture", { method: "POST", body: form });
      if (res.status === 401) {
        // 세션이 풀린 것 — "올리지 못했어요"로 뭉뚱그리면 원인을 모른다. 로그인 화면으로 보내고 돌아오게 한다.
        setToast({ tone: "error", message: "로그인이 풀렸어요. 다시 들어와 주세요." });
        router.push(`/login?next=${encodeURIComponent(pathname)}`);
        return;
      }
      const body = (await res.json()) as CaptureResponse;

      switch (body.kind) {
        case "created":
          setToast({
            tone: "ok",
            // 같은 상품을 다시 찍은 경우 "새로 만들었다"고 하면 거짓말이다 — 카드는 원래 있던 것이다.
            message: body.reused ? "있던 딜에 오늘 가격 기록했어요." : "올렸어요!",
            detail: body.priceChangeNote,
          });
          // 방금 만든 카드를 딜 탭에서 곧바로 연다 — 캡처 다음 동작이 항상 이 카드 안에 있다.
          router.push(`/deals?d=${body.dealId}`);
          router.refresh();
          break;
        case "grid": {
          // 목록 한 장 = 상품 여러 개. 몇 개를 담았는지, 그중 싸진 것이 있는지가 알고 싶은 전부다.
          const total = body.added + body.updated;
          const parts = [body.added > 0 ? `새 상품 ${body.added}개` : null, body.updated > 0 ? `가격 갱신 ${body.updated}개` : null]
            .filter(Boolean)
            .join(" · ");
          setToast({
            tone: total > 0 ? "ok" : "error",
            message: total > 0 ? `목록에서 ${total}개 담았어요.` : "읽은 상품이 없어요. 좀 더 가까이 찍어주세요.",
            detail: total > 0 ? [parts, body.cheaper > 0 ? `📉 ${body.cheaper}개 지난번보다 싸졌어요` : null].filter(Boolean).join("\n") : null,
          });
          if (total > 0) {
            router.push("/deals?f=saved");
            router.refresh();
          }
          break;
        }
        case "not_product_page":
          setToast({
            tone: "error",
            message: "상품 화면 맨 위를 찍어주세요. 브랜드·가격이 보이게요.",
          });
          break;
        case "vision_failed":
          // 원인을 뭉개지 않는다 — 설정 누락과 사진 문제는 할 일이 전혀 다르다.
          setToast({ tone: "error", message: visionFailMessage(body.reason) });
          break;
        default:
          setToast({ tone: "error", message: body.error });
      }
    } catch {
      setToast({ tone: "error", message: "올리지 못했어요. 인터넷 확인하고 다시 해보세요." });
    } finally {
      setBusy(null);
      // 같은 파일을 다시 골라도 change 이벤트가 나게 비운다.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  // 설정 탭에서는 띄우지 않는다 — 캡처가 다음 동작이 아닌 유일한 탭이고, 폼이 길어
  // 떠 있는 버튼이 실제로 저장 버튼을 가린다(실기기 확인, 2026-09-15).
  // 토스트는 캡처 직후 어느 탭으로 이동하든 보여야 하므로 여기서 끊지 않는다.
  const showFab = pathname !== "/settings";

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />

      {toast && (
        <div
          role="status"
          onClick={() => setToast(null)}
          className="fixed inset-x-0 z-40 mx-auto max-w-3xl px-4"
          style={{ bottom: "calc(4.5rem + env(safe-area-inset-bottom, 0px))" }}
        >
          <div
            className={`elevated rounded-2xl px-4 py-3 text-sm ${
              toast.tone === "ok" ? "bg-accent text-accent-ink" : "bg-danger text-accent-ink"
            }`}
          >
            <div className="font-medium">
              {toast.tone === "ok" ? "✅ " : "⚠️ "}
              {toast.message}
            </div>
            {toast.detail && (
              <pre className="mt-1 whitespace-pre-wrap font-sans text-xs opacity-90">{toast.detail}</pre>
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        hidden={!showFab}
        disabled={!!busy}
        onClick={() => inputRef.current?.click()}
        aria-label="스크린샷 올리기"
        className="elevated fixed right-4 z-30 flex h-14 items-center gap-2 rounded-full bg-accent px-5 text-base font-semibold text-accent-ink transition-opacity active:opacity-90 disabled:opacity-70"
        style={{ bottom: "calc(4.25rem + env(safe-area-inset-bottom, 0px))" }}
      >
        <span aria-hidden className="text-[20px] leading-none">📷</span>
        {busy ?? "올리기"}
      </button>
    </>
  );
}
