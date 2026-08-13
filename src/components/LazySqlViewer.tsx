import { lazy, Suspense, type ReactNode } from "react";
import type { SqlViewerProps } from "./SqlViewer";
import { useI18n } from "../lib/i18n";

const SqlViewer = lazy(() => import("./SqlViewer"));

export default function LazySqlViewer({
  fallback,
  ...props
}: SqlViewerProps & { fallback?: ReactNode }) {
  const { t } = useI18n();
  return (
    <Suspense fallback={fallback ?? (
      <div className="tw:p-2 tw:text-muted-foreground">{t("sql.loadingEditor")}</div>
    )}>
      <SqlViewer {...props} />
    </Suspense>
  );
}
