// Generated from dopedb-protocol public serde DTOs by ts-rs 12.0.1.
// Keep this checked-in wire contract synchronized with the Rust DTOs.

export type DatabaseEngine = "postgres" | "mysql" | "sqlite" | "mongodb";
export type OperationState = "planned" | "pending_approval" | "ready" | "approved" | "rejected" | "expired" | "cancelled" | "executing" | "succeeded" | "failed" | "outcome_unknown";
export type CatalogSnapshot = { schemaVersion: number, connectionId: string, engine: DatabaseEngine, database: string, capturedAt: string, fingerprint: string, namespaces: Array<Namespace>, relations: Array<Relation>, routines: Array<Routine>, otherObjects: Array<DatabaseObject>, };
export type Namespace = { name: string, comment?: string | null, };
export type ObjectKind = "table" | "view" | "materialized_view" | "routine" | "sequence" | "type" | "trigger" | "other";
export type ObjectRef = { catalog?: string | null, namespace?: string | null, name: string, kind: ObjectKind, nativeId?: string | null, };
export type NormalizedTypeFamily = "boolean" | "integer" | "decimal" | "float" | "text" | "binary" | "json" | "date" | "time" | "timestamp" | "uuid" | "array" | "document" | "other";
export type Column = { name: string, ordinal: number, nativeType: string, typeFamily: NormalizedTypeFamily, length?: number | null, precision?: number | null, scale?: number | null, nullable: boolean, defaultExpression?: string | null, generatedExpression?: string | null, identity: boolean, autoIncrement: boolean, collation?: string | null, comment?: string | null, sensitivity?: string | null, };
export type ConstraintKind = "primary" | "unique" | "foreign" | "check";
export type Constraint = { name: string, kind: ConstraintKind, columns: Array<string>, referencedRelation?: ObjectRef | null, referencedColumns: Array<string>, checkExpression?: string | null, updateAction?: string | null, deleteAction?: string | null, deferrable: boolean, validated: boolean, };
export type SortDirection = "asc" | "desc";
export type IndexKey = { column?: string | null, expression?: string | null, direction?: SortDirection | null, };
export type Index = { name: string, method?: string | null, keys: Array<IndexKey>, includedColumns: Array<string>, predicate?: string | null, unique: boolean, valid: boolean, };
export type Relation = { object: ObjectRef, comment?: string | null, rowEstimate?: number | null, partitionParent?: ObjectRef | null, partitionChildren: Array<ObjectRef>, columns: Array<Column>, constraints: Array<Constraint>, indexes: Array<Index>, };
export type Routine = { object: ObjectRef,
/**
 * Engine-native routine kind (`function`, `procedure`, ...), when available.
 */
nativeKind?: string | null, arguments: Array<string>, returnType?: string | null, language?: string | null, comment?: string | null,
/**
 * Lossless compact metadata used by object explorers.
 */
detail?: string | null,
/**
 * Owning relation for objects such as table triggers.
 */
parent?: string | null, };
export type DatabaseObject = { object: ObjectRef, nativeKind?: string | null, comment?: string | null, detail?: string | null, parent?: string | null, };
export type ConnectionSelector = string;
export type ConnectionSummary = { id: string, name: string, engine: DatabaseEngine, database: string, environment?: string | null, readonly: boolean, allowWrites: boolean, };
export type ConnectionListResult = { connections: Array<ConnectionSummary>, };
export type ConnectionSelectorArguments = { connection: ConnectionSelector, };
export type ConnectionTestResult = { connection: ConnectionSummary, reachable: boolean, };
export type SkillTarget = "codex" | "claude-code";
export type SkillTargetSelection = "all" | "codex" | "claude-code";
export type SkillInstallState = "missing" | "managed_current" | "managed_older" | "user_modified" | "newer_known" | "unknown_conflict" | "invalid";
export type SkillStatusReason = "files_differ_from_managed_snapshot" | "install_path_inspection_failed" | "install_path_symlink" | "install_root_not_directory" | "install_target_not_directory" | "install_target_outside_home" | "install_target_symlink" | "installed_file_changed" | "installed_file_too_large" | "installed_skill_byte_limit" | "installed_skill_file_count_limit" | "installed_skill_nesting_limit" | "installed_skill_non_unicode_path" | "installed_skill_read_failed" | "installed_skill_symlink" | "installed_skill_unsafe_path" | "installed_skill_unsupported_file" | "inventory_escaped_root" | "provenance_marker_malformed" | "provenance_marker_not_file" | "provenance_marker_unreadable" | "unknown_managed_snapshot" | "unmanaged_files" | "unsafe_path_component";
export type SkillConflictKind = "missing" | "modified" | "unexpected" | "invalid_provenance";
export type SkillConflict = { path: string, kind: SkillConflictKind, };
export type SkillSummary = { name: string, releaseRevision: number, appVersion: string, packageDigest: string, };
export type SkillsListResult = { skills: Array<SkillSummary>, };
export type SkillsGetArguments = { name: string, full: boolean, };
export type SkillGuideFile = { path: string, content: string, };
export type SkillsGetResult = { skill: SkillSummary, guide: string, references: Array<SkillGuideFile>, };
export type SkillStatusArguments = { target: SkillTargetSelection, };
export type SkillTargetStatus = { target: SkillTarget, displayName: string, installPath: string, state: SkillInstallState, repairable: boolean, currentRevision: number, installedRevision: number | null, installedPackageDigest: string | null, inventoryFingerprint: string, reason: SkillStatusReason | null, conflicts: Array<SkillConflict>, };
export type SkillStatusResult = { skill: SkillSummary, targets: Array<SkillTargetStatus>, };
export type SkillTargetExpectation = { target: SkillTarget, inventoryFingerprint: string, };
export type SkillMutationArguments = { target: SkillTargetSelection, expected: Array<SkillTargetExpectation>, };
export type SkillBackup = { target: SkillTarget, path: string, };
export type SkillMutationResult = { status: SkillStatusResult, changedTargets: Array<SkillTarget>, backups: Array<SkillBackup>, };
