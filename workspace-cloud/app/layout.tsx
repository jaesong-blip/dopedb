import type { Metadata } from "next";
import { IBM_Plex_Mono, Manrope, Newsreader } from "next/font/google";
import { WorkspaceLocaleProvider } from "./components/WorkspaceLocale";
import { getWorkspaceLocale } from "../lib/workspace-locale-server";
import "./globals.css";

const bodyFont = Manrope({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-workspace-body-loaded",
  weight: ["400", "500", "600", "700"],
});

const displayFont = Newsreader({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-workspace-display-loaded",
  weight: ["400", "500"],
});

const monoFont = IBM_Plex_Mono({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-workspace-mono-loaded",
  weight: ["400", "500", "600"],
});

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getWorkspaceLocale();
  return locale === "ko"
    ? {
        title: "DopeDB 워크스페이스",
        description: "DopeDB의 공유 데이터베이스 접근 및 권한 제어 공간",
      }
    : {
        title: "DopeDB Workspace",
        description: "Shared database access and authority control plane for DopeDB",
      };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const locale = await getWorkspaceLocale();
  return (
    <html
      className={`${bodyFont.variable} ${displayFont.variable} ${monoFont.variable}`}
      lang={locale}
    >
      <body className="tw:min-h-[100dvh] tw:bg-background tw:text-foreground">
        <a
          className="tw:fixed tw:top-3 tw:left-3 tw:z-50 tw:-translate-y-24 tw:rounded-control tw:bg-signal tw:px-4 tw:py-2.5 tw:text-xs tw:font-semibold tw:text-chrome tw:focus:translate-y-0"
          href="#main-content"
        >
          {locale === "ko" ? "본문으로 건너뛰기" : "Skip to content"}
        </a>
        <div
          className="tw:pointer-events-none tw:fixed tw:inset-0 tw:opacity-70 tw:[background-image:linear-gradient(var(--ds-grid-line)_1px,transparent_1px),linear-gradient(90deg,var(--ds-grid-line)_1px,transparent_1px)] tw:[background-size:48px_48px] tw:[mask-image:linear-gradient(to_bottom,var(--ds-text),transparent_82%)]"
          aria-hidden="true"
        />
        <WorkspaceLocaleProvider locale={locale}>
          {children}
        </WorkspaceLocaleProvider>
      </body>
    </html>
  );
}
