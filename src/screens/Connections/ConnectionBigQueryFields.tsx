// BigQuery's official-CLI profile stays separate from socket/password fields.
import { PropertyRow, SelectInput, TextInput } from "../../design-system/components/FormControls";
import { StatusBadge } from "../../design-system/components/Status";
import {
  BIGQUERY_DEFAULT_MAXIMUM_BYTES_BILLED,
  BIGQUERY_LOCATION_PARAMETER,
  BIGQUERY_MAXIMUM_BYTES_BILLED_PARAMETER,
} from "../../features/connections/connectionEditorModel";
import type { ConnectionEditorController } from "../../features/connections/useConnectionEditorController";
import { useI18n } from "../../lib/i18n";

type Controller = ConnectionEditorController;

export function ConnectionBigQueryFields({
  profile,
  drivers,
}: {
  profile: Controller["profile"];
  drivers: Controller["catalog"]["drivers"];
}) {
  const { t } = useI18n();
  const { form, set, flags, options, validation } = profile;
  const { isSharedTemplate, canEditConnection } = flags;

  return (
    <section className="tw:grid tw:gap-3">
      <PropertyRow
        label={t("connections.bigQueryProjectId")}
        htmlFor="connection-host"
        validation={validation.host}
      >
        <TextInput
          id="connection-host"
          density="compact"
          value={form.host}
          disabled={!canEditConnection}
          required
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={validation.host?.tone === "danger" || undefined}
          placeholder="my-gcp-project"
          onChange={(event) => set("host", event.target.value)}
        />
      </PropertyRow>

      <PropertyRow
        label={t("connections.bigQueryDataset")}
        htmlFor="connection-database"
        validation={validation.database}
      >
        <TextInput
          id="connection-database"
          density="compact"
          value={form.database}
          disabled={!canEditConnection}
          required
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={validation.database?.tone === "danger" || undefined}
          placeholder="analytics"
          onChange={(event) => set("database", event.target.value)}
        />
      </PropertyRow>

      {!isSharedTemplate ? (
        <PropertyRow
          label={t("connections.bigQueryLocation")}
          htmlFor="connection-bigquery-location"
          validation={validation.bigQueryLocation}
        >
          <TextInput
            id="connection-bigquery-location"
            density="compact"
            value={form.extraParams[BIGQUERY_LOCATION_PARAMETER] ?? ""}
            disabled={!canEditConnection}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={
              validation.bigQueryLocation?.tone === "danger" || undefined
            }
            placeholder={t("connections.bigQueryLocationPlaceholder")}
            onChange={(event) =>
              options.setExtraParameter(
                BIGQUERY_LOCATION_PARAMETER,
                event.target.value,
              )
            }
          />
        </PropertyRow>
      ) : null}

      {!isSharedTemplate ? (
        <PropertyRow
          label={t("connections.bigQueryMaximumBytesBilled")}
          htmlFor="connection-bigquery-maximum-bytes-billed"
          validation={validation.bigQueryMaximumBytesBilled}
        >
          <TextInput
            id="connection-bigquery-maximum-bytes-billed"
            density="compact"
            type="number"
            min={1}
            max={10 * 1024 ** 4}
            value={
              form.extraParams[BIGQUERY_MAXIMUM_BYTES_BILLED_PARAMETER] ??
              BIGQUERY_DEFAULT_MAXIMUM_BYTES_BILLED
            }
            aria-invalid={
              validation.bigQueryMaximumBytesBilled?.tone === "danger" ||
              undefined
            }
            onChange={(event) =>
              options.setExtraParameter(
                BIGQUERY_MAXIMUM_BYTES_BILLED_PARAMETER,
                event.target.value,
              )
            }
          />
        </PropertyRow>
      ) : (
        <PropertyRow label={t("connections.environment")}>
          <SelectInput
            density="compact"
            value={form.env ?? ""}
            disabled={!canEditConnection}
            onChange={(event) => set("env", event.target.value || null)}
          >
            <option value="">{t("common.none")}</option>
            <option value="dev">dev</option>
            <option value="staging">staging</option>
            <option value="prod">prod</option>
          </SelectInput>
        </PropertyRow>
      )}

      <PropertyRow label={t("connections.authentication")}>
        <div className="tw:flex tw:min-h-control-md tw:flex-wrap tw:items-center tw:gap-2">
          <StatusBadge
            tone={
              drivers.active?.installState === "installed"
                ? "success"
                : "warning"
            }
          >
            {drivers.active?.installState === "installed"
              ? t("connections.bigQueryCliReady")
              : t("connections.bigQueryCliRequired")}
          </StatusBadge>
        </div>
      </PropertyRow>
      <p className="tw:m-0 tw:border-t tw:border-border-subtle tw:pt-3 tw:text-sm tw:leading-body tw:text-muted-foreground">
        {t("connections.bigQuerySecurityNote")}
      </p>
    </section>
  );
}
