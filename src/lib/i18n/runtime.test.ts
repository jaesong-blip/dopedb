import { describe, expect, it, vi } from "vitest";

import {
  formatMessage,
  resolveInitialLang,
  resolveMessage,
  synchronizeLangPreference,
} from "./runtime";
import type { MessageCatalog } from "./types";

describe("i18n runtime helpers", () => {
  it("prefers a valid stored language before the browser locale", () => {
    expect(resolveInitialLang("en", "ko-KR")).toBe("en");
    expect(resolveInitialLang("ko", "en-US")).toBe("ko");
  });

  it("uses the Korean browser locale only when storage has no valid preference", () => {
    expect(resolveInitialLang(null, "ko-KR")).toBe("ko");
    expect(resolveInitialLang("unexpected", "ko")).toBe("ko");
    expect(resolveInitialLang(null, "en-US")).toBe("en");
  });

  it("synchronizes the document language and persistent preference together", () => {
    const documentElement = { lang: "" };
    const storage = { setItem: vi.fn() };

    synchronizeLangPreference("ko", documentElement, storage);

    expect(documentElement.lang).toBe("ko");
    expect(storage.setItem).toHaveBeenCalledWith("dopedb.lang", "ko");
  });

  it("falls back to English when a Korean runtime catalogue is incomplete", () => {
    const partial = {
      en: { "test.message": "Hello {name}" },
      ko: {},
    } as MessageCatalog;

    expect(resolveMessage(partial, "ko", "test.message")).toBe("Hello {name}");
  });

  it("preserves unknown interpolation tokens and substitutes supplied variables", () => {
    expect(formatMessage("Hello {name}, {missing}", { name: "Ada" })).toBe(
      "Hello Ada, {missing}",
    );
  });
});
