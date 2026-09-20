"use client";

import { useState, useTransition, type FormEvent } from "react";
import { updateFactsAction, type FactsFormInput } from "@/app/actions";
import type { DealDTO } from "@/lib/api-types";
import { MAX_TAGS, formatTagInput } from "@/lib/deal-tags";
import { Field, inputCls, primaryBtnCls, secondaryBtnCls } from "./form";

/** ISO → datetime-local 입력값(로컬 시각, 초 없음) */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** [✏️ 정보 고치기] — Vision이 잘못 읽은 값을 바로잡는다. 카드가 이미 있으면 서버가 새 버전으로 다시 렌더한다. */
export function DealEditForm({ deal, onClose }: { deal: DealDTO; onClose: () => void }) {
  const [form, setForm] = useState<FactsFormInput>({
    brand: deal.brand.startsWith("(") ? "" : deal.brand,
    productName: deal.productName.startsWith("(") ? "" : deal.productName,
    styleCode: deal.styleCode ?? "",
    productUrl: deal.canonicalUrl.startsWith("screenshot-pending:") ? "" : deal.canonicalUrl,
    listPrice: deal.listPrice > 0 ? String(deal.listPrice) : "",
    salePrice: deal.salePrice != null ? String(deal.salePrice) : "",
    discountRate: deal.discountRate != null ? String(deal.discountRate) : "",
    couponCode: deal.couponCode ?? "",
    couponDesc: deal.couponDesc ?? "",
    finalPrice: deal.finalPrice != null ? String(deal.finalPrice) : "",
    endsAt: toLocalInput(deal.endsAt),
    curatorNote: deal.curatorNote ?? "",
    hookLine: deal.hookLine ?? "",
    tags: formatTagInput(deal.tags),
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function set<K extends keyof FactsFormInput>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await updateFactsAction(deal.id, form);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      onClose();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 flex flex-col gap-3 rounded-lg border border-line bg-paper p-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="브랜드">
          <input value={form.brand} onChange={(e) => set("brand", e.target.value)} placeholder="쿠어" className={inputCls} />
        </Field>
        <Field label="품번">
          <input value={form.styleCode} onChange={(e) => set("styleCode", e.target.value)} placeholder="CO-123" className={inputCls} />
        </Field>
      </div>
      <Field label="상품명">
        <input value={form.productName} onChange={(e) => set("productName", e.target.value)} placeholder="오버핏 맨투맨" className={inputCls} />
      </Field>
      <Field label="상품 주소" hint="내 링크 말고 상품 주소예요">
        <input
          type="url"
          value={form.productUrl}
          onChange={(e) => set("productUrl", e.target.value)}
          placeholder="https://www.musinsa.com/products/1234567"
          className={inputCls}
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="정가">
          <input inputMode="numeric" value={form.listPrice} onChange={(e) => set("listPrice", e.target.value)} placeholder="89000" className={inputCls} />
        </Field>
        <Field label="할인가">
          <input inputMode="numeric" value={form.salePrice} onChange={(e) => set("salePrice", e.target.value)} placeholder="53400" className={inputCls} />
        </Field>
        <Field label="할인율(%)">
          <input inputMode="numeric" value={form.discountRate} onChange={(e) => set("discountRate", e.target.value)} placeholder="40" className={inputCls} />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="쿠폰 코드">
          <input value={form.couponCode} onChange={(e) => set("couponCode", e.target.value)} className={inputCls} />
        </Field>
        <Field label="쿠폰 설명">
          <input value={form.couponDesc} onChange={(e) => set("couponDesc", e.target.value)} placeholder="큐레이터 전용 10%" className={inputCls} />
        </Field>
        <Field label="쿠폰 적용가">
          <input inputMode="numeric" value={form.finalPrice} onChange={(e) => set("finalPrice", e.target.value)} className={inputCls} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="마감 시각">
          <input type="datetime-local" value={form.endsAt} onChange={(e) => set("endsAt", e.target.value)} className={inputCls} />
        </Field>
        <Field label="사이즈 코멘트">
          <input value={form.curatorNote} onChange={(e) => set("curatorNote", e.target.value)} placeholder="168/62 M 정사이즈" className={inputCls} />
        </Field>
      </div>
      <Field label="첫 줄 문구">
        <input value={form.hookLine} onChange={(e) => set("hookLine", e.target.value)} placeholder="이 가격에 S부터 품절각" className={inputCls} />
      </Field>
      <Field label="팔로워 페이지 묶음" hint={`쉼표로 구분, 최대 ${MAX_TAGS}개. 비우면 “오늘의 꿀매”에 들어가요`}>
        <input value={form.tags} onChange={(e) => set("tags", e.target.value)} placeholder="가을 아우터, BF 픽" className={inputCls} />
      </Field>

      {error && <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

      <div className="flex gap-2">
        <button type="button" onClick={onClose} className={secondaryBtnCls}>
          취소
        </button>
        <button type="submit" disabled={pending} className={`${primaryBtnCls} flex-1`}>
          {pending ? "저장 중…" : "저장"}
        </button>
      </div>
    </form>
  );
}
