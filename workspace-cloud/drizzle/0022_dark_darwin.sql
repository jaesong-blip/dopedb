CREATE TABLE "workspace_control"."workspace_data_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"version" integer NOT NULL,
	"key_reference" text NOT NULL,
	"kms_key_version" text NOT NULL,
	"wrapped_key" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"destroyed_at" timestamp with time zone,
	CONSTRAINT "workspace_data_key_version" CHECK ("workspace_control"."workspace_data_key"."version" >= 1 AND "workspace_control"."workspace_data_key"."version" <= 2147483647),
	CONSTRAINT "workspace_data_key_reference_length" CHECK (char_length("workspace_control"."workspace_data_key"."key_reference") BETWEEN 20 AND 512),
	CONSTRAINT "workspace_data_key_kms_version" CHECK ("workspace_control"."workspace_data_key"."kms_key_version" ~ '^projects/[A-Za-z0-9._:-]+/locations/[A-Za-z0-9_-]+/keyRings/[A-Za-z0-9_-]+/cryptoKeys/[A-Za-z0-9_-]+/cryptoKeyVersions/[1-9][0-9]*$'),
	CONSTRAINT "workspace_data_key_wrapped_key" CHECK (("workspace_control"."workspace_data_key"."wrapped_key" IS NOT NULL
          AND char_length("workspace_control"."workspace_data_key"."wrapped_key") BETWEEN 1 AND 8192
          AND "workspace_control"."workspace_data_key"."wrapped_key" ~ '^[A-Za-z0-9+/]+={0,2}$'
          AND "workspace_control"."workspace_data_key"."destroyed_at" IS NULL)
        OR ("workspace_control"."workspace_data_key"."wrapped_key" IS NULL
          AND "workspace_control"."workspace_data_key"."destroyed_at" IS NOT NULL
          AND "workspace_control"."workspace_data_key"."retired_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_data_key_rotation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"from_data_key_id" uuid,
	"to_data_key_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"processed_backups" integer DEFAULT 0 NOT NULL,
	"claim_id" uuid,
	"claim_expires_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "workspace_data_key_rotation_status" CHECK ("workspace_control"."workspace_data_key_rotation"."status" IN ('running', 'completed')),
	CONSTRAINT "workspace_data_key_rotation_processed" CHECK ("workspace_control"."workspace_data_key_rotation"."processed_backups" >= 0),
	CONSTRAINT "workspace_data_key_rotation_claim" CHECK (("workspace_control"."workspace_data_key_rotation"."claim_id" IS NULL AND "workspace_control"."workspace_data_key_rotation"."claim_expires_at" IS NULL)
        OR ("workspace_control"."workspace_data_key_rotation"."status" = 'running'
          AND "workspace_control"."workspace_data_key_rotation"."claim_id" IS NOT NULL
          AND "workspace_control"."workspace_data_key_rotation"."claim_expires_at" IS NOT NULL)),
	CONSTRAINT "workspace_data_key_rotation_completion" CHECK (("workspace_control"."workspace_data_key_rotation"."status" = 'running' AND "workspace_control"."workspace_data_key_rotation"."completed_at" IS NULL)
        OR ("workspace_control"."workspace_data_key_rotation"."status" = 'completed' AND "workspace_control"."workspace_data_key_rotation"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_metadata_backup" ADD COLUMN "data_key_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_metadata_backup" ADD COLUMN "reencrypted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_data_key" ADD CONSTRAINT "workspace_data_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_data_key" ADD CONSTRAINT "workspace_data_key_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "workspace_control"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_data_key_org_id_idx" ON "workspace_control"."workspace_data_key" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_data_key_rotation" ADD CONSTRAINT "workspace_data_key_rotation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_data_key_rotation" ADD CONSTRAINT "workspace_data_key_rotation_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "workspace_control"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_data_key_rotation" ADD CONSTRAINT "workspace_data_key_rotation_org_from_key_fk" FOREIGN KEY ("organization_id","from_data_key_id") REFERENCES "workspace_control"."workspace_data_key"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_data_key_rotation" ADD CONSTRAINT "workspace_data_key_rotation_org_to_key_fk" FOREIGN KEY ("organization_id","to_data_key_id") REFERENCES "workspace_control"."workspace_data_key"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_data_key_org_version_idx" ON "workspace_control"."workspace_data_key" USING btree ("organization_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_data_key_org_active_idx" ON "workspace_control"."workspace_data_key" USING btree ("organization_id") WHERE "retired_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_data_key_rotation_org_id_idx" ON "workspace_control"."workspace_data_key_rotation" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_data_key_rotation_org_running_idx" ON "workspace_control"."workspace_data_key_rotation" USING btree ("organization_id") WHERE "status" = 'running';--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_metadata_backup" ADD CONSTRAINT "workspace_metadata_backup_org_data_key_fk" FOREIGN KEY ("organization_id","data_key_id") REFERENCES "workspace_control"."workspace_data_key"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_metadata_backup_org_data_key_idx" ON "workspace_control"."workspace_metadata_backup" USING btree ("organization_id","data_key_id");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_metadata_backup" ADD CONSTRAINT "workspace_metadata_backup_key_binding" CHECK (("workspace_control"."workspace_metadata_backup"."data_key_id" IS NULL
          AND "workspace_control"."workspace_metadata_backup"."key_reference" = 'dopedb-workspace-backup-hkdf-sha256'
          AND "workspace_control"."workspace_metadata_backup"."key_version" = 'v1')
        OR ("workspace_control"."workspace_metadata_backup"."data_key_id" IS NOT NULL
          AND "workspace_control"."workspace_metadata_backup"."key_reference" = 'dopedb-workspace-data-key'
          AND "workspace_control"."workspace_metadata_backup"."key_version" ~ '^v[1-9][0-9]*$'));
