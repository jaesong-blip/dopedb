// Placeholder bars for a first load that has no cached data to show yet. Revisits paint
// from the query cache, so this should only ever appear on a genuinely cold surface.
// The 200ms reveal delay lives in CSS: a fast response unmounts this before it is visible.
import { useI18n } from "../lib/i18n";

export default function Skeleton({
  lines = 3,
  inset = false,
}: {
  lines?: number;
  inset?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      data-inset={inset || undefined}
      className="tw:flex tw:w-full tw:flex-col tw:gap-3 tw:py-2 tw:data-[inset=true]:p-4"
      role="status"
      aria-busy="true"
      aria-label={t("common.loading")}
    >
      {Array.from({ length: lines }, (_, i) => (
        <span
          key={i}
          data-width={i % 3 === 1 ? "medium" : i % 3 === 2 ? "short" : "full"}
          className="tw:h-[14px] tw:w-full tw:rounded-xs tw:bg-[linear-gradient(90deg,var(--ds-surface-2)_25%,var(--ds-surface-1)_37%,var(--ds-surface-2)_63%)] tw:bg-[length:400%_100%] tw:opacity-0 tw:animate-[skeleton-reveal_160ms_ease-out_200ms_forwards,skeleton-shimmer_1400ms_ease-in-out_200ms_infinite] tw:data-[width=medium]:w-[82%] tw:data-[width=short]:w-[64%] tw:motion-reduce:bg-secondary tw:motion-reduce:animate-[skeleton-reveal_0s_linear_200ms_forwards]"
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
