// MongoDB reads use the same persisted proposal/consume boundary as SQL reads.
// No document write transport exists in the Desktop product.
import { invoke } from "../../ipc/core";
import type {
  DocumentOperationProposal,
  DocumentPage,
  DocumentQuery,
} from "../../ipc/types";

export function runDocumentQuery(operationId: string): Promise<DocumentPage> {
  return invoke("run_document_query", { operationId });
}

export function proposeDocumentQuery(
  id: string,
  query: DocumentQuery,
  origin?: string,
): Promise<DocumentOperationProposal> {
  return invoke("propose_document_query", {
    id,
    query,
    origin: origin ?? null,
  });
}

export async function runDocumentRead(
  id: string,
  query: DocumentQuery,
  origin?: string,
): Promise<DocumentPage> {
  const proposal = await proposeDocumentQuery(id, query, origin);
  return runDocumentQuery(proposal.operationId);
}
