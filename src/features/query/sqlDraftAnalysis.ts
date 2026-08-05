import type { ConnectionEngine } from "../connections/domain";
import { splitStatements } from "../../lib/sqlStatements";
import { findSqlParameters } from "./sqlParameters";
import {
  analyzeRunSignal,
  type RunSignalAnalysis,
  type RunSignalSafety,
} from "./runSignal";

export interface SqlDraftAnalysisRequest {
  requestId: number;
  version: number;
  sql: string;
  engine: ConnectionEngine;
  safety: RunSignalSafety;
}

export interface SqlDraftAnalysisResult {
  requestId: number;
  version: number;
  statementCount: number;
  parameterCount: number;
  runSignal: RunSignalAnalysis | null;
}

export function analyzeSqlDraft({
  requestId,
  version,
  sql,
  engine,
  safety,
}: SqlDraftAnalysisRequest): SqlDraftAnalysisResult {
  const statements = splitStatements(sql);
  return {
    requestId,
    version,
    statementCount: statements.length,
    parameterCount: findSqlParameters(sql, engine).length,
    runSignal: analyzeRunSignal(sql, statements, safety),
  };
}
