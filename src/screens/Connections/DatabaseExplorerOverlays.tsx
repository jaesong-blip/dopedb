// Footer, setup dialogs, drag preview, and modal overlays for Database Explorer.
import type { ReactNode, RefObject } from "react";

import EngineMark from "../../components/EngineMark";
import { ProviderCredentialDialog } from "../../features/providers/ProviderCredentialDialog";
import type { ProviderKind } from "../../features/providers/domain";
import { EnvironmentSetupDialog } from "../../features/knowledge/components/EnvironmentSetupDialog";
import { ProjectSetupDialog } from "../../features/knowledge/components/ProjectSetupDialog";
import type { KnowledgeProject } from "../../features/knowledge/domain";
import type {
  DdlDialogState,
  WorkspaceDialogState,
} from "../../features/catalogExplorer/domain";
import type { ConnectionProfile } from "../../features/connections/domain";
import WorkspaceConnectionDialog from "../../features/workspaces/components/WorkspaceConnectionDialog";
import { useI18n } from "../../lib/i18n";
import DdlModal from "./DdlModal";

interface DatabaseExplorerOverlaysProps {
  workspaceAccount?: ReactNode;
  catalogScopeKey: string;
  projects: KnowledgeProject[];
  projectSetupOpen: boolean;
  environmentSetupProjectId: string | null;
  dragPreview: { id: string; x: number; y: number } | null;
  connections: ConnectionProfile[];
  ddlDialog: DdlDialogState | null;
  workspaceDialog: WorkspaceDialogState | null;
  providerCredentialsOpen: ProviderKind | null;
  providerReturnFocusRef: RefObject<HTMLElement | null>;
  onProjectCreated: (project: KnowledgeProject) => void;
  onEnvironmentCreated: (project: KnowledgeProject) => void;
  onCloseProjectSetup: () => void;
  onCloseEnvironmentSetup: () => void;
  onConnectionUpdated: (connection: ConnectionProfile) => void;
  onCloseDdl: () => void;
  onCloseWorkspaceDialog: () => void;
  onCloseProviderCredentials: () => void;
}

export function DatabaseExplorerOverlays({
  workspaceAccount,
  catalogScopeKey,
  projects,
  projectSetupOpen,
  environmentSetupProjectId,
  dragPreview,
  connections,
  ddlDialog,
  workspaceDialog,
  providerCredentialsOpen,
  providerReturnFocusRef,
  onProjectCreated,
  onEnvironmentCreated,
  onCloseProjectSetup,
  onCloseEnvironmentSetup,
  onConnectionUpdated,
  onCloseDdl,
  onCloseWorkspaceDialog,
  onCloseProviderCredentials,
}: DatabaseExplorerOverlaysProps) {
  const { t } = useI18n();
  const draggedConnection = dragPreview
    ? connections.find((connection) => connection.id === dragPreview.id) ?? null
    : null;
  return (
    <>
      {workspaceAccount ? (
        <div className="ds-control-row tw:flex tw:min-w-0 tw:shrink-0 tw:items-center tw:gap-2 tw:border-t tw:border-border-subtle tw:bg-background tw:p-2">
          {workspaceAccount}
        </div>
      ) : null}

      {projectSetupOpen ? (
        <ProjectSetupDialog
          catalogScopeKey={catalogScopeKey}
          onClose={onCloseProjectSetup}
          onCreated={onProjectCreated}
        />
      ) : null}

      {environmentSetupProjectId ? (
        <EnvironmentSetupDialog
          projects={projects}
          preferredProjectId={environmentSetupProjectId}
          catalogScopeKey={catalogScopeKey}
          onClose={onCloseEnvironmentSetup}
          onCreated={onEnvironmentCreated}
        />
      ) : null}

      {dragPreview && draggedConnection ? (
        <div
          className="tw:pointer-events-none tw:fixed tw:top-0 tw:left-0 tw:z-[var(--ds-z-popover)] tw:inline-flex tw:max-w-[min(280px,70vw)] tw:items-center tw:gap-2 tw:rounded-sm tw:border tw:border-border-strong tw:bg-popover tw:p-2 tw:text-ui tw:font-semibold tw:text-popover-foreground tw:shadow-popover"
          style={{
            transform: `translate3d(${Math.round(dragPreview.x + 12)}px, ${Math.round(dragPreview.y + 12)}px, 0)`,
          }}
        >
          <EngineMark engine={draggedConnection.engine} />
          <span className="tw:min-w-0 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
            {draggedConnection.name || t("app.unnamed")}
          </span>
        </div>
      ) : null}

      {ddlDialog ? (
        <DdlModal
          connection={ddlDialog.connection}
          table={ddlDialog.table}
          onClose={onCloseDdl}
        />
      ) : null}
      {workspaceDialog ? (
        <WorkspaceConnectionDialog
          connection={workspaceDialog.connection}
          mode={workspaceDialog.mode}
          onBound={onConnectionUpdated}
          onClose={onCloseWorkspaceDialog}
        />
      ) : null}
      {providerCredentialsOpen ? (
        <ProviderCredentialDialog
          initialProvider={providerCredentialsOpen}
          onClose={onCloseProviderCredentials}
          returnFocusRef={providerReturnFocusRef}
        />
      ) : null}
    </>
  );
}
