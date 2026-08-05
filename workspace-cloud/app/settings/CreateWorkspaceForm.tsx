"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ControlButton,
  ControlInput,
} from "../components/Controls";

export function CreateWorkspaceForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    const response = await fetch("/api/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    setPending(false);
    if (!response?.ok) {
      const body = await response?.json().catch(() => null);
      setError(body?.error ?? "워크스페이스를 만들지 못했습니다.");
      return;
    }
    setName("");
    router.refresh();
  }

  return (
    <form
      className="tw:sticky tw:top-[148px] tw:relative tw:grid tw:gap-4 tw:overflow-hidden tw:rounded-panel tw:border tw:border-border tw:bg-surface tw:p-6 tw:shadow-panel tw:before:absolute tw:before:top-0 tw:before:left-0 tw:before:h-1 tw:before:w-full tw:before:bg-signal tw:before:content-[''] tw:max-[980px]:static"
      onSubmit={submit}
    >
      <header className="tw:grid tw:gap-2">
        <span className="tw:font-mono tw:text-2xs tw:font-medium tw:tracking-[0.08em] tw:text-primary tw:uppercase">
          New boundary
        </span>
        <h3 className="tw:font-serif tw:text-[28px] tw:leading-tight tw:font-normal tw:tracking-[-0.03em]">
          새 워크스페이스
        </h3>
        <p className="tw:text-xs tw:leading-[1.65] tw:text-muted-foreground">
          연결과 정책을 공유할 새로운 팀 경계를 만듭니다.
        </p>
      </header>
      <label
        className="tw:font-mono tw:text-2xs tw:font-medium tw:tracking-[0.06em] tw:text-muted-foreground"
        htmlFor="workspace-name"
      >
        워크스페이스 이름
      </label>
      <div className="tw:grid tw:gap-2">
        <ControlInput
          id="workspace-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          placeholder="예: Data Platform"
          required
        />
        <ControlButton
          type="submit"
          tone="primary"
          size="field"
          disabled={pending}
        >
          {pending ? "생성 중" : "워크스페이스 만들기"}
        </ControlButton>
      </div>
      {error ? (
        <small className="tw:text-2xs tw:text-danger">{error}</small>
      ) : null}
    </form>
  );
}
