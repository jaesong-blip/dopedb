import CellViewer from "../../components/CellViewer";
import { Icon } from "../../components/Icon";
import RowEditor, {
  type RowEditorSubmission,
} from "../../components/RowEditor";
import type {
  CatalogTable,
  ScriptOperationProposal,
} from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import type { Engine } from "../../ipc/types";
import type {
  PendingDelete,
  RowEditorState,
  SelectedCell,
  StagedWrite,
} from "../../features/tableData/domain";

type Props = {
  engine: Engine;
  table: CatalogTable;
  selected: number | null;
  editor: RowEditorState | null;
  pendingDelete: PendingDelete | null;
  reviewing: boolean;
  staged: StagedWrite[];
  proposal: ScriptOperationProposal | null;
  confirmation: string;
  running: boolean;
  catalogPending: boolean;
  selectedCell: SelectedCell | null;
  onSubmit: (write: RowEditorSubmission) => void;
  onCloseEditor: () => void;
  onCloseDelete: () => void;
  onArmDelete: () => void;
  onCloseReview: () => void;
  onRemoveStaged: (id: string) => void;
  onConfirmation: (value: string) => void;
  onPrepare: () => void;
  onApprove: () => void;
  onReject: () => void;
  onCloseCell: () => void;
};

export default function TableSidePanel(props: Props) {
  const { t } = useI18n();
  const {
    engine,
    table,
    selected,
    editor,
    pendingDelete,
    reviewing,
    staged,
    proposal,
    confirmation,
    running,
    catalogPending,
    selectedCell,
  } = props;

  return (
    <aside className="grid-panel">
      {editor && !reviewing && (
        <RowEditor
          key={`${editor.mode}-${selected}`}
          engine={engine}
          table={table}
          mode={editor.mode}
          initial={editor.initial}
          onSubmit={props.onSubmit}
          onCancel={props.onCloseEditor}
        />
      )}
      {pendingDelete && (
        <div className="row-editor">
          <div className="panel-head">
            <strong>{t("tables.deleteRow")}</strong>
            <button
              className="btn small icon-only icon-xs"
              aria-label={t("common.cancel")}
              onClick={props.onCloseDelete}
            >
              <Icon name="close" />
            </button>
          </div>
          <div className="row-fields">
            {Object.entries(pendingDelete.key).map(([key, value]) => (
              <div className="row-field" key={key}>
                <label>
                  {key}
                  <span className="pk-badge">PK</span>
                </label>
                <code>{value == null ? "NULL" : value}</code>
              </div>
            ))}
          </div>
          <div className="row-editor-actions ds-action-row ds-control-row">
            <button className="btn primary" onClick={props.onArmDelete}>
              {t("tables.reviewDelete")}
            </button>
            <button className="btn" onClick={props.onCloseDelete}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
      {reviewing && (
        <div className="row-editor staged-change-review">
          <div className="panel-head">
            <div>
              <strong>{t("tables.stagedCount", { count: staged.length })}</strong>
              <div className="muted">{t("tables.stagedAtomicHelp")}</div>
            </div>
            <button
              className="btn small icon-only icon-xs"
              aria-label={t("common.close")}
              onClick={props.onCloseReview}
            >
              <Icon name="close" />
            </button>
          </div>
          <ol className="staged-change-list">
            {staged.map((change, index) => (
              <li key={change.id}>
                <div>
                  <strong>
                    {change.rationale ||
                      t("tables.stagedChange", { index: index + 1 })}
                  </strong>
                  <code>{change.sql}</code>
                </div>
                {!proposal && (
                  <button
                    className="btn small icon-only icon-xs"
                    onClick={() => props.onRemoveStaged(change.id)}
                    aria-label={t("common.delete")}
                  >
                    <Icon name="close" />
                  </button>
                )}
              </li>
            ))}
          </ol>
          {proposal?.confirmationPhrase && (
            <label className="staged-confirmation">
              <span>
                {t("approval.confirmationPrompt")}{" "}
                <code>{proposal.confirmationPhrase}</code>
              </span>
              <input
                value={confirmation}
                onChange={(event) => props.onConfirmation(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
          <div className="row-editor-actions ds-action-row ds-control-row">
            {!proposal ? (
              <button
                className="btn primary"
                disabled={staged.length === 0 || running || catalogPending}
                onClick={props.onPrepare}
              >
                {running ? t("common.loading") : t("tables.reviewAndApply")}
              </button>
            ) : (
              <>
                <button
                  className="btn primary"
                  disabled={
                    running ||
                    (!!proposal.confirmationPhrase &&
                      confirmation !== proposal.confirmationPhrase)
                  }
                  onClick={props.onApprove}
                >
                  {running
                    ? t("common.saving")
                    : t("approval.approveAndRunWrite")}
                </button>
                <button
                  className="btn"
                  disabled={running}
                  onClick={props.onReject}
                >
                  {t("approval.reject")}
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {selectedCell && !editor && !reviewing && (
        <CellViewer
          value={selectedCell.value}
          column={selectedCell.column}
          onClose={props.onCloseCell}
        />
      )}
    </aside>
  );
}
