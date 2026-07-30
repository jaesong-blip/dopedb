import Link from "next/link";

export function Brand() {
  return (
    <Link
      className="tw:relative tw:z-[2] tw:inline-flex tw:items-center tw:gap-2.5 tw:font-bold tw:tracking-[-0.03em]"
      href="/settings"
      aria-label="DopeDB workspace home"
    >
      <span
        className="tw:grid tw:size-[25px] tw:rotate-45 tw:place-content-center tw:border tw:border-primary"
        aria-hidden="true"
      >
        <i className="tw:m-px tw:block tw:h-px tw:w-[11px] tw:bg-primary" />
        <i className="tw:m-px tw:block tw:h-px tw:w-[11px] tw:bg-primary" />
        <i className="tw:m-px tw:block tw:h-px tw:w-[11px] tw:bg-primary" />
      </span>
      <span>DopeDB</span>
      <small className="tw:ml-1 tw:border-l tw:border-border tw:pl-3 tw:font-mono tw:text-xs tw:font-medium tw:tracking-[0.08em] tw:text-muted-foreground tw:uppercase">
        Workspace
      </small>
    </Link>
  );
}
