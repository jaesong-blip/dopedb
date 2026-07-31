import type { AnchorHTMLAttributes, ReactNode } from "react";
import { TrackedLink } from "./TrackedLink";

type MarketingButtonProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  children: ReactNode;
  event?: string;
  properties?: Record<string, string | number | boolean>;
  variant: "primary" | "secondary";
};

export function MarketingButton({
  children,
  variant,
  ...props
}: MarketingButtonProps) {
  return (
    <TrackedLink
      {...props}
      data-variant={variant}
      className="tw:inline-flex tw:min-h-12 tw:items-center tw:justify-center tw:gap-2.5 tw:rounded-md tw:border tw:border-ink/15 tw:px-[18px] tw:py-[13px] tw:text-[15px] tw:font-[780] tw:transition-[transform,box-shadow,background] tw:duration-150 tw:hover:-translate-y-px tw:max-[620px]:w-full tw:data-[variant=primary]:bg-site-black tw:data-[variant=primary]:text-site-white tw:data-[variant=primary]:shadow-button tw:data-[variant=primary]:[&_svg]:text-brand tw:data-[variant=secondary]:bg-site-white/75 tw:data-[variant=secondary]:text-ink tw:data-[variant=secondary]:hover:bg-site-white"
    >
      {children}
    </TrackedLink>
  );
}
