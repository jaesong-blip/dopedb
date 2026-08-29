import {
  analysisColumnMasking,
  analysisColumnRoles,
  analysisColumnSensitivities,
  analysisColumnTypes,
  type AnalysisColumn,
  type AnalysisColumnMasking,
  type AnalysisColumnRole,
  type AnalysisColumnSensitivity,
  type AnalysisColumnType,
} from "./workspace-analysis-article-contracts";
import { displayText, exactRecord, uniqueValues as unique } from "./workspace-analysis-validation";

function parseColumn(value: unknown): AnalysisColumn {
  const row = exactRecord(value, [
    "name", "type", "nullable", "role", "sensitivity", "masking",
  ]);
  const name = displayText(row?.name, 256);
  if (!row || name === null || typeof row.type !== "string"
    || !analysisColumnTypes.includes(row.type as AnalysisColumnType)
    || typeof row.nullable !== "boolean" || typeof row.role !== "string"
    || !analysisColumnRoles.includes(row.role as AnalysisColumnRole)
    || typeof row.sensitivity !== "string"
    || !analysisColumnSensitivities.includes(row.sensitivity as AnalysisColumnSensitivity)
    || typeof row.masking !== "string"
    || !analysisColumnMasking.includes(row.masking as AnalysisColumnMasking)) {
    throw new Error("Invalid Analysis Article column");
  }
  const role = row.role as AnalysisColumnRole;
  const sensitivity = row.sensitivity as AnalysisColumnSensitivity;
  const masking = row.masking as AnalysisColumnMasking;
  if ((role === "identifier" && !["hash", "redact"].includes(masking))
    || (role === "free_text" && masking !== "redact")
    || (sensitivity === "restricted" && masking !== "redact")
    || (sensitivity === "confidential" && masking === "none")
    || (masking === "bucket" && sensitivity !== "public")
    || (masking === "hash" && row.type !== "string")) {
    throw new Error("Unsafe Analysis Article column publication policy");
  }
  return {
    name,
    type: row.type as AnalysisColumnType,
    nullable: row.nullable,
    role,
    sensitivity,
    masking,
  };
}

export function parseColumns(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    throw new Error("Invalid Analysis Article columns");
  }
  const columns = value.map(parseColumn);
  if (!unique(columns.map((column) => column.name))) {
    throw new Error("Duplicate Analysis Article column");
  }
  return columns;
}
