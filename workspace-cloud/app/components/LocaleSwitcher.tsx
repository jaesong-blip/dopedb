"use client";

import { Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { localizedWorkspacePath } from "../../lib/workspace-locale";
import { useWorkspaceLocale } from "./WorkspaceLocale";

function LocaleSwitcherLink({ tone }: { tone: "default" | "inverse" }) {
  const locale = useWorkspaceLocale();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const targetLocale = locale === "ko" ? "en" : "ko";
  const nextSearchParams = new URLSearchParams(searchParams.toString());
  nextSearchParams.delete("lang");
  const query = nextSearchParams.toString();
  const currentPath = `${pathname}${query ? `?${query}` : ""}`;
  const href = localizedWorkspacePath(currentPath, targetLocale);

  return (
    <a
      className="tw:inline-flex tw:h-control-sm tw:min-w-10 tw:items-center tw:justify-center tw:rounded-control tw:border tw:border-border tw:bg-surface/80 tw:px-2.5 tw:font-mono tw:text-2xs tw:font-semibold tw:text-muted-foreground tw:backdrop-blur tw:transition-colors tw:hover:border-primary tw:hover:text-foreground tw:data-[tone=inverse]:border-chrome-border tw:data-[tone=inverse]:bg-chrome-foreground/5 tw:data-[tone=inverse]:text-chrome-muted tw:data-[tone=inverse]:hover:border-signal tw:data-[tone=inverse]:hover:text-chrome-foreground"
      data-tone={tone}
      href={href}
      hrefLang={targetLocale}
      aria-label={targetLocale === "ko" ? "한국어로 보기" : "View in English"}
    >
      {targetLocale === "ko" ? "KO" : "EN"}
    </a>
  );
}

export function LocaleSwitcher({
  tone = "default",
}: {
  tone?: "default" | "inverse";
}) {
  return (
    <Suspense
      fallback={(
        <span
          className="tw:inline-flex tw:h-control-sm tw:min-w-10 tw:items-center tw:justify-center tw:rounded-control tw:border tw:border-border tw:px-2.5 tw:font-mono tw:text-2xs tw:text-muted-foreground"
          aria-hidden="true"
        >
          ··
        </span>
      )}
    >
      <LocaleSwitcherLink tone={tone} />
    </Suspense>
  );
}
