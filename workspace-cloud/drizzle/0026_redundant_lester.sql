CREATE TABLE "workspace_control"."workspace_sync_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"audit_event_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"operation" text NOT NULL,
	"tombstone" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_sync_event_sequence" CHECK ("workspace_control"."workspace_sync_event"."sequence" >= 1 AND "workspace_control"."workspace_sync_event"."sequence" <= 9007199254740991),
	CONSTRAINT "workspace_sync_event_resource_type_length" CHECK (char_length("workspace_control"."workspace_sync_event"."resource_type") BETWEEN 1 AND 64),
	CONSTRAINT "workspace_sync_event_operation_length" CHECK (char_length("workspace_control"."workspace_sync_event"."operation") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_sync_head" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"last_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_sync_head_sequence" CHECK ("workspace_control"."workspace_sync_head"."last_sequence" >= 0 AND "workspace_control"."workspace_sync_head"."last_sequence" <= 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_sync_event" ADD CONSTRAINT "workspace_sync_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_audit_org_id_idx" ON "workspace_control"."workspace_audit_event" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_sync_event" ADD CONSTRAINT "workspace_sync_event_org_audit_fk" FOREIGN KEY ("organization_id","audit_event_id") REFERENCES "workspace_control"."workspace_audit_event"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_sync_head" ADD CONSTRAINT "workspace_sync_head_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_sync_event_org_sequence_idx" ON "workspace_control"."workspace_sync_event" USING btree ("organization_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_sync_event_audit_idx" ON "workspace_control"."workspace_sync_event" USING btree ("audit_event_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "workspace_control"."append_workspace_sync_event"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, workspace_control
AS $$
DECLARE
	allocated_sequence bigint;
BEGIN
	-- Lease issue/release/cleanup events are audit facts, not shared-resource
	-- mutations. Excluding this high-frequency class keeps the durable cursor
	-- bounded without weakening the credential audit trail itself.
	IF NEW."action" LIKE 'credential.lease.%'
		OR (
			NEW."action" LIKE 'workspace.backup.%'
			AND NEW."action" <> 'workspace.backup.restore'
		)
		OR NEW."action" LIKE 'workspace.data_key.%' THEN
		RETURN NEW;
	END IF;

	INSERT INTO "workspace_control"."workspace_sync_head"
		("organization_id", "last_sequence", "updated_at")
	VALUES (NEW."organization_id", 0, NEW."created_at")
	ON CONFLICT ("organization_id") DO NOTHING;

	UPDATE "workspace_control"."workspace_sync_head"
	SET "last_sequence" = "last_sequence" + 1,
		"updated_at" = NEW."created_at"
	WHERE "organization_id" = NEW."organization_id"
		AND "last_sequence" < 9007199254740991
	RETURNING "last_sequence" INTO allocated_sequence;

	IF allocated_sequence IS NULL THEN
		RAISE EXCEPTION 'workspace sync sequence exhausted';
	END IF;

	INSERT INTO "workspace_control"."workspace_sync_event"
		("organization_id", "sequence", "audit_event_id", "resource_type",
		 "operation", "tombstone", "created_at")
	VALUES (
		NEW."organization_id",
		allocated_sequence,
		NEW."id",
		NEW."resource_type",
		NEW."action",
		NEW."action" LIKE '%.delete%'
			OR NEW."action" LIKE '%.revoke%'
			OR NEW."action" LIKE '%.remove%'
			OR NEW."action" LIKE '%.archive%',
		NEW."created_at"
	);
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "workspace_audit_append_sync_event"
AFTER INSERT ON "workspace_control"."workspace_audit_event"
FOR EACH ROW
EXECUTE FUNCTION "workspace_control"."append_workspace_sync_event"();
