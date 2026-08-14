// Presents free-form driver parameters and capabilities from the grouped
// profile/catalog view models.
import { Icon } from "../../components/Icon";
import { Button } from "../../design-system/components/Button";
import { TextInput } from "../../design-system/components/FormControls";
import type { ConnectionEditorController } from "../../features/connections/useConnectionEditorController";
import { useI18n } from "../../lib/i18n";

export function ConnectionAdvancedTab({
  profile,
  activeDriver,
}: {
  profile: ConnectionEditorController["profile"];
  activeDriver: ConnectionEditorController["catalog"]["drivers"]["active"];
}) {
  const { t } = useI18n();
  const { options } = profile;

  return (
    <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[840px] tw:gap-5">
      <section className="tw:grid tw:gap-3">
        <div className="tw:flex tw:items-center tw:justify-between tw:gap-3">
          <h3>{t("connections.advancedParameters")}</h3>
          <Button
            size="compact"
            onClick={options.addAdvancedParameter}
          >
            <Icon name="plus" />
            {t("connections.addParameter")}
          </Button>
        </div>
        {options.advancedParameters.length === 0 ? (
          <p className="tw:m-0 tw:border-y tw:border-border-subtle tw:py-4 tw:text-sm tw:text-muted-foreground">
            {t("connections.noParameters")}
          </p>
        ) : (
          <div className="tw:grid tw:gap-2">
            {options.advancedParameters.map(([key, value], index) => (
              <div
                key={`${index}-${key}`}
                className="tw:grid tw:grid-cols-[minmax(140px,0.42fr)_minmax(0,1fr)_32px] tw:items-center tw:gap-2"
              >
                <TextInput
                  value={key}
                  aria-label={t("connections.parameterKey")}
                  onChange={(event) =>
                    options.updateAdvancedParameter(
                      key,
                      event.target.value,
                      value,
                    )
                  }
                />
                <TextInput
                  value={value}
                  aria-label={t("connections.parameterValue")}
                  onChange={(event) =>
                    options.updateAdvancedParameter(
                      key,
                      key,
                      event.target.value,
                    )
                  }
                />
                <Button
                  iconOnly
                  size="xs"
                  variant="ghost"
                  onClick={() => options.removeAdvancedParameter(key)}
                  title={t("common.remove")}
                  aria-label={t("common.remove")}
                >
                  <Icon name="close" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {activeDriver ? (
        <section className="tw:grid tw:gap-3">
          <h3>{t("connections.driverCapabilities")}</h3>
          <div className="tw:flex tw:flex-wrap tw:gap-2">
            {activeDriver.capabilities.map((capability) => (
              <span key={capability} className="badge">
                {capability}
              </span>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
