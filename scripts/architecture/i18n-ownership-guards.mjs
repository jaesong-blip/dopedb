const rowEditorPath = "src/components/RowEditor.tsx";
const analysisBuilderPath = "src/features/analysisArticles/AnalysisDefinitionBuilder.tsx";

export function collectI18nOwnershipDiagnostics({ exists, read }) {
  const required = [rowEditorPath, analysisBuilderPath];
  const diagnostics = required
    .filter((filePath) => !exists(filePath))
    .map((filePath) => `required localized editor is missing: ${filePath}`);
  if (diagnostics.length > 0) return diagnostics;

  const rowEditor = read(rowEditorPath);
  if (!rowEditor.includes('setError(t("rowEditor.noChanges"))')) {
    diagnostics.push(`${rowEditorPath}: no-change errors must remain catalogue-owned`);
  }

  const analysisBuilder = read(analysisBuilderPath);
  for (const literal of [
    'label="Markdown"',
    'title: "Read query"',
    'text: "Section heading"',
    'markdown: "Write the analysis context and interpretation."',
    'markdown: "Important context for this result."',
    'title: "Table"',
    'title: "Funnel"',
    'title: "Retention cohort"',
    'title: "Heatmap"',
  ]) {
    if (analysisBuilder.includes(literal)) {
      diagnostics.push(`${analysisBuilderPath}: persisted user-facing seed bypasses the catalogue (${literal})`);
    }
  }
  if (!analysisBuilder.includes("function defaultBlock(") || !analysisBuilder.includes("t: Translate,")) {
    diagnostics.push(`${analysisBuilderPath}: block creation must receive the current translator explicitly`);
  }

  return diagnostics;
}
