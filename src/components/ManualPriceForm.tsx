"use client";

import { useState, useTransition, type FormEvent } from "react";
import { manualPriceAction } from "@/app/actions";
import { formatKRW } from "@/lib/format";
import { Field, inputCls, primaryBtnCls } from "./form";

export interface ProductOption {
  id: string;
  label: string;
}

/** 작년 BF 가격 수동 입력 — 자동으로는 복원 불가능한 과거 가격의 유일한 입력 경로 (docs/05 §2(a)) */
export function ManualPriceForm({ products }: { products: ProductOption[] }) {
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [salePrice, setSalePrice] = useState("");
  const [listPrice, setListPrice] = useState("");
  const [couponPrice, setCouponPrice] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const r = await manualPriceAction({ productId, salePrice, listPrice, couponPrice });
      if (!r.ok) {
        setMessage({ tone: "error", text: r.reason });
        return;
      }
      const parts = [`판매가 ${formatKRW(r.salePrice)}`];
      if (r.listPrice) parts.push(`정가 ${formatKRW(r.listPrice)}`);
      if (r.rate !== null) parts.push(`할인율 ${r.rate}%`);
      if (r.couponPrice) {
        parts.push(`쿠폰가 ${formatKRW(r.couponPrice)}${r.couponRate !== null ? ` (${r.couponRate}%)` : ""}`);
      }
      setMessage({ tone: "ok", text: `📌 저장했어요 — ${r.productLabel} · ${parts.join(" · ")}` });
      setSalePrice("");
      setListPrice("");
      setCouponPrice("");
    });
  }

  if (products.length === 0) {
    return <p className="text-sm text-ink-soft">아직 상품이 없어요. 스크린샷을 먼저 올려주세요.</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <Field label="상품">
        <select value={productId} onChange={(e) => setProductId(e.target.value)} className={inputCls}>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      {/* 라벨을 짧게 둔다 — 폰 폭(390px) 3열에서 설명을 라벨에 넣으면 줄이 밀려 입력칸이 어긋난다 */}
      <div className="grid grid-cols-3 gap-3">
        <Field label="판매가 *">
          <input inputMode="numeric" required value={salePrice} onChange={(e) => setSalePrice(e.target.value)} placeholder="39900" className={inputCls} />
        </Field>
        <Field label="정가">
          <input inputMode="numeric" value={listPrice} onChange={(e) => setListPrice(e.target.value)} placeholder="89000" className={inputCls} />
        </Field>
        <Field label="쿠폰가">
          <input inputMode="numeric" value={couponPrice} onChange={(e) => setCouponPrice(e.target.value)} placeholder="37900" className={inputCls} />
        </Field>
      </div>
      <p className="-mt-1 text-xs text-ink-soft">작년 블프 때 값이에요. 정가·쿠폰가는 비워도 돼요.</p>
      {message && (
        <p className={`rounded-md px-3 py-2 text-sm ${message.tone === "ok" ? "bg-accent-soft text-accent" : "bg-danger/10 text-danger"}`}>
          {message.text}
        </p>
      )}
      <button type="submit" disabled={pending} className={primaryBtnCls}>
        {pending ? "저장 중…" : "💾 작년 가격 저장"}
      </button>
    </form>
  );
}
