import "server-only";

import { headers } from "next/headers";
import {
  normalizeWorkspaceLocale,
  workspaceLocaleHeader,
  type WorkspaceLocale,
} from "./workspace-locale";

export async function getWorkspaceLocale(): Promise<WorkspaceLocale> {
  return normalizeWorkspaceLocale((await headers()).get(workspaceLocaleHeader));
}
