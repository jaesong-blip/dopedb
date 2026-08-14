"use client";

// Settings binds route inputs to the feature-owned Analysis controller and view.
import { AnalysisManagementView } from "../../features/analysisManagement/AnalysisManagementView";
import { useAnalysisManagement } from "../../features/analysisManagement/useAnalysisManagement";

export function AnalysisManagementPanel({
  workspaceId,
  initialArticleId,
  initialBlockId,
  canEdit,
}: {
  workspaceId: string;
  initialArticleId: string | null;
  initialBlockId: string | null;
  canEdit: boolean;
}) {
  const controller = useAnalysisManagement({ workspaceId, initialArticleId, canEdit });
  return (
    <AnalysisManagementView
      controller={controller}
      initialArticleId={initialArticleId}
      initialBlockId={initialBlockId}
      canEdit={canEdit}
    />
  );
}
