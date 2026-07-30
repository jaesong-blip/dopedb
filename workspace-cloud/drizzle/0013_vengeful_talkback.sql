CREATE TABLE "workspace_control"."provider_setup_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"encrypted_credential" text NOT NULL,
	"account_label" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_setup_session_provider" CHECK ("workspace_control"."provider_setup_session"."provider" = 'gcpCloudSql')
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."provider_setup_session" ADD CONSTRAINT "provider_setup_session_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."provider_setup_session" ADD CONSTRAINT "provider_setup_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "workspace_control"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_setup_session_scope_idx" ON "workspace_control"."provider_setup_session" USING btree ("organization_id","user_id","provider");--> statement-breakpoint
CREATE INDEX "provider_setup_session_expiry_idx" ON "workspace_control"."provider_setup_session" USING btree ("expires_at");
