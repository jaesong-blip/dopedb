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

export type SearchEverywhereIndex = ReadonlyArray<
  Readonly<{
    item: SearchEverywhereItem;
    label: string;
    detail: string;
    keywords: string;
  }>
>;

export function indexSearchEverywhereItems(
  items: readonly SearchEverywhereItem[],
): SearchEverywhereIndex {
  return items.map((item) => ({
    item,
    label: normalized(item.label),
    detail: normalized(item.detail ?? ""),
    keywords: normalized(item.keywords?.join(" ") ?? ""),
  }));
}

function score(
  item: SearchEverywhereIndex[number],
  query: string,
) {
  const { label, detail, keywords } = item;
  if (!query) return 0;
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  if (label.includes(query)) return 2;
  if (detail.includes(query)) return 3;
  if (keywords.includes(query)) return 4;
  return Number.POSITIVE_INFINITY;
}

export function searchEverywhereItems(
  index: SearchEverywhereIndex,
  rawQuery: string,
  limit = 40,
) {
  const query = normalized(rawQuery);
  const buckets: Array<SearchEverywhereItem[]> = [[], [], [], [], []];
  for (const entry of index) {
    const itemScore = score(entry, query);
    if (!Number.isFinite(itemScore)) continue;
    const bucket = buckets[itemScore];
    // Keeping at most the result limit in each score bucket makes memory and
    // final merging bounded without discarding a later, higher-ranked match.
    if (bucket.length < limit) bucket.push(entry.item);
  }
  return buckets.flatMap((bucket) => bucket).slice(0, limit);
}
