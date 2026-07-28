// Tailwind-only layout contract shared by the live setup flow and its visual
// fixture. Semantic controls still come from the canonical design primitives.
export const skillSetupStyles = {
  panel:
    "tw:my-4 tw:min-w-0 tw:border-y tw:border-border-strong tw:py-4",
  panelHead:
    "tw:flex tw:items-center tw:justify-between tw:gap-3",
  panelHeadContent: "tw:min-w-0",
  kicker:
    "tw:mb-1 tw:block tw:text-xs tw:leading-body tw:font-semibold tw:tracking-[0.06em] tw:text-muted-foreground tw:uppercase",
  title:
    "tw:m-0 tw:text-title tw:leading-ui tw:font-bold tw:tracking-[0.05em] tw:text-foreground tw:uppercase",
  summary: "tw:mt-2 tw:mb-0",
  command:
    "tw:mt-3 tw:flex tw:min-w-0 tw:items-center tw:gap-2 tw:rounded-sm tw:border tw:border-border-subtle tw:bg-background tw:py-2 tw:pr-2 tw:pl-3 tw:@max-[520px]:items-stretch",
  commandCode:
    "tw:min-w-0 tw:flex-1 tw:overflow-x-auto tw:whitespace-nowrap tw:text-ui tw:text-foreground tw:[scrollbar-width:thin]",
  fixedControl: "tw:shrink-0",
  safety:
    "tw:mt-2 tw:mb-0 tw:flex tw:items-center tw:gap-2 tw:text-xs tw:leading-body tw:text-muted-foreground",
  safetyIcon: "tw:size-[var(--ds-icon-sm)] tw:shrink-0",
  terminal:
    "tw:relative tw:mt-3 tw:grid tw:h-[264px] tw:min-w-0 tw:grid-rows-[var(--ds-control-lg)_minmax(0,1fr)] tw:overflow-hidden tw:rounded-md tw:border tw:border-border-strong tw:bg-background tw:@max-[520px]:h-[236px]",
  terminalHead:
    "tw:flex tw:items-center tw:justify-between tw:gap-2 tw:border-b tw:border-border-subtle tw:pr-1 tw:pl-3 tw:text-xs tw:text-muted-foreground",
  terminalHeadText: "tw:m-0",
  terminalError:
    "tw:absolute tw:z-[var(--ds-z-base)] tw:mx-2 tw:mt-[calc(var(--ds-control-lg)+var(--ds-space-2))]",
  terminalLoading: "tw:grid tw:place-items-center tw:p-4",
  terminalSurface: "tw:h-full tw:p-2",
} as const;
