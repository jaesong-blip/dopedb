const rowEditorPath = "src/components/RowEditor.tsx";
const analysisEditorPath = "src/features/analysisArticles/AnalysisArticleEditor.tsx";

export function collectI18nOwnershipDiagnostics({ exists, read }) {
  const required = [rowEditorPath, analysisEditorPath];
  const diagnostics = required
    .filter((filePath) => !exists(filePath))
    .map((filePath) => `required localized editor is missing: ${filePath}`);
  if (diagnostics.length > 0) return diagnostics;

  const rowEditor = read(rowEditorPath);
  if (!rowEditor.includes('setError(t("rowEditor.noChanges"))')) {
    diagnostics.push(`${rowEditorPath}: no-change errors must remain catalogue-owned`);
  }

  const analysisEditor = read(analysisEditorPath);
  if (!analysisEditor.includes('t("analysis.fieldHtml")')
    || !analysisEditor.includes('t("analysis.fieldSavedQuery")')) {
    diagnostics.push(`${analysisEditorPath}: HTML and saved-query labels must remain catalogue-owned`);
  }

  return diagnostics;
}
