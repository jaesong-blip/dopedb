import type { AcpSessionSummary } from "./domain";
import { providerLabel } from "./acpTranscriptPresentation";

export function sessionMetaLabel(
  session: AcpSessionSummary,
  projects: readonly { id: string; name: string }[],
) {
  const projectId = session.knowledgeScopes[0]?.projectId;
  const projectName = projectId
    ? projects.find((project) => project.id === projectId)?.name ?? null
    : null;
  const provider = providerLabel(session.provider);
  return projectName ? `${projectName} · ${provider}` : provider;
}
