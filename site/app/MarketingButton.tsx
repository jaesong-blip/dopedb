import type { AnchorHTMLAttributes, ReactNode } from "react";
import {
  TrackedLink,
  type TrackedLinkTrackingProps,
} from "./TrackedLink";

type MarketingButtonProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  children: ReactNode;
  variant: "primary" | "secondary";
} & TrackedLinkTrackingProps;

export function MarketingButton({
  children,
  variant,
  ...props
}: MarketingButtonProps) {
  return (
    <TrackedLink
      {...props}
      data-variant={variant}
      className="tw:group tw:inline-flex tw:min-h-[52px] tw:items-center tw:justify-center tw:gap-3 tw:border tw:border-hairline-strong tw:px-5 tw:py-3 tw:font-mono tw:text-[12px] tw:leading-none tw:font-semibold tw:tracking-[0.08em] tw:uppercase tw:transition-[transform,box-shadow,background-color,border-color,color] tw:duration-200 tw:hover:-translate-y-0.5 tw:focus-visible:outline-electric tw:max-[620px]:w-full tw:data-[variant=primary]:border-signal tw:data-[variant=primary]:bg-signal tw:data-[variant=primary]:text-night tw:data-[variant=primary]:shadow-signal tw:data-[variant=primary]:hover:bg-signal-strong tw:data-[variant=secondary]:bg-transparent tw:data-[variant=secondary]:text-cream tw:data-[variant=secondary]:hover:border-cream/55 tw:data-[variant=secondary]:hover:bg-cream/5 tw:[&_svg]:transition-transform tw:[&_svg]:duration-200 tw:hover:[&_svg]:translate-x-0.5"
    >
      {children}
    </TrackedLink>
  );
}
