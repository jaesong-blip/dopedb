// Neon branch inventory discovery shared by branch mutation and managed access.
import "server-only";

import type { NeonCredential } from "./neon-core";
import {
  neonBranchQueryable,
  parseNeonBranchInventory,
  type NeonBranchInventory,
} from "./neon-branches";
import type { ProviderResourceItem } from "./provider-types";
import {
  apiSegment,
  listNeonCollection,
} from "./neon-api";

export async function listNeonBranchInventory(
  credential: NeonCredential,
  project: string,
): Promise<NeonBranchInventory> {
  const rows = await listNeonCollection({
    credential,
    path: `/projects/${apiSegment(project)}/branches`,
    collection: "branches",
    scopeLabel: "branch",
  });
  return parseNeonBranchInventory(project, rows);
}

export async function listNeonBranches(
  credential: NeonCredential,
  project: string,
): Promise<ProviderResourceItem[]> {
  const inventory = await listNeonBranchInventory(credential, project);
  return inventory.branches.map((branch) => ({
    id: branch.id,
    value: branch.id,
    name: branch.name,
    production: branch.production,
    ready: neonBranchQueryable(branch),
  }));
}
