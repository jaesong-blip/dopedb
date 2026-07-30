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
      className="tw:mt-4 tw:mb-0 tw:border-l-2 tw:border-primary tw:bg-primary/10 tw:px-4 tw:py-3 tw:text-xs tw:leading-body tw:text-[var(--ds-text-secondary)] tw:data-[tone=danger]:border-danger tw:data-[tone=danger]:bg-danger/10 tw:data-[tone=danger]:text-danger"
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
    <header className="tw:mb-6 tw:flex tw:items-end tw:justify-between tw:gap-4 tw:max-[800px]:block">
      <div className="tw:flex tw:items-baseline tw:gap-3">
        <span className="tw:font-mono tw:text-xs tw:text-primary">
          {index}
        </span>
        <h2 className="tw:m-0 tw:font-serif tw:text-[27px] tw:font-normal">
          {title}
        </h2>
      </div>
      <p className="tw:m-0 tw:max-w-[350px] tw:text-sm tw:text-muted-foreground tw:max-[800px]:mt-2">
        {children}
      </p>
    </header>
  );
}
