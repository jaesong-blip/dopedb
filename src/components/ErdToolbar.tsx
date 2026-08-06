// Flat command bar for ERD layout, persistence, virtual edges, and local export.
import {
  erdLayoutId,
  type ErdLayout,
  type ErdLayoutId,
  type ErdLayoutMode,
} from "../features/erd/domain";
import { Icon } from "./Icon";
import ToolbarMenu, { ToolbarMenuItem } from "./ToolbarMenu";
import { Button } from "../design-system/components/Button";
import { WorkbenchToolbar } from "../design-system/components/Workbench";
import { useI18n } from "../lib/i18n";

export default function ErdToolbar({
  layouts,
  activeLayoutId,
  name,
  mode,
  compact,
  neighborhood,
  dirty,
  busy,
  onSelectLayout,
  onName,
  onMode,
  onAutoLayout,
  onSave,
  onToggleCompact,
  onToggleNeighborhood,
  onAddRelation,
  onExport,
}: {
  layouts: ErdLayout[];
  activeLayoutId: ErdLayoutId | null;
  name: string;
  mode: ErdLayoutMode;
  compact: boolean;
  neighborhood: boolean;
  dirty: boolean;
  busy: boolean;
  onSelectLayout: (id: ErdLayoutId | null) => void;
  onName: (name: string) => void;
  onMode: (mode: ErdLayoutMode) => void;
  onAutoLayout: () => void;
  onSave: () => void;
  onToggleCompact: () => void;
  onToggleNeighborhood: () => void;
  onAddRelation: () => void;
  onExport: (format: "svg" | "png" | "pdf" | "json" | "copy") => void;
}) {
  const { t } = useI18n();
  return (
    <WorkbenchToolbar label={t("schema.erdMode")}>
      <div className="scrollbar-sleek tw:flex tw:min-w-0 tw:flex-1 tw:items-center tw:gap-2 tw:overflow-x-auto tw:overflow-y-hidden tw:overscroll-x-contain tw:[&>*]:shrink-0">
        <select
          className="tw:w-auto tw:max-w-[180px] tw:min-w-0 tw:@max-[760px]:w-[min(100%,180px)]"
          value={activeLayoutId ?? ""}
          onChange={(event) =>
            onSelectLayout(
              event.target.value ? erdLayoutId(event.target.value) : null,
            )
          }
          aria-label={t("schema.erdSavedLayouts")}
        >
          <option value="">{t("schema.erdNewLayout")}</option>
          {layouts.map((layout) => (
            <option key={layout.id} value={layout.id}>
              {layout.name}
            </option>
          ))}
        </select>
        <input
          className="tw:w-[min(180px,24vw)] tw:min-w-0 tw:@max-[760px]:w-[min(100%,180px)]"
          value={name}
          onChange={(event) => onName(event.target.value)}
          aria-label={t("schema.erdLayoutName")}
          placeholder={t("schema.erdLayoutName")}
        />
        <select
          className="tw:w-auto tw:min-w-0"
          value={mode}
          onChange={(event) => onMode(event.target.value as ErdLayoutMode)}
          aria-label={t("schema.erdMode")}
        >
          <option value="physical">{t("schema.erdPhysical")}</option>
          <option value="logical">{t("schema.erdLogical")}</option>
          <option value="uml">{t("schema.erdUml")}</option>
        </select>
        <Button
          data-erd-neighborhood-toggle
          disabled={busy}
          iconOnly
          onClick={onAutoLayout}
          size="compact"
          title={t("schema.erdAutoLayout")}
          aria-label={t("schema.erdAutoLayout")}
        >
          <Icon name="refresh" />
        </Button>
        <Button
          iconOnly
          onClick={onToggleCompact}
          size="compact"
          title={t("schema.erdCompact")}
          aria-label={t("schema.erdCompact")}
          aria-pressed={compact}
        >
          <Icon name="columns" />
        </Button>
        <Button
          iconOnly
          onClick={onToggleNeighborhood}
          size="compact"
          title={t(
            neighborhood ? "schema.erdShowAll" : "schema.erdNeighborhood",
          )}
          aria-label={t(
            neighborhood ? "schema.erdShowAll" : "schema.erdNeighborhood",
          )}
          aria-pressed={neighborhood}
        >
          <Icon name="target" />
        </Button>
        <Button
          iconOnly
          onClick={onAddRelation}
          size="compact"
          title={t("schema.erdAddVirtual")}
          aria-label={t("schema.erdAddVirtual")}
        >
          <Icon name="plus" />
        </Button>
      </div>
      <div className="tw:flex tw:min-w-0 tw:shrink-0 tw:items-center tw:gap-2">
        {dirty && (
          <span className="badge tw:@max-[760px]:hidden">
            {t("schema.erdUnsaved")}
          </span>
        )}
        <button
          className="btn primary small"
          type="button"
          disabled={busy}
          onClick={onSave}
        >
          {busy ? t("common.loading") : t("common.save")}
        </button>
        <ToolbarMenu label={t("schema.erdExport")} icon="download">
          {(["svg", "png", "pdf", "json"] as const).map((format) => (
            <ToolbarMenuItem
              icon="download"
              key={format}
              onClick={() => onExport(format)}
            >
              {format.toUpperCase()}
            </ToolbarMenuItem>
          ))}
          <ToolbarMenuItem
            icon="copy"
            onClick={() => onExport("copy")}
          >
            {t("schema.erdCopyShare")}
          </ToolbarMenuItem>
        </ToolbarMenu>
      </div>
    </WorkbenchToolbar>
  );
}
