import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DopeDB Workspace",
  description: "Identity and workspace control plane for DopeDB",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body className="tw:min-h-[100dvh] tw:bg-background tw:text-foreground">
        <div
          className="tw:pointer-events-none tw:fixed tw:inset-0 tw:opacity-[0.18] tw:[background-image:linear-gradient(color-mix(in_srgb,var(--ds-white)_2.5%,transparent)_1px,transparent_1px),linear-gradient(90deg,color-mix(in_srgb,var(--ds-white)_2.5%,transparent)_1px,transparent_1px)] tw:[background-size:40px_40px] tw:[mask-image:linear-gradient(to_bottom,var(--ds-background),transparent_80%)]"
          aria-hidden="true"
        />
        {children}
      </body>
    </html>
  );
}
