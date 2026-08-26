"use client";

import { useState } from "react";
import { DealForm } from "./DealForm";
import { DealEntry } from "./DealEntry";
import type { DealDTO } from "@/lib/api-types";

export function DealWorkspace({ initialDeals }: { initialDeals: DealDTO[] }) {
  const [deals, setDeals] = useState<DealDTO[]>(initialDeals);

  return (
    <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 p-6 lg:grid-cols-[380px_1fr]">
      <aside className="lg:sticky lg:top-6 lg:self-start">
        <div className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 text-sm font-semibold">딜 입력</h2>
          <DealForm onCreated={(deal) => setDeals((prev) => [deal, ...prev])} />
        </div>
      </aside>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-muted">
          최근 딜 {deals.length > 0 && `(${deals.length})`}
        </h2>
        {deals.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">
            아직 생성된 딜이 없습니다. 왼쪽 폼에 상품 정보를 입력해 첫 카드를 만들어보세요.
          </p>
        ) : (
          deals.map((deal) => <DealEntry key={deal.id} deal={deal} />)
        )}
      </section>
    </div>
  );
}
