import { Tooltip } from "../design-system/components/Tooltip";
import { Icon } from "./Icon";

export default function InfoTip({
  label,
}: {
  label: string;
}) {
  return (
    <Tooltip label={label}>
      <span
        className="tw:inline-flex tw:size-5 tw:shrink-0 tw:cursor-help tw:items-center tw:justify-center tw:rounded-full tw:border tw:border-border-subtle tw:bg-background tw:text-ui tw:font-bold tw:leading-none tw:text-muted-foreground tw:hover:bg-muted tw:hover:text-foreground tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring/30 tw:[&_.icon]:text-ui"
        aria-label={label}
        role="img"
        tabIndex={0}
      >
        <Icon name="info" />
      </span>
    </Tooltip>
  );
}
