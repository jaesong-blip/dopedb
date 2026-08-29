const MAX_ATTRIBUTE_CHARS = 4_000;

export function cleanCodeIndexText(
  value: string,
  maximum = MAX_ATTRIBUTE_CHARS,
) {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, maximum).trim();
}

export function safeCodeIndexSignature(value: string) {
  const header = value.split(/=>|[\n\r{]/, 1)[0] ?? value;
  const redacted = header.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "$1…$1");
  return cleanCodeIndexText(redacted, 1_024);
}

export function boundedCodeIndexName(value: string) {
  return cleanCodeIndexText(value, 512);
}
