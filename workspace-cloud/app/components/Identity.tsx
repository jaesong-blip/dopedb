import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
} from "react";

export function IdentitySingleShell({ children }: { children: ReactNode }) {
  return (
    <main className="tw:flex tw:min-h-screen tw:flex-col tw:items-start tw:px-10 tw:py-[30px] tw:max-[800px]:p-[22px]">
      {children}
    </main>
  );
}

export function IdentityCard({
  children,
  density = "default",
  ...props
}: Omit<HTMLAttributes<HTMLElement>, "className"> & {
  children: ReactNode;
  density?: "compact" | "default";
}) {
  return (
    <section
      data-density={density}
      className="tw:relative tw:w-full tw:border tw:border-border tw:bg-surface tw:p-12 tw:before:absolute tw:before:top-[-1px] tw:before:left-[-1px] tw:before:h-px tw:before:w-9 tw:before:bg-primary tw:before:content-[''] tw:data-[density=compact]:p-[34px] tw:max-[800px]:p-7"
      {...props}
    >
      {children}
    </section>
  );
}

export function IdentityEyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="tw:m-0 tw:font-mono tw:text-xs tw:tracking-[0.16em] tw:text-primary">
      {children}
    </p>
  );
}

export function IdentityTitle({ children }: { children: ReactNode }) {
  return (
    <h1 className="tw:my-4 tw:font-serif tw:text-[43px] tw:font-normal tw:tracking-[-0.045em]">
      {children}
    </h1>
  );
}

export function IdentityBody({ children }: { children: ReactNode }) {
  return (
    <p className="tw:text-[14px] tw:leading-[1.7] tw:text-muted-foreground">
      {children}
    </p>
  );
}

export function IdentityError({
  children,
  role = "alert",
}: {
  children: ReactNode;
  role?: string;
}) {
  return (
    <div
      className="tw:mt-5 tw:border tw:border-danger/40 tw:bg-danger/10 tw:p-3 tw:text-ui tw:leading-body tw:text-danger"
      role={role}
    >
      {children}
    </div>
  );
}

export function IdentityPrimaryButton({
  children,
  type = "button",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  children: ReactNode;
}) {
  return (
    <button
      className="tw:mt-7 tw:flex tw:min-h-control-lg tw:w-full tw:cursor-pointer tw:items-center tw:justify-between tw:gap-3 tw:border tw:border-foreground tw:bg-foreground tw:px-4 tw:text-[13px] tw:font-bold tw:text-background tw:transition-colors tw:hover:border-primary-emphasis tw:hover:bg-primary-emphasis tw:hover:text-primary-foreground tw:focus-visible:outline-2 tw:focus-visible:outline-offset-2 tw:focus-visible:outline-ring tw:disabled:cursor-wait tw:disabled:opacity-65"
      type={type}
      {...props}
    >
      {children}
    </button>
  );
}

export function IdentitySecondaryButton({
  children,
  type = "button",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  children: ReactNode;
}) {
  return (
    <button
      className="tw:mt-2 tw:min-h-control-field tw:w-full tw:cursor-pointer tw:border tw:border-border tw:bg-transparent tw:px-3 tw:text-xs tw:text-muted-foreground tw:hover:border-primary tw:hover:text-foreground tw:focus-visible:outline-2 tw:focus-visible:outline-offset-2 tw:focus-visible:outline-ring tw:disabled:cursor-wait tw:disabled:opacity-65"
      type={type}
      {...props}
    >
      {children}
    </button>
  );
}

export function IdentitySecondaryLink({
  children,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className"> & {
  children: ReactNode;
}) {
  return (
    <a
      className="tw:mt-2 tw:grid tw:min-h-control-field tw:w-full tw:place-items-center tw:border tw:border-border tw:bg-transparent tw:px-3 tw:text-xs tw:text-muted-foreground tw:hover:border-primary tw:hover:text-foreground tw:focus-visible:outline-2 tw:focus-visible:outline-offset-2 tw:focus-visible:outline-ring"
      {...props}
    >
      {children}
    </a>
  );
}
