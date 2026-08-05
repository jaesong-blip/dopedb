import type { ReactNode } from "react";

export function ConsoleNotice({
  tone = "success",
  children,
}: {
  tone?: "danger" | "success";
  children: ReactNode;
}) {
  return (
    <p
      data-tone={tone}
      className="tw:mt-5 tw:mb-0 tw:rounded-surface tw:border tw:border-primary/20 tw:bg-selection tw:px-4 tw:py-3.5 tw:text-xs tw:leading-body tw:text-[var(--ds-text-secondary)] tw:data-[tone=danger]:border-danger/25 tw:data-[tone=danger]:bg-danger/5 tw:data-[tone=danger]:text-danger"
      role={tone === "danger" ? "alert" : "status"}
    >
      {children}
    </p>
  );
}

export function ConsoleSectionHeading({
  index,
  title,
  children,
}: {
  index: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <header className="tw:mb-7 tw:grid tw:grid-cols-[minmax(0,1fr)_minmax(240px,0.72fr)] tw:items-end tw:gap-8 tw:max-[800px]:grid-cols-1 tw:max-[800px]:gap-3">
      <div className="tw:flex tw:items-center tw:gap-4">
        <span className="tw:grid tw:size-9 tw:shrink-0 tw:place-items-center tw:rounded-full tw:border tw:border-primary/20 tw:bg-selection tw:font-mono tw:text-2xs tw:font-medium tw:text-primary">
          {index}
        </span>
        <h2 className="tw:m-0 tw:font-serif tw:text-[clamp(28px,3vw,38px)] tw:leading-[1.05] tw:font-normal tw:tracking-[-0.035em]">
          {title}
        </h2>
      </div>
      <p className="tw:m-0 tw:max-w-[520px] tw:text-xs tw:leading-[1.7] tw:text-muted-foreground">
        {children}
      </p>
    </header>
  );
}
