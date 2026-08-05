import { redirect } from "next/navigation";
import { localizedWorkspacePath } from "../lib/workspace-locale";
import { getWorkspaceLocale } from "../lib/workspace-locale-server";

export default async function Home() {
  redirect(localizedWorkspacePath("/settings", await getWorkspaceLocale()));
}
