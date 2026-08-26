"use client";

import { useState, type FormEvent } from "react";
import type { ColorLinkInput, CreateDealInput, DealDTO } from "@/lib/api-types";

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

export function DealForm({ onCreated }: { onCreated: (deal: DealDTO) => void }) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [colorLinks, setColorLinks] = useState<ColorLinkInput[]>([]);
  const [useAiHook, setUseAiHook] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function addColorLink() {
    setColorLinks((links) => [...links, { label: "", url: "" }]);
  }
  function updateColorLink(i: number, field: keyof ColorLinkInput, value: string) {
    setColorLinks((links) =>
      links.map((l, idx) => (idx === i ? { ...l, [field]: value } : l))
    );
  }
  function removeColorLink(i: number) {
    setColorLinks((links) => links.filter((_, idx) => idx !== i));
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
      useAiHook,
      defaultLinkUrl: form.defaultLinkUrl || undefined,
      colorLinks: colorLinks.filter((l) => l.url.trim()),
    };

    try {
      const res = await fetch("/api/deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "카드 생성에 실패했습니다.");
        return;
      }
      onCreated(json.deal as DealDTO);
      setForm(EMPTY_FORM);
      setColorLinks([]);
    } catch {
      setError("서버에 연결할 수 없습니다.");
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

      <Field label="상품 URL *">
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

      <Field label="대표 큐레이터 링크">
        <input
          type="url"
          value={form.defaultLinkUrl}
          onChange={(e) => set("defaultLinkUrl", e.target.value)}
          placeholder="큐레이터센터에서 생성한 링크를 붙여넣기"
          className={inputCls}
        />
      </Field>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-medium text-muted">색상별 링크 (선택)</span>
          <button
            type="button"
            onClick={addColorLink}
            className="text-xs font-medium text-honey hover:underline"
          >
            + 색상 추가
          </button>
        </div>
        <div className="flex flex-col gap-2">
          {colorLinks.map((cl, i) => (
            <div key={i} className="flex gap-2">
              <input
                value={cl.label}
                onChange={(e) => updateColorLink(i, "label", e.target.value)}
                placeholder="크림"
                className={`${inputCls} w-24 shrink-0`}
              />
              <input
                type="url"
                value={cl.url}
                onChange={(e) => updateColorLink(i, "url", e.target.value)}
                placeholder="색상별 큐레이터 링크"
                className={inputCls}
              />
              <button
                type="button"
                onClick={() => removeColorLink(i)}
                className="shrink-0 rounded-md px-2 text-sm text-danger hover:bg-danger/10"
                aria-label="색상 링크 삭제"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      <Field label="훅 문구 (비워두면 AI 초안)">
        <textarea
          value={form.hookLine}
          onChange={(e) => set("hookLine", e.target.value)}
          rows={2}
          placeholder="이 가격에 S부터 품절각"
          className={`${inputCls} resize-none`}
        />
      </Field>

      <label className="flex items-center gap-2 text-sm text-muted">
        <input
          type="checkbox"
          checked={useAiHook}
          onChange={(e) => setUseAiHook(e.target.checked)}
          className="h-4 w-4 rounded border-line"
        />
        훅이 비어있으면 AI 초안 시도 (실패해도 정상 진행됩니다)
      </label>

      {error && (
        <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="rounded-md bg-honey px-4 py-2.5 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {submitting ? "카드 생성 중…" : "카드 생성"}
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-md border border-line bg-background px-2.5 py-1.5 text-sm outline-none focus:border-honey";
