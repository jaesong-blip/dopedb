// Canonical environment badge. Environment is operational state, so production
// receives the destructive role while dev/staging use success/warning roles.
export function EnvironmentBadge({
  environment,
}: {
  environment: string;
}) {
  return (
    <span
      data-environment={environment}
      className="tw:inline-flex tw:shrink-0 tw:items-center tw:rounded-full tw:border tw:border-border-subtle tw:px-1.5 tw:py-px tw:text-xs tw:font-bold tw:tracking-[0.03em] tw:text-muted-foreground tw:uppercase tw:data-[environment=dev]:border-success tw:data-[environment=dev]:text-success tw:data-[environment=staging]:border-warning tw:data-[environment=staging]:text-warning tw:data-[environment=prod]:border-danger tw:data-[environment=prod]:bg-danger tw:data-[environment=prod]:text-destructive-foreground"
    >
      {environment}
    </span>
  );
}
