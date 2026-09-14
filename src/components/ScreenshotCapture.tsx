"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CaptureResponse } from "@/lib/api-types";
import { DealForm } from "./DealForm";
import { primaryBtnCls } from "./form";

// 스크린샷 업로드 — docs/06 §2 "입력은 2탭": ① 사진첩에서 스크린샷 선택 ② 끝.
// 선택 즉시 올린다(확인 버튼 없음). 여러 장을 한 번에 고르면 한 상품 페이지를 위/아래로
// 나눠 찍은 것으로 보고 같이 보낸다 (docs/06 §4.4).

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

type Status =
  | { kind: "idle" }
  | { kind: "busy"; message: string }
  | { kind: "done"; message: string; detail?: string | null }
  | { kind: "error"; message: string };

export function ScreenshotCapture() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [manualOpen, setManualOpen] = useState(false);

  async function handleFiles(list: FileList | null) {
    const files = Array.from(list ?? []).slice(0, MAX_IMAGES);
    if (files.length === 0) return;

    try {
      setStatus({ kind: "busy", message: "이미지 준비 중…" });
      const blobs = await Promise.all(files.map(downscale));

      const form = new FormData();
      blobs.forEach((blob, i) => form.append("images", blob, `screenshot-${i + 1}.jpg`));

      setStatus({
        kind: "busy",
        message: files.length > 1 ? `스크린샷 ${files.length}장 읽는 중… (최대 20초)` : "스크린샷 읽는 중… (최대 20초)",
      });
      const res = await fetch("/api/capture", { method: "POST", body: form });
      const body = (await res.json()) as CaptureResponse;

      switch (body.kind) {
        case "created":
          setStatus({ kind: "done", message: "카드를 만들었습니다. 아래 '진행 중'에서 이어가세요.", detail: body.priceChangeNote });
          router.refresh();
          break;
        case "not_product_page":
          setStatus({ kind: "error", message: "상품 페이지 상단(브랜드·상품명·가격이 보이는 화면)을 찍어주세요." });
          break;
        case "vision_failed":
          setStatus({ kind: "error", message: "스크린샷을 읽지 못했습니다. 다시 시도하거나 아래 '직접 입력'을 이용해주세요." });
          break;
        default:
          setStatus({ kind: "error", message: body.error });
      }
    } catch {
      setStatus({ kind: "error", message: "업로드에 실패했습니다. 네트워크를 확인하고 다시 시도해주세요." });
    } finally {
      // 같은 파일을 다시 골라도 change 이벤트가 나게 비운다.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const busy = status.kind === "busy";

  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className={primaryBtnCls}>
        {busy ? status.message : "📷 스크린샷 올리기"}
      </button>
      <p className="mt-2 text-xs text-muted">
        무신사 앱 상품 화면 스크린샷을 고르면 바로 읽습니다. 한 화면에 가격이 안 보이면 위/아래 두 장을
        같이 선택하세요 (최대 {MAX_IMAGES}장). 올리는 순간 가격이 기록됩니다.
      </p>

      {status.kind === "done" && (
        <div className="mt-3 rounded-md bg-ok/10 px-3 py-2 text-sm text-ok">
          <div>✅ {status.message}</div>
          {status.detail && <pre className="mt-1 whitespace-pre-wrap font-sans text-xs">{status.detail}</pre>}
        </div>
      )}
      {status.kind === "error" && (
        <p className="mt-3 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">⚠️ {status.message}</p>
      )}

      <button
        type="button"
        onClick={() => setManualOpen((v) => !v)}
        className="mt-3 text-xs font-medium text-honey hover:underline"
      >
        {manualOpen ? "직접 입력 닫기" : "✏️ 직접 입력으로 카드 만들기"}
      </button>
      {manualOpen && (
        <div className="mt-3 border-t border-line pt-4">
          <DealForm onCreated={() => setManualOpen(false)} />
        </div>
      )}
    </section>
  );
}
