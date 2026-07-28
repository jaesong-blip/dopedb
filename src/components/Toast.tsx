// Tiny toast system: context + hook + a fixed corner stack. 3s auto-dismiss,
// success/error variants. useToast() returns a `toast(msg, variant?)` fn.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type Variant = "success" | "error";
interface ToastItem {
  id: number;
  msg: string;
  variant: Variant;
}

type ToastFn = (msg: string, variant?: Variant) => void;

const Ctx = createContext<ToastFn>(() => {});

export function useToast(): ToastFn {
  return useContext(Ctx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const toast = useCallback<ToastFn>((msg, variant = "success") => {
    const id = idRef.current++;
    // cap the stack so a burst can't overflow off-screen
    setToasts((t) => [...t, { id, msg, variant }].slice(-4));
    window.setTimeout(() => dismiss(id), 3000);
  }, [dismiss]);

  return (
    <Ctx.Provider value={toast}>
      {children}
      {/* live region so screen readers announce toasts */}
      <div
        className="tw:pointer-events-none tw:fixed tw:right-4 tw:bottom-4 tw:z-[var(--ds-z-toast)] tw:flex tw:flex-col tw:gap-2 tw:max-[640px]:right-3 tw:max-[640px]:bottom-3 tw:max-[640px]:left-3"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            data-variant={t.variant}
            className="tw:pointer-events-auto tw:min-w-[180px] tw:max-w-[360px] tw:cursor-pointer tw:rounded-md tw:border tw:border-border-subtle tw:border-l-[3px] tw:border-l-success tw:bg-card tw:px-4 tw:py-3 tw:text-ui tw:text-foreground tw:shadow-popover tw:animate-[toast-in_150ms_ease-out] tw:data-[variant=error]:border-l-danger tw:max-[640px]:w-full tw:max-[640px]:min-w-0 tw:max-[640px]:max-w-none"
            role={t.variant === "error" ? "alert" : "status"}
            onClick={() => dismiss(t.id)}
          >
            {t.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
