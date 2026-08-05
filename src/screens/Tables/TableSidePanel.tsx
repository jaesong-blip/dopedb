import CellViewer from "../../components/CellViewer";
import { Icon } from "../../components/Icon";
import { Button } from "../../design-system/components/Button";
import RowEditor, {
  type RowEditorSubmission,
} from "../../components/RowEditor";
import {
  InspectorFooter,
  InspectorHeader,
} from "../../design-system/components/Workbench";
import type { CatalogTable, ScriptOperationProposal } from "../../ipc/types";
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
    <aside className="tw:w-[clamp(320px,32vw,480px)] tw:max-w-[44%] tw:shrink-0 tw:overflow-auto tw:overscroll-contain tw:border-l tw:border-border-subtle tw:bg-card tw:p-3 tw:@max-[920px]:max-h-[42%] tw:@max-[920px]:w-auto tw:@max-[920px]:max-w-none tw:@max-[760px]:max-h-[44%]">
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
        <div>
          <InspectorHeader
            title={t("tables.deleteRow")}
            actions={
              <Button
                iconOnly
                size="xs"
                variant="ghost"
                aria-label={t("common.cancel")}
                onClick={props.onCloseDelete}
              >
                <Icon name="close" />
              </Button>
            }
          />
          <div className="tw:mb-3 tw:flex tw:flex-col tw:gap-2">
            {Object.entries(pendingDelete.key).map(([key, value]) => (
              <div key={key}>
                <label className="tw:mb-px tw:flex tw:min-w-0 tw:items-center tw:gap-2 tw:overflow-hidden tw:text-sm tw:text-ellipsis tw:whitespace-nowrap">
                  {key}
                  <span className="tw:rounded-xs tw:border tw:border-primary tw:px-0.5 tw:text-2xs tw:font-bold tw:text-primary">
                    PK
                  </span>
                </label>
                <code>{value == null ? "NULL" : value}</code>
              </div>
            ))}
          </div>
          <InspectorFooter>
            <Button variant="primary" onClick={props.onArmDelete}>
              {t("tables.reviewDelete")}
            </Button>
            <Button onClick={props.onCloseDelete}>{t("common.cancel")}</Button>
          </InspectorFooter>
        </div>
      )}
      {reviewing && (
        <div>
          <InspectorHeader
            title={t("tables.stagedCount", { count: staged.length })}
            metadata={
              <span className="tw:text-muted-foreground">
                {t("tables.stagedAtomicHelp")}
              </span>
            }
            actions={
              <Button
                iconOnly
                size="xs"
                variant="ghost"
                aria-label={t("common.close")}
                onClick={props.onCloseReview}
              >
                <Icon name="close" />
              </Button>
            }
          />
          <ol className="tw:m-0 tw:grid tw:list-none tw:gap-0 tw:p-0 tw:[&_li]:flex tw:[&_li]:items-start tw:[&_li]:justify-between tw:[&_li]:gap-2 tw:[&_li]:border-t tw:[&_li]:border-border-subtle tw:[&_li]:py-2 tw:[&_li>div]:min-w-0 tw:[&_strong]:block tw:[&_code]:mt-1 tw:[&_code]:block tw:[&_code]:[overflow-wrap:anywhere] tw:[&_code]:text-xs tw:[&_code]:text-muted-foreground">
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
                  <Button
                    iconOnly
                    size="xs"
                    variant="ghost"
                    onClick={() => props.onRemoveStaged(change.id)}
                    aria-label={t("common.delete")}
                  >
                    <Icon name="close" />
                  </Button>
                )}
              </li>
            ))}
          </ol>
          {proposal?.confirmationPhrase && (
            <label className="tw:mt-3 tw:grid tw:gap-2 tw:text-sm tw:[&_input]:w-full tw:[&_input]:font-mono">
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
          <InspectorFooter>
            {!proposal ? (
              <Button
                variant="primary"
                disabled={staged.length === 0 || running || catalogPending}
                onClick={props.onPrepare}
              >
                {running ? t("common.loading") : t("tables.reviewAndApply")}
              </Button>
            ) : (
              <>
                <Button
                  variant="primary"
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
                </Button>
                <Button disabled={running} onClick={props.onReject}>
                  {t("approval.reject")}
                </Button>
              </>
            )}
          </InspectorFooter>
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
