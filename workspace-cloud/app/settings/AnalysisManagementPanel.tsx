"use client";

// Settings binds route inputs to the feature-owned Analysis controller and view.
import { AnalysisManagementView } from "../../features/analysisManagement/AnalysisManagementView";
import { useAnalysisManagement } from "../../features/analysisManagement/useAnalysisManagement";

export function AnalysisManagementPanel({
  workspaceId,
  initialArticleId,
  canEdit,
}: {
  workspaceId: string;
  initialArticleId: string | null;
  canEdit: boolean;
}) {
  const controller = useAnalysisManagement({ workspaceId, initialArticleId, canEdit });
  return (
    <AnalysisManagementView
      controller={controller}
      canEdit={canEdit}
    />
  );
}
