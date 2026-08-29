import type { CodeReference } from "./code-index-core";
import { boundedCodeIndexName } from "./code-index-text";

type CodeRelation = CodeReference["relation"];

export function parseSqlReferences(
  text: string,
  ownerIndex: number | null,
  lineStart: number,
  lineEnd: number,
) {
  const references: CodeReference[] = [];
  const seen = new Set<string>();
  const add = (relation: CodeRelation, value: string) => {
    const name = boundedCodeIndexName(value.replace(/["'`]/g, ""));
    const key = `${relation}\0${name}`;
    if (!name || seen.has(key)) return;
    seen.add(key);
    references.push({
      ownerIndex,
      relation,
      targetKind: "table",
      targetName: name,
      lineStart,
      lineEnd,
    });
  };
  for (const match of text.matchAll(/\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_."`]*)/gi)) {
    if (match[1]) add("reads_table", match[1]);
  }
  for (const match of text.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+([A-Za-z_][A-Za-z0-9_."`]*)/gi)) {
    if (match[1]) add("writes_table", match[1]);
  }
  return references;
}
