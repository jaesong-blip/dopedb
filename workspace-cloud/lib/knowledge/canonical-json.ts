// Knowledge artifact canonical JSON contract shared by validation, hashing, and
// persistence. Object keys use UTF-8 byte order recursively; arrays keep order.

function serialize(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object).map((key) => ({
      key,
      utf8: Buffer.from(key, "utf8"),
    }));
    entries.sort((left, right) => Buffer.compare(left.utf8, right.utf8));
    return `{${entries
      .map(({ key }) => `${JSON.stringify(key)}:${serialize(object[key])}`)
      .join(",")}}`;
  }
  const scalar = JSON.stringify(value);
  if (scalar === undefined) {
    throw new TypeError("Knowledge canonical JSON accepts only JSON values");
  }
  return scalar;
}

export function canonicalKnowledgeJson(value: unknown): string {
  return serialize(value);
}
