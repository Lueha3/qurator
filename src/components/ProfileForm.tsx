"use client";

import { useState, useTransition, type FormEvent } from "react";
import { updateProfileAction } from "@/app/actions";
import { MAX_BIO_LENGTH } from "@/lib/profile";
import { Field, inputCls, primaryBtnCls } from "./form";

// 프로필 — 허브 한 줄 소개와 큐레이션 샵 주소. 둘 다 공개 지면에 실리므로
// 저장은 서버(profile.ts)가 한 번 더 검증한다(무신사 https 주소만 통과).

export function ProfileForm({
  bio,
  curatorShopUrl,
}: {
  bio: string | null;
  curatorShopUrl: string | null;
}) {
  const [form, setForm] = useState({ bio: bio ?? "", curatorShopUrl: curatorShopUrl ?? "" });
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const result = await updateProfileAction(form);
      setMessage(
        result.ok
          ? { tone: "ok", text: "저장했습니다. 링크허브에 바로 반영됩니다." }
          : { tone: "error", text: result.reason }
      );
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <Field label={`허브 한 줄 소개 (${form.bio.length}/${MAX_BIO_LENGTH})`}>
        <input
          value={form.bio}
          maxLength={MAX_BIO_LENGTH}
          onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
          placeholder="매일 무신사에서 건진 꿀매만 모읍니다"
          className={inputCls}
        />
      </Field>
      <Field label="큐레이션 샵 주소">
        <input
          type="url"
          value={form.curatorShopUrl}
          onChange={(e) => setForm((f) => ({ ...f, curatorShopUrl: e.target.value }))}
          placeholder="https://www.musinsa.com/curator/s/닉네임"
          className={inputCls}
        />
      </Field>
      {message && (
        <p className={`rounded-md px-3 py-2 text-sm ${message.tone === "ok" ? "bg-accent-soft text-accent" : "bg-danger/10 text-danger"}`}>
          {message.text}
        </p>
      )}
      <button type="submit" disabled={pending} className={primaryBtnCls}>
        {pending ? "저장 중…" : "프로필 저장"}
      </button>
    </form>
  );
}
