"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { CreateDealInput, DealDTO } from "@/lib/api-types";
import { Field, inputCls, primaryBtnCls } from "./form";

const EMPTY_FORM = {
  brand: "",
  productName: "",
  styleCode: "",
  canonicalUrl: "",
  listPrice: "",
  salePrice: "",
  discountRate: "",
  couponCode: "",
  couponDesc: "",
  finalPrice: "",
  endsAt: "",
  curatorNote: "",
  hookLine: "",
  defaultLinkUrl: "",
};

type FormState = typeof EMPTY_FORM;

function toNumberOrUndefined(v: string): number | undefined {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function DealForm({ onCreated }: { onCreated?: (deal: DealDTO) => void }) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }


  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const payload: CreateDealInput = {
      brand: form.brand,
      productName: form.productName,
      styleCode: form.styleCode || undefined,
      canonicalUrl: form.canonicalUrl,
      listPrice: Number(form.listPrice),
      salePrice: toNumberOrUndefined(form.salePrice),
      discountRate: toNumberOrUndefined(form.discountRate),
      couponCode: form.couponCode || undefined,
      couponDesc: form.couponDesc || undefined,
      finalPrice: toNumberOrUndefined(form.finalPrice),
      endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : undefined,
      curatorNote: form.curatorNote || undefined,
      hookLine: form.hookLine || undefined,
      useAiHook: true, // 첫 줄이 비어 있으면 AI가 초안을 쓴다 — 실패해도 진행된다(ai-hook)
      defaultLinkUrl: form.defaultLinkUrl || undefined,
      colorLinks: [],
    };

    try {
      const res = await fetch("/api/deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "만들지 못했어요. 다시 해보세요.");
        return;
      }
      setForm(EMPTY_FORM);
      // 목록은 서버가 그린다 — 새로 읽어 오면 방금 만든 딜이 '진행 중' 맨 위에 온다.
      router.refresh();
      onCreated?.(json.deal as DealDTO);
    } catch {
      setError("인터넷을 확인해주세요.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="브랜드 *">
          <input
            required
            value={form.brand}
            onChange={(e) => set("brand", e.target.value)}
            placeholder="쿠어"
            className={inputCls}
          />
        </Field>
        <Field label="품번">
          <input
            value={form.styleCode}
            onChange={(e) => set("styleCode", e.target.value)}
            placeholder="CO-123"
            className={inputCls}
          />
        </Field>
      </div>

      <Field label="상품명 *">
        <input
          required
          value={form.productName}
          onChange={(e) => set("productName", e.target.value)}
          placeholder="오버핏 맨투맨"
          className={inputCls}
        />
      </Field>

      <Field label="상품 주소 *">
        <input
          required
          type="url"
          value={form.canonicalUrl}
          onChange={(e) => set("canonicalUrl", e.target.value)}
          placeholder="https://www.musinsa.com/products/1234567"
          className={inputCls}
        />
      </Field>

      <div className="grid grid-cols-3 gap-3">
        <Field label="정가 *">
          <input
            required
            type="number"
            min={0}
            value={form.listPrice}
            onChange={(e) => set("listPrice", e.target.value)}
            placeholder="89000"
            className={inputCls}
          />
        </Field>
        <Field label="할인가">
          <input
            type="number"
            min={0}
            value={form.salePrice}
            onChange={(e) => set("salePrice", e.target.value)}
            placeholder="53400"
            className={inputCls}
          />
        </Field>
        <Field label="할인율(%)">
          <input
            type="number"
            min={0}
            max={100}
            value={form.discountRate}
            onChange={(e) => set("discountRate", e.target.value)}
            placeholder="40"
            className={inputCls}
          />
        </Field>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Field label="쿠폰 코드">
          <input
            value={form.couponCode}
            onChange={(e) => set("couponCode", e.target.value)}
            placeholder="HONEY10"
            className={inputCls}
          />
        </Field>
        <Field label="쿠폰 설명">
          <input
            value={form.couponDesc}
            onChange={(e) => set("couponDesc", e.target.value)}
            placeholder="큐레이터 전용 10%"
            className={inputCls}
          />
        </Field>
        <Field label="쿠폰 적용가">
          <input
            type="number"
            min={0}
            value={form.finalPrice}
            onChange={(e) => set("finalPrice", e.target.value)}
            placeholder="48060"
            className={inputCls}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="마감 시각">
          <input
            type="datetime-local"
            value={form.endsAt}
            onChange={(e) => set("endsAt", e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="사이즈 코멘트">
          <input
            value={form.curatorNote}
            onChange={(e) => set("curatorNote", e.target.value)}
            placeholder="168/62 M 정사이즈"
            className={inputCls}
          />
        </Field>
      </div>

      <Field label="내 링크 (있으면)">
        <input
          type="url"
          value={form.defaultLinkUrl}
          onChange={(e) => set("defaultLinkUrl", e.target.value)}
          placeholder="큐레이터센터에서 만든 링크 붙여넣기"
          className={inputCls}
        />
      </Field>

      <Field label="첫 줄 문구" hint="비우면 AI가 초안을 써요">
        <textarea
          value={form.hookLine}
          onChange={(e) => set("hookLine", e.target.value)}
          rows={2}
          placeholder="이 가격에 S부터 품절각"
          className={`${inputCls} resize-none`}
        />
      </Field>


      {error && (
        <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className={primaryBtnCls}
      >
        {submitting ? "만드는 중…" : "✅ 만들기"}
      </button>
    </form>
  );
}
