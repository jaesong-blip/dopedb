// Tailwind layout utilities for Agent tools. State and control appearance remain
// canonical .badge/.btn primitives so action semantics stay centralized.
export const agentToolsStyles = {
  root: "tw:max-w-[800px]",
  version: "tw:mt-1 tw:mb-4",
  list:
    "tw:mt-3 tw:divide-y tw:divide-border-subtle tw:border-y tw:border-border-subtle",
  target: "tw:py-4",
  targetHead:
    "tw:flex tw:items-center tw:justify-between tw:gap-4 tw:@max-[520px]:flex-col tw:@max-[520px]:items-start tw:@max-[520px]:gap-2",
  targetIdentity: "tw:flex tw:min-w-0 tw:items-center tw:gap-2",
  targetTitle:
    "tw:m-0 tw:text-title tw:leading-ui tw:font-bold tw:tracking-normal tw:text-foreground tw:normal-case",
  cliState:
    "tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-2 tw:text-ui tw:text-muted-foreground tw:@max-[520px]:justify-start",
  metaDot: "tw:text-muted-foreground",
  details: "tw:mt-3 tw:mb-0 tw:grid tw:gap-2",
  detailsRow:
    "tw:grid tw:grid-cols-[minmax(120px,0.3fr)_minmax(0,1fr)] tw:gap-3 tw:@max-[520px]:grid-cols-[minmax(0,1fr)] tw:@max-[520px]:gap-1",
  detailsTerm: "tw:text-muted-foreground",
  detailsValue: "tw:m-0 tw:min-w-0",
  breakAnywhere: "tw:[overflow-wrap:anywhere]",
  targetMessage: "tw:mt-2",
  conflictTitle: "tw:mt-2 tw:font-semibold tw:text-foreground",
  conflict:
    "tw:mt-2 tw:flex tw:items-baseline tw:gap-2 tw:@max-[520px]:flex-col tw:@max-[520px]:items-start tw:@max-[520px]:gap-1",
  actions:
    "tw:mt-3 tw:flex tw:flex-wrap tw:items-center tw:gap-[var(--ds-control-gap)]",
  legacy:
    "tw:border-t tw:border-border-subtle tw:pt-5 tw:pb-2",
  sectionHead:
    "tw:flex tw:items-center tw:justify-between tw:gap-4 tw:@max-[520px]:flex-col tw:@max-[520px]:items-start",
  sectionHeadContent:
    "tw:flex tw:min-w-0 tw:flex-col tw:items-start tw:gap-1",
  sectionHeading: "tw:m-0",
  cleanupList:
    "tw:mt-3 tw:divide-y tw:divide-border-subtle tw:border-y tw:border-border-subtle",
  cleanupTarget: "tw:grid tw:gap-1 tw:py-3",
  cleanupIdentity: "tw:flex tw:items-center tw:gap-2",
  footer:
    "tw:mt-4 tw:flex tw:flex-wrap tw:items-center tw:gap-[var(--ds-control-gap)]",
} as const;
