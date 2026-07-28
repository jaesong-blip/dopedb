export type SearchEverywhereKind =
  | "action"
  | "connection"
  | "document"
  | "databaseObject"
  | "setting";

export type SearchEverywhereItem = Readonly<{
  id: string;
  kind: SearchEverywhereKind;
  label: string;
  detail?: string;
  keywords?: readonly string[];
  shortcut?: string;
  disabled?: boolean;
  run: () => void | Promise<void>;
}>;

function normalized(value: string) {
  return value.trim().toLocaleLowerCase().normalize("NFKC");
}

function score(item: SearchEverywhereItem, query: string) {
  const label = normalized(item.label);
  const detail = normalized(item.detail ?? "");
  const keywords = normalized(item.keywords?.join(" ") ?? "");
  if (!query) return 0;
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  if (label.includes(query)) return 2;
  if (detail.includes(query)) return 3;
  if (keywords.includes(query)) return 4;
  return Number.POSITIVE_INFINITY;
}

export function searchEverywhereItems(
  items: readonly SearchEverywhereItem[],
  rawQuery: string,
  limit = 40,
) {
  const query = normalized(rawQuery);
  return items
    .map((item, index) => ({
      item,
      index,
      score: score(item, query),
    }))
    .filter(({ score: itemScore }) => Number.isFinite(itemScore))
    .sort(
      (left, right) =>
        left.score - right.score || left.index - right.index,
    )
    .slice(0, limit)
    .map(({ item }) => item);
}
