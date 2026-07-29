import { Icon } from "./Icon";

export default function InfoTip({
  label,
}: {
  label: string;
}) {
  return (
    <span
      className="ui-help"
      title={label}
      aria-label={label}
      role="img"
    >
      <Icon name="info" />
    </span>
  );
}
