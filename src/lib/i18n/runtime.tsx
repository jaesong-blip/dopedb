// React state and browser integration for localization live separately from the message text so
// feature catalogues remain pure, statically bundled data and callers retain one stable context.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { messages, type I18nKey } from "./catalog";
import type { Lang, MessageCatalog } from "./types";

const STORAGE_KEY = "dopedb.lang";

interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: I18nKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

/** Chooses a persisted language first, then uses the browser's Korean locale hint. */
export function resolveInitialLang(stored: string | null, browserLanguage: string): Lang {
  if (stored === "en" || stored === "ko") return stored;
  return browserLanguage.toLowerCase().startsWith("ko") ? "ko" : "en";
}

/** Keeps the document language and the persisted user preference in one place. */
export function synchronizeLangPreference(
  lang: Lang,
  documentElement: Pick<HTMLElement, "lang">,
  storage: Pick<Storage, "setItem">,
) {
  documentElement.lang = lang;
  storage.setItem(STORAGE_KEY, lang);
}

function detectLang(): Lang {
  return resolveInitialLang(localStorage.getItem(STORAGE_KEY), navigator.language);
}

/** Resolves a translated template with Korean-to-English fallback retained for partial data. */
export function resolveMessage(
  catalog: MessageCatalog,
  lang: Lang,
  key: string,
): string | undefined {
  return catalog[lang][key] ?? catalog.en[key];
}

/** Replaces the existing simple `{name}` interpolation tokens without adding an ICU runtime. */
export function formatMessage(
  template: string,
  vars: Record<string, string | number> | undefined,
) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    vars[key] == null ? `{${key}}` : String(vars[key]),
  );
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => detectLang());

  useEffect(() => {
    synchronizeLangPreference(lang, document.documentElement, localStorage);
  }, [lang]);

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      setLang: setLangState,
      t: (key, vars) => formatMessage(resolveMessage(messages, lang, key)!, vars),
    }),
    [lang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
