import Link from "next/link";

export function Brand({ tone = "default" }: { tone?: "default" | "inverse" }) {
  return (
    <Link
      className="tw:group tw:relative tw:z-[2] tw:inline-flex tw:items-center tw:gap-2.5 tw:font-semibold tw:tracking-[-0.025em] tw:data-[tone=inverse]:text-chrome-foreground"
      data-tone={tone}
      href="/settings"
      aria-label="DopeDB workspace home"
    >
      <svg
        className="tw:size-7 tw:text-primary tw:group-data-[tone=inverse]:text-signal"
        viewBox="0 0 28 28"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M4 6.5h11.25c5.1 0 8.75 3.28 8.75 7.5s-3.65 7.5-8.75 7.5H4V6.5Z"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path d="M4 11h12M4 16h9" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="20.5" cy="18.5" r="2.25" fill="currentColor" />
      </svg>
      <span className="tw:text-[16px]">DopeDB</span>
      <small className="tw:ml-1 tw:border-l tw:border-border tw:pl-3 tw:font-mono tw:text-2xs tw:font-medium tw:tracking-[0.09em] tw:text-muted-foreground tw:uppercase tw:group-data-[tone=inverse]:border-chrome-border tw:group-data-[tone=inverse]:text-chrome-muted">
        Workspace
      </small>
    </Link>
  );
}
