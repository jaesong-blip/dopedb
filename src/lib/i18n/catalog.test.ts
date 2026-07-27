import { describe, expect, it } from "vitest";

import { catalogParts, composeCatalogs, messages } from "./catalog";
import type { I18nKey } from "./catalog";
import { defineCatalog } from "./types";

const placeholderNames = (message: string) =>
  [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

const compareKeys = ([left]: readonly [string, string], [right]: readonly [string, string]) =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * This covers every language, key, and value in key order. The fixed digest deliberately
 * protects the legacy catalogue contract during the file-splitting refactor: matching counts
 * alone would miss a deleted key replaced by a different key or changed translated text.
 */
const catalogFingerprint = async () => {
  const canonical = (["en", "ko"] as const).flatMap((lang) =>
    Object.entries(messages[lang])
      .sort(compareKeys)
      .map(([key, value]) => [lang, key, value]),
  );
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical)),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

describe("i18n catalogues", () => {
  it("preserves all 907 English and Korean keys with exact parity", () => {
    const englishKeys = Object.keys(messages.en).sort();
    const koreanKeys = Object.keys(messages.ko).sort();

    expect(englishKeys).toHaveLength(907);
    expect(koreanKeys).toEqual(englishKeys);
  });

  it("preserves the catalogue key and value contract", async () => {
    await expect(catalogFingerprint()).resolves.toBe(
      "362afab3fba4da4dec881b092b4249da8492ca7b6ad7e60b05a136d800900f8f",
    );
  });

  it("keeps interpolation placeholders aligned between languages", () => {
    for (const key of Object.keys(messages.en) as I18nKey[]) {
      expect(placeholderNames(messages.ko[key]), key).toEqual(
        placeholderNames(messages.en[key]),
      );
    }
  });

  it("has one owner for every global message key", () => {
    expect(() => composeCatalogs(catalogParts)).not.toThrow();
    const first = defineCatalog({ "test.one": "one" }, { "test.one": "하나" });
    const second = defineCatalog({ "test.one": "two" }, { "test.one": "둘" });

    expect(() => composeCatalogs([first, second])).toThrow(
      "i18n catalogue key is owned more than once: test.one",
    );
  });
});
