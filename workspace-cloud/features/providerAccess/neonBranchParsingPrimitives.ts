export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function exact(value: unknown, fields: readonly string[]) {
  const row = record(value);
  return row
    && Object.keys(row).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(row, field))
    ? row
    : null;
}

export function safeText(value: unknown, maximum = 512): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value);
}

export function segment(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,59}$/.test(value);
}

export function uuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

export function instant(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

export function integer(value: unknown, maximum = 1_000_000): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= maximum;
}

export function nullable<T>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
): value is T | null {
  return value === null || predicate(value);
}

export function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.includes(value as T);
}
