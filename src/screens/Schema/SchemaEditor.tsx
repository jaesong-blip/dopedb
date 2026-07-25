// Structured schema mutations are assembled as a dialect-neutral DDL IR, previewed
// against one exact catalog fingerprint, and only then sent through the immutable
// Operation approval path. This component never concatenates executable SQL.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  approveOperation,
  previewSchemaChange,
  proposeSchemaChange,
  rejectOperation,
  runSchemaChange,
} from "../../ipc/commands";
import type {
  CatalogConstraint,
  CatalogConstraintKind,
  CatalogObjectRef,
  CatalogRelationV2,
  CatalogSnapshot,
  DdlDefaultChange,
  DdlPlan,
  Engine,
  SafetySettings,
  SchemaChange,
  SchemaChangeProposal,
  SchemaChangeRequest,
} from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import { Icon } from "../../components/Icon";
import LazySqlViewer from "../../components/LazySqlViewer";
import { useToast } from "../../components/Toast";
import { qk } from "../../lib/queries";
import { useI18n } from "../../lib/i18n";
import "./SchemaEditor.css";

type ChangeKind =
  | "create_table"
  | "rename_table"
  | "drop_table"
  | "add_column"
  | "alter_column"
  | "drop_column"
  | "add_constraint"
  | "drop_constraint"
  | "create_index"
  | "drop_index";

type NullableChoice = "keep" | "nullable" | "required";
type DefaultChoice = "keep" | "drop" | "set";

const TABLE_ACTIONS: ChangeKind[] = [
  "add_column",
  "alter_column",
  "drop_column",
  "create_index",
  "drop_index",
  "add_constraint",
  "drop_constraint",
  "rename_table",
  "drop_table",
];

function relationKey(reference: CatalogObjectRef) {
  return [
    reference.catalog ?? "",
    reference.namespace ?? "",
    reference.name,
    reference.kind,
  ].join("\u0000");
}

function splitColumns(value: string) {
  return value
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
}

function emptyConstraint(
  name: string,
  kind: CatalogConstraintKind,
  columns: string[],
): CatalogConstraint {
  return {
    name,
    kind,
    columns,
    referencedRelation: null,
    referencedColumns: [],
    checkExpression: null,
    updateAction: null,
    deleteAction: null,
    deferrable: false,
    validated: true,
  };
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="schema-edit-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export default function SchemaEditor({
  connectionId,
  engine,
  snapshot,
  relation,
  safety,
  onClose,
}: {
  connectionId: string;
  engine: Engine;
  snapshot: CatalogSnapshot;
  relation: CatalogRelationV2 | null;
  safety: SafetySettings;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const editableRelation = relation?.object.kind === "table" ? relation : null;
  const [kind, setKind] = useState<ChangeKind>(
    editableRelation ? "add_column" : "create_table",
  );
  const [name, setName] = useState("");
  const [nativeType, setNativeType] = useState("TEXT");
  const [nullable, setNullable] = useState(true);
  const [selectedColumn, setSelectedColumn] = useState("");
  const [newName, setNewName] = useState("");
  const [nullableChange, setNullableChange] =
    useState<NullableChoice>("keep");
  const [defaultChoice, setDefaultChoice] =
    useState<DefaultChoice>("drop");
  const [defaultExpression, setDefaultExpression] = useState("");
  const [columns, setColumns] = useState("");
  const [unique, setUnique] = useState(false);
  const [constraintKind, setConstraintKind] =
    useState<CatalogConstraintKind>("unique");
  const [referencedRelation, setReferencedRelation] = useState("");
  const [referencedColumns, setReferencedColumns] = useState("");
  const [checkExpression, setCheckExpression] = useState("");
  const [namespace, setNamespace] = useState(
    relation?.object.namespace ?? snapshot.namespaces[0]?.name ?? "",
  );
  const [plan, setPlan] = useState<DdlPlan | null>(null);
  const [proposal, setProposal] = useState<SchemaChangeProposal | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const relationIdentity = relation ? relationKey(relation.object) : "";
  useEffect(() => {
    setKind(relation?.object.kind === "table" ? "add_column" : "create_table");
    setSelectedColumn(relation?.columns[0]?.name ?? "");
    setNativeType("TEXT");
    setDefaultChoice("drop");
    setNamespace(
      relation?.object.namespace ?? snapshot.namespaces[0]?.name ?? "",
    );
    setName("");
    setPlan(null);
    setProposal(null);
    setError(null);
    setConfirmation("");
  }, [relationIdentity, snapshot.fingerprint]);

  const relationOptions = useMemo(
    () =>
      snapshot.relations.filter(
        (candidate) => candidate.object.kind === "table",
      ),
    [snapshot.relations],
  );

  function resetReview() {
    setPlan(null);
    setProposal(null);
    setConfirmation("");
    setError(null);
  }

  function changeKind(next: ChangeKind) {
    setKind(next);
    setName("");
    setSelectedColumn(
      next === "create_table"
        ? "id"
        : editableRelation?.columns[0]?.name ?? "",
    );
    setNativeType(next === "alter_column" ? "" : "TEXT");
    setDefaultChoice(next === "alter_column" ? "keep" : "drop");
    resetReview();
  }

  function requireRelation() {
    if (!editableRelation) {
      throw new Error(t("schema.editorSelectTable"));
    }
    return editableRelation;
  }

  function makeDefault(): DdlDefaultChange {
    if (defaultChoice === "drop") return { action: "drop" };
    if (defaultChoice === "set") {
      return { action: "set", expression: defaultExpression.trim() };
    }
    return { action: "keep" };
  }

  function buildChange(): SchemaChange {
    if (kind === "create_table") {
      const tableName = name.trim();
      const columnName = selectedColumn.trim() || "id";
      return {
        kind,
        table: {
          relation: {
            catalog: relation?.object.catalog ?? null,
            namespace: namespace.trim() || null,
            name: tableName,
            kind: "table",
            nativeId: null,
          },
          columns: [
            {
              name: columnName,
              nativeType: nativeType.trim(),
              nullable,
            },
          ],
          constraints: [],
          indexes: [],
        },
      };
    }

    const current = requireRelation();
    const reference = current.object;
    if (kind === "rename_table") {
      return { kind, relation: reference, newName: name.trim() };
    }
    if (kind === "drop_table") {
      return { kind, relation: reference };
    }
    if (kind === "add_column") {
      return {
        kind,
        relation: reference,
        column: {
          name: name.trim(),
          nativeType: nativeType.trim(),
          nullable,
          defaultExpression:
            defaultChoice === "set" ? defaultExpression.trim() : null,
        },
      };
    }
    if (kind === "alter_column") {
      return {
        kind,
        relation: reference,
        column: selectedColumn,
        alteration: {
          newName: newName.trim() || null,
          nativeType: nativeType.trim() || null,
          nullable:
            nullableChange === "keep"
              ? null
              : nullableChange === "nullable",
          default: makeDefault(),
        },
      };
    }
    if (kind === "drop_column") {
      return { kind, relation: reference, column: selectedColumn };
    }
    if (kind === "create_index") {
      return {
        kind,
        relation: reference,
        index: {
          name: name.trim(),
          columns: splitColumns(columns),
          keys: splitColumns(columns).map((column) => ({
            column,
            expression: null,
            direction: null,
          })),
          includedColumns: [],
          predicate: null,
          method: null,
          unique,
          valid: true,
        },
      };
    }
    if (kind === "drop_index") {
      return { kind, relation: reference, name: name.trim() };
    }
    if (kind === "drop_constraint") {
      return { kind, relation: reference, name: name.trim() };
    }

    const constraint = emptyConstraint(
      name.trim(),
      constraintKind,
      splitColumns(columns),
    );
    if (constraintKind === "check") {
      constraint.checkExpression = checkExpression.trim();
    }
    if (constraintKind === "foreign") {
      constraint.referencedRelation =
        relationOptions.find(
          (candidate) => relationKey(candidate.object) === referencedRelation,
        )?.object ?? null;
      constraint.referencedColumns = splitColumns(referencedColumns);
    }
    return {
      kind: "add_constraint",
      relation: reference,
      constraint,
    };
  }

  function buildRequest(): SchemaChangeRequest {
    return {
      schemaVersion: 1,
      catalogFingerprint: snapshot.fingerprint,
      change: buildChange(),
    };
  }

  async function preview() {
    setBusy(true);
    setError(null);
    setProposal(null);
    try {
      setPlan(await previewSchemaChange(connectionId, buildRequest()));
    } catch (cause) {
      setPlan(null);
      setError(errMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function prepareApproval() {
    setBusy(true);
    setError(null);
    try {
      const next = await proposeSchemaChange(connectionId, buildRequest());
      setProposal(next);
      setPlan(next.plan);
    } catch (cause) {
      setProposal(null);
      setError(errMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!proposal) return;
    setBusy(true);
    setError(null);
    try {
      await approveOperation(
        proposal.operationId,
        proposal.payloadHash,
        proposal.confirmationPhrase ? confirmation : undefined,
      );
      const outcome = await runSchemaChange(proposal.operationId);
      if (!outcome.committed) {
        throw new Error(t("schema.editorNotCommitted"));
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.catalog(connectionId) }),
        queryClient.invalidateQueries({
          queryKey: qk.catalogSnapshot(connectionId),
        }),
        queryClient.invalidateQueries({
          queryKey: ["tableRows", connectionId],
        }),
      ]);
      toast(t("schema.editorApplied"));
      onClose();
    } catch (cause) {
      setError(errMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!proposal) return;
    setBusy(true);
    setError(null);
    try {
      await rejectOperation(proposal.operationId, proposal.payloadHash);
      setProposal(null);
      setConfirmation("");
    } catch (cause) {
      setError(errMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const needsTable = TABLE_ACTIONS.includes(kind);
  const canPrepare = !busy && (!needsTable || editableRelation !== null);
  const confirmationMatches =
    !proposal?.confirmationPhrase ||
    confirmation === proposal.confirmationPhrase;

  return (
    <section className="schema-editor" aria-label={t("schema.editorTitle")}>
      <header className="schema-editor-head">
        <div>
          <strong>{t("schema.editorTitle")}</strong>
          <span className="muted">
            {editableRelation
              ? `${editableRelation.object.namespace ?? ""}.${editableRelation.object.name}`
              : t("schema.editorNewTable")}
          </span>
        </div>
        <button
          className="btn small icon-only icon-xs"
          type="button"
          onClick={onClose}
          title={t("common.close")}
          aria-label={t("common.close")}
        >
          <Icon name="close" />
        </button>
      </header>

      <div className="schema-editor-form">
        <Field label={t("schema.editorAction")}>
          <select
            value={kind}
            onChange={(event) => changeKind(event.target.value as ChangeKind)}
          >
            <option value="create_table">{t("schema.editorCreateTable")}</option>
            <option value="add_column" disabled={!editableRelation}>
              {t("schema.editorAddColumn")}
            </option>
            <option value="alter_column" disabled={!editableRelation}>
              {t("schema.editorAlterColumn")}
            </option>
            <option value="drop_column" disabled={!editableRelation}>
              {t("schema.editorDropColumn")}
            </option>
            <option value="create_index" disabled={!editableRelation}>
              {t("schema.editorCreateIndex")}
            </option>
            <option value="drop_index" disabled={!editableRelation}>
              {t("schema.editorDropIndex")}
            </option>
            <option value="add_constraint" disabled={!editableRelation}>
              {t("schema.editorAddConstraint")}
            </option>
            <option value="drop_constraint" disabled={!editableRelation}>
              {t("schema.editorDropConstraint")}
            </option>
            <option value="rename_table" disabled={!editableRelation}>
              {t("schema.editorRenameTable")}
            </option>
            <option value="drop_table" disabled={!editableRelation}>
              {t("schema.editorDropTable")}
            </option>
          </select>
        </Field>

        {kind === "create_table" && (
          <>
            <Field label={t("schema.editorNamespace")}>
              <input
                value={namespace}
                onChange={(event) => {
                  setNamespace(event.target.value);
                  resetReview();
                }}
                list="schema-editor-namespaces"
              />
            </Field>
            <datalist id="schema-editor-namespaces">
              {snapshot.namespaces.map((candidate) => (
                <option key={candidate.name} value={candidate.name} />
              ))}
            </datalist>
            <Field label={t("schema.editorTableName")}>
              <input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  resetReview();
                }}
              />
            </Field>
            <Field label={t("schema.editorFirstColumn")}>
              <input
                value={selectedColumn}
                onChange={(event) => {
                  setSelectedColumn(event.target.value);
                  resetReview();
                }}
              />
            </Field>
          </>
        )}

        {kind === "rename_table" && (
          <Field label={t("schema.editorNewName")}>
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                resetReview();
              }}
            />
          </Field>
        )}

        {(kind === "add_column" ||
          kind === "alter_column" ||
          kind === "drop_column") && (
          <Field label={t("schema.editorColumn")}>
            {kind === "add_column" ? (
              <input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  resetReview();
                }}
              />
            ) : (
              <select
                value={selectedColumn}
                onChange={(event) => {
                  setSelectedColumn(event.target.value);
                  resetReview();
                }}
              >
                {editableRelation?.columns.map((column) => (
                  <option key={column.name} value={column.name}>
                    {column.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}

        {(kind === "create_table" ||
          kind === "add_column" ||
          kind === "alter_column") && (
          <Field label={t("schema.editorNativeType")}>
            <input
              value={nativeType}
              onChange={(event) => {
                setNativeType(event.target.value);
                resetReview();
              }}
              placeholder={engine === "postgres" ? "TEXT" : "VARCHAR(255)"}
            />
          </Field>
        )}

        {(kind === "create_table" || kind === "add_column") && (
          <label className="schema-edit-check">
            <input
              type="checkbox"
              checked={nullable}
              onChange={(event) => {
                setNullable(event.target.checked);
                resetReview();
              }}
            />
            {t("schema.editorNullable")}
          </label>
        )}

        {kind === "alter_column" && (
          <>
            <Field label={t("schema.editorNewNameOptional")}>
              <input
                value={newName}
                onChange={(event) => {
                  setNewName(event.target.value);
                  resetReview();
                }}
              />
            </Field>
            <Field label={t("schema.editorNullability")}>
              <select
                value={nullableChange}
                onChange={(event) => {
                  setNullableChange(event.target.value as NullableChoice);
                  resetReview();
                }}
              >
                <option value="keep">{t("schema.editorKeep")}</option>
                <option value="nullable">{t("schema.editorNullable")}</option>
                <option value="required">{t("schema.editorRequired")}</option>
              </select>
            </Field>
          </>
        )}

        {(kind === "add_column" || kind === "alter_column") && (
          <>
            <Field label={t("schema.editorDefault")}>
              <select
                value={defaultChoice}
                onChange={(event) => {
                  setDefaultChoice(event.target.value as DefaultChoice);
                  resetReview();
                }}
              >
                {kind === "alter_column" && (
                  <option value="keep">{t("schema.editorKeep")}</option>
                )}
                <option value="drop">{t("schema.editorNoDefault")}</option>
                <option value="set">{t("schema.editorSetDefault")}</option>
              </select>
            </Field>
            {defaultChoice === "set" && (
              <Field label={t("schema.editorExpression")}>
                <input
                  value={defaultExpression}
                  onChange={(event) => {
                    setDefaultExpression(event.target.value);
                    resetReview();
                  }}
                />
              </Field>
            )}
          </>
        )}

        {(kind === "create_index" || kind === "add_constraint") && (
          <>
            <Field label={t("schema.editorName")}>
              <input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  resetReview();
                }}
              />
            </Field>
            <Field label={t("schema.editorColumns")}>
              <input
                value={columns}
                onChange={(event) => {
                  setColumns(event.target.value);
                  resetReview();
                }}
                placeholder={t("schema.editorColumnsPlaceholder")}
              />
            </Field>
          </>
        )}

        {kind === "create_index" && (
          <label className="schema-edit-check">
            <input
              type="checkbox"
              checked={unique}
              onChange={(event) => {
                setUnique(event.target.checked);
                resetReview();
              }}
            />
            {t("schema.editorUnique")}
          </label>
        )}

        {kind === "drop_index" && (
          <Field label={t("schema.editorIndex")}>
            <select
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                resetReview();
              }}
            >
              <option value="">{t("schema.editorChoose")}</option>
              {editableRelation?.indexes.map((index) => (
                <option key={index.name} value={index.name}>
                  {index.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        {kind === "add_constraint" && (
          <>
            <Field label={t("schema.editorConstraintKind")}>
              <select
                value={constraintKind}
                onChange={(event) => {
                  setConstraintKind(
                    event.target.value as CatalogConstraintKind,
                  );
                  resetReview();
                }}
              >
                <option value="primary">PRIMARY KEY</option>
                <option value="unique">UNIQUE</option>
                <option value="foreign">FOREIGN KEY</option>
                <option value="check">CHECK</option>
              </select>
            </Field>
            {constraintKind === "foreign" && (
              <>
                <Field label={t("schema.editorReferencedTable")}>
                  <select
                    value={referencedRelation}
                    onChange={(event) => {
                      setReferencedRelation(event.target.value);
                      resetReview();
                    }}
                  >
                    <option value="">{t("schema.editorChoose")}</option>
                    {relationOptions.map((candidate) => (
                      <option
                        key={relationKey(candidate.object)}
                        value={relationKey(candidate.object)}
                      >
                        {candidate.object.namespace
                          ? `${candidate.object.namespace}.${candidate.object.name}`
                          : candidate.object.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("schema.editorReferencedColumns")}>
                  <input
                    value={referencedColumns}
                    onChange={(event) => {
                      setReferencedColumns(event.target.value);
                      resetReview();
                    }}
                    placeholder={t("schema.editorColumnsPlaceholder")}
                  />
                </Field>
              </>
            )}
            {constraintKind === "check" && (
              <Field label={t("schema.editorExpression")}>
                <input
                  value={checkExpression}
                  onChange={(event) => {
                    setCheckExpression(event.target.value);
                    resetReview();
                  }}
                />
              </Field>
            )}
          </>
        )}

        {kind === "drop_constraint" && (
          <Field label={t("schema.editorConstraint")}>
            <select
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                resetReview();
              }}
            >
              <option value="">{t("schema.editorChoose")}</option>
              {editableRelation?.constraints.map((constraint) => (
                <option key={constraint.name} value={constraint.name}>
                  {constraint.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <div className="schema-editor-actions ds-control-row">
        <button
          className="btn small"
          type="button"
          disabled={!canPrepare}
          onClick={() => void preview()}
        >
          {busy ? t("common.loading") : t("schema.editorPreview")}
        </button>
        <button
          className="btn primary small"
          type="button"
          disabled={!canPrepare || !safety.allowWrites}
          onClick={() => void prepareApproval()}
          title={
            safety.allowWrites
              ? undefined
              : t("approval.writesDisabledCompact")
          }
        >
          {t("schema.editorReview")}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {plan && (
        <div className="schema-editor-preview">
          <div className="schema-editor-plan-meta">
            <span className="badge">{plan.engine}</span>
            <span className="muted">
              {t("schema.editorStatementCount", {
                count: plan.statements.length,
              })}
            </span>
            {plan.requiresRebuild && (
              <span className="badge risk-high">
                {t("schema.editorRebuild")}
              </span>
            )}
          </div>
          {plan.warnings.map((warning) => (
            <p className="warning" key={warning}>
              {warning}
            </p>
          ))}
          <LazySqlViewer value={plan.statements.join("\n")} minHeight="96px" />
        </div>
      )}

      {proposal && (
        <div className="schema-editor-approval">
          <code title={proposal.payloadHash}>
            {proposal.payloadHash.slice(0, 12)}
          </code>
          {proposal.confirmationPhrase && (
            <Field label={t("approval.confirmationPrompt")}>
              <input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder={proposal.confirmationPhrase}
              />
            </Field>
          )}
          <div className="ds-control-row">
            <button
              className="btn small"
              type="button"
              disabled={busy}
              onClick={() => void reject()}
            >
              {t("approval.reject")}
            </button>
            <button
              className="btn primary small"
              type="button"
              disabled={busy || !confirmationMatches}
              onClick={() => void apply()}
            >
              {busy ? t("approval.running") : t("approval.applyChange")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
