import { queryOptions } from "@tanstack/react-query";

import { listKnowledgeInventory } from "./tauriAdapter";
import { knowledgeQueryKeys } from "./queryKeys";

const KNOWLEDGE_INVENTORY_STALE_MS = 60_000;

export function knowledgeInventoryQuery(
  workspaceScopeKey: string,
  enabled = true,
) {
  return queryOptions({
    queryKey: knowledgeQueryKeys.inventory(workspaceScopeKey),
    queryFn: listKnowledgeInventory,
    enabled,
    retry: false,
    staleTime: KNOWLEDGE_INVENTORY_STALE_MS,
  });
}
