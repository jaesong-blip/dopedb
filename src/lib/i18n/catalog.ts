// The complete static catalogue is composed once at module load. Catalogues stay statically
// imported so Vite retains the existing one-bundle localization behavior with no async gap.
import { activityCatalog } from "./catalogs/activity";
import { agentsCatalog } from "./catalogs/agents";
import { appCatalog } from "./catalogs/app";
import { approvalCatalog } from "./catalogs/approval";
import { cliCatalog } from "./catalogs/cli";
import { connectionsCatalog } from "./catalogs/connections";
import { documentsCatalog } from "./catalogs/documents";
import { jobsCatalog } from "./catalogs/jobs";
import { localHistoryCatalog } from "./catalogs/localHistory";
import { onboardingCatalog } from "./catalogs/onboarding";
import { resultsCatalog } from "./catalogs/results";
import { rowEditorCatalog } from "./catalogs/rowEditor";
import { safetyCatalog } from "./catalogs/safety";
import { schemaCatalog } from "./catalogs/schema";
import { schemaDiffCatalog } from "./catalogs/schemaDiff";
import { sqlCatalog } from "./catalogs/sql";
import { tablesCatalog } from "./catalogs/tables";
import { terminalCatalog } from "./catalogs/terminal";
import { updatesCatalog } from "./catalogs/updates";
import { workspaceCatalog } from "./catalogs/workspace";
import { providerProvisioningCatalog } from "./catalogs/providerProvisioning";
import type { Lang, MessageCatalog } from "./types";

export const catalogParts = [
  activityCatalog,
  agentsCatalog,
  appCatalog,
  approvalCatalog,
  cliCatalog,
  connectionsCatalog,
  documentsCatalog,
  jobsCatalog,
  localHistoryCatalog,
  onboardingCatalog,
  resultsCatalog,
  rowEditorCatalog,
  safetyCatalog,
  schemaCatalog,
  schemaDiffCatalog,
  sqlCatalog,
  tablesCatalog,
  terminalCatalog,
  updatesCatalog,
  workspaceCatalog,
  providerProvisioningCatalog,
] as const;

type CatalogKey<Parts extends readonly MessageCatalog[]> = Parts[number] extends infer Part
  ? Part extends MessageCatalog
    ? keyof Part["en"]
    : never
  : never;

type ComposedCatalog<Parts extends readonly MessageCatalog[]> = Readonly<{
  en: Readonly<Record<CatalogKey<Parts>, string>>;
  ko: Readonly<Record<CatalogKey<Parts>, string>>;
}>;

/** Composes bounded catalogues and rejects runtime collisions before the UI can render. */
export function composeCatalogs<const Parts extends readonly MessageCatalog[]>(
  parts: Parts,
): ComposedCatalog<Parts> {
  const messages: Record<Lang, Record<string, string>> = { en: {}, ko: {} };
  const seenKeys = new Set<string>();

  for (const part of parts) {
    const englishKeys = Object.keys(part.en);
    const koreanKeys = Object.keys(part.ko);
    if (
      englishKeys.length !== koreanKeys.length ||
      englishKeys.some(
        (key) => !Object.prototype.hasOwnProperty.call(part.ko, key),
      )
    ) {
      throw new Error("i18n catalogue language keys must match exactly");
    }

    for (const key of englishKeys) {
      if (seenKeys.has(key)) {
        throw new Error(`i18n catalogue key is owned more than once: ${key}`);
      }
      seenKeys.add(key);
      messages.en[key] = part.en[key];
      messages.ko[key] = part.ko[key];
    }
  }

  return messages as ComposedCatalog<Parts>;
}

export const messages = composeCatalogs(catalogParts);

/** Every key accepted by the public translator is derived from the English source catalogues. */
export type I18nKey = CatalogKey<typeof catalogParts>;
