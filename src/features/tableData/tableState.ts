// Shared table-query timing and equality policy.
export const FILTER_DEBOUNCE_MS = 250;
export const TABLE_PAGE_SIZE = 100;

export function sameFilters(
  left: Record<string, string>,
  right: Record<string, string>,
) {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}
