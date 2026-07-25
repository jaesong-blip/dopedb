// Flat command bar for ERD layout, persistence, virtual edges, and local export.
import type { ErdLayout, ErdLayoutMode } from "../ipc/types";
import { Icon } from "./Icon";
import ToolbarMenu from "./ToolbarMenu";
import { useI18n } from "../lib/i18n";
import "./ErdToolbar.css";

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
  activeLayoutId: string | null;
  name: string;
  mode: ErdLayoutMode;
  compact: boolean;
  neighborhood: boolean;
  dirty: boolean;
  busy: boolean;
  onSelectLayout: (id: string | null) => void;
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
    <div className="erd-toolbar ds-toolbar ds-control-row">
      <div className="erd-toolbar-scroll scrollbar-sleek">
        <select
          value={activeLayoutId ?? ""}
          onChange={(event) => onSelectLayout(event.target.value || null)}
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
          value={name}
          onChange={(event) => onName(event.target.value)}
          aria-label={t("schema.erdLayoutName")}
          placeholder={t("schema.erdLayoutName")}
        />
        <select
          value={mode}
          onChange={(event) => onMode(event.target.value as ErdLayoutMode)}
          aria-label={t("schema.erdMode")}
        >
          <option value="physical">{t("schema.erdPhysical")}</option>
          <option value="logical">{t("schema.erdLogical")}</option>
          <option value="uml">{t("schema.erdUml")}</option>
        </select>
        <button
          className="btn small icon-only"
          type="button"
          disabled={busy}
          onClick={onAutoLayout}
          title={t("schema.erdAutoLayout")}
          aria-label={t("schema.erdAutoLayout")}
        >
          <Icon name="refresh" />
        </button>
        <button
          className={`btn small icon-only${compact ? " active" : ""}`}
          type="button"
          onClick={onToggleCompact}
          title={t("schema.erdCompact")}
          aria-label={t("schema.erdCompact")}
          aria-pressed={compact}
        >
          <Icon name="columns" />
        </button>
        <button
          className={`btn small icon-only${neighborhood ? " active" : ""}`}
          type="button"
          onClick={onToggleNeighborhood}
          title={t(
            neighborhood ? "schema.erdShowAll" : "schema.erdNeighborhood",
          )}
          aria-label={t(
            neighborhood ? "schema.erdShowAll" : "schema.erdNeighborhood",
          )}
          aria-pressed={neighborhood}
        >
          <Icon name="target" />
        </button>
        <button
          className="btn small icon-only"
          type="button"
          onClick={onAddRelation}
          title={t("schema.erdAddVirtual")}
          aria-label={t("schema.erdAddVirtual")}
        >
          <Icon name="plus" />
        </button>
      </div>
      <div className="erd-toolbar-end">
        {dirty && <span className="badge erd-unsaved-badge">{t("schema.erdUnsaved")}</span>}
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
            <button
              className="ds-menu-item"
              type="button"
              role="menuitem"
              key={format}
              onClick={() => onExport(format)}
            >
              {format.toUpperCase()}
            </button>
          ))}
          <button
            className="ds-menu-item"
            type="button"
            role="menuitem"
            onClick={() => onExport("copy")}
          >
            {t("schema.erdCopyShare")}
          </button>
        </ToolbarMenu>
      </div>
    </div>
  );
}
