import {
  analyzeSqlDraft,
  type SqlDraftAnalysisRequest,
  type SqlDraftAnalysisResult,
} from "./sqlDraftAnalysis";

const workerScope = self as unknown as {
  onmessage:
    | ((event: MessageEvent<SqlDraftAnalysisRequest>) => void)
    | null;
  postMessage(message: SqlDraftAnalysisResult): void;
};

workerScope.onmessage = (event) => {
  workerScope.postMessage(analyzeSqlDraft(event.data));
};

export {};
