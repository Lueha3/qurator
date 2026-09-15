"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { CaptureResponse } from "@/lib/api-types";
import { CameraIcon } from "./icons";

// 캡처 진입점 — docs/08 §3.3. 모든 탭의 같은 자리(우하단)에 있고, 누르면 바로 사진첩이 열린다.
// docs/06 §2의 "입력은 2탭"을 한 탭 더 줄이는 것이 목표이고, 여기가 그 한 탭이다.
//
// 업로드 로직은 기존 ScreenshotCapture와 동일하다(리사이즈 → /api/capture). 바뀐 것은 위치와
// 결과 표시뿐 — 인라인 박스 대신 토스트를 띄우고 딜 탭에서 방금 만든 카드를 연다.

const MAX_IMAGES = 4;
/** 긴 변 기준. 폰 스크린샷(1170~1290px)은 대부분 그대로 통과하고, 태블릿·고해상도만 줄어든다. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;
const PASSTHROUGH_BYTES = 1_500_000;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지를 열 수 없습니다."));
    };
    img.src = url;
  });
}

/**
 * 업로드 전에 브라우저에서 줄인다. 서버리스 요청 본문 상한(수 MB)을 넘지 않게 하려는 것이고,
 * 작은 글씨(품번)까지 읽어야 하므로 필요 이상으로 줄이지는 않는다.
 */
async function downscale(file: File): Promise<Blob> {
  const img = await loadImage(file);
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = Math.min(1, MAX_EDGE / longest);
  if (scale === 1 && file.type === "image/jpeg" && file.size <= PASSTHROUGH_BYTES) return file;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob ?? file), "image/jpeg", JPEG_QUALITY)
  );
}

type Toast = { tone: "ok" | "error"; message: string; detail?: string | null };

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
      setBusy("이미지 준비 중…");
      const blobs = await Promise.all(files.map(downscale));

      const form = new FormData();
      blobs.forEach((blob, i) => form.append("images", blob, `screenshot-${i + 1}.jpg`));

      setBusy(files.length > 1 ? `${files.length}장 읽는 중…` : "읽는 중…");
      const res = await fetch("/api/capture", { method: "POST", body: form });
      const body = (await res.json()) as CaptureResponse;

      switch (body.kind) {
        case "created":
          setToast({ tone: "ok", message: "카드를 만들었습니다.", detail: body.priceChangeNote });
          // 방금 만든 카드를 딜 탭에서 곧바로 연다 — 캡처 다음 동작이 항상 이 카드 안에 있다.
          router.push(`/deals?d=${body.dealId}`);
          router.refresh();
          break;
        case "not_product_page":
          setToast({
            tone: "error",
            message: "상품 페이지 상단(브랜드·상품명·가격이 보이는 화면)을 찍어주세요.",
          });
          break;
        case "vision_failed":
          setToast({
            tone: "error",
            message: "스크린샷을 읽지 못했습니다. 딜 탭의 [직접 입력]으로 만들 수 있습니다.",
          });
          break;
        default:
          setToast({ tone: "error", message: body.error });
      }
    } catch {
      setToast({ tone: "error", message: "업로드에 실패했습니다. 네트워크를 확인해주세요." });
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
              toast.tone === "ok" ? "bg-ok text-accent-ink" : "bg-danger text-accent-ink"
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
        className="elevated fixed right-4 z-30 flex h-14 items-center gap-2 rounded-full bg-honey px-5 text-base font-semibold text-accent-ink transition-opacity active:opacity-90 disabled:opacity-70"
        style={{ bottom: "calc(4.25rem + env(safe-area-inset-bottom, 0px))" }}
      >
        <CameraIcon className="h-[22px] w-[22px]" />
        {busy ?? "올리기"}
      </button>
    </>
  );
}
