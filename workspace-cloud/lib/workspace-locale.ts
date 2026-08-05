export const workspaceLocales = ["en", "ko"] as const;

export type WorkspaceLocale = (typeof workspaceLocales)[number];

export const workspaceLocaleHeader = "x-workspace-locale";
export const workspaceLocaleCookie = "dopedb-workspace-locale";

export function normalizeWorkspaceLocale(value: unknown): WorkspaceLocale {
  return value === "ko" ? "ko" : "en";
}

export function workspaceLocaleFromPathname(pathname: string): WorkspaceLocale {
  return pathname === "/ko" || pathname.startsWith("/ko/") ? "ko" : "en";
}

export function stripWorkspaceLocale(path: string): string {
  if (path === "/ko") return "/";
  return path.startsWith("/ko/") ? path.slice(3) : path;
}

export function localizedWorkspacePath(
  path: string,
  locale: WorkspaceLocale,
): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/api/")) {
    return path;
  }
  const suffixIndex = path.search(/[?#]/);
  const pathname = suffixIndex === -1 ? path : path.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? "" : path.slice(suffixIndex);
  const unprefixed = stripWorkspaceLocale(pathname);
  if (locale === "en") return `${unprefixed}${suffix}`;
  return `${unprefixed === "/" ? "/ko" : `/ko${unprefixed}`}${suffix}`;
}

export function workspaceLocaleFromCookieHeader(
  cookieHeader: string | null,
): WorkspaceLocale {
  if (!cookieHeader) return "en";
  const encodedName = `${workspaceLocaleCookie}=`;
  const value = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(encodedName))
    ?.slice(encodedName.length);
  return normalizeWorkspaceLocale(value);
}
