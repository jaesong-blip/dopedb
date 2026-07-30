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
    <form className="tw:mt-3 tw:grid tw:gap-2 tw:border tw:border-border tw:p-5" onSubmit={submit}>
      <label
        className="tw:font-mono tw:text-2xs tw:uppercase tw:tracking-[0.1em] tw:text-muted-foreground"
        htmlFor="workspace-name"
      >
        새 워크스페이스
      </label>
      <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto]">
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
          {pending ? "생성 중" : "만들기"}
        </ControlButton>
      </div>
      {error ? (
        <small className="tw:text-2xs tw:text-danger">{error}</small>
      ) : null}
    </form>
  );
}
