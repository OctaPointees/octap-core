CREATE TYPE "public"."evidence_archive_status" AS ENUM('PENDING', 'ARCHIVED', 'DISABLED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."evidence_period_status" AS ENUM('SEALING', 'SEALED');--> statement-breakpoint
CREATE TABLE "evidence_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"ledger_count" integer NOT NULL,
	"ledger_hash" text NOT NULL,
	"audit_count" integer NOT NULL,
	"audit_hash" text NOT NULL,
	"previous_manifest_hash" text,
	"manifest_hash" text NOT NULL,
	"status" "evidence_period_status" DEFAULT 'SEALING' NOT NULL,
	"network" text NOT NULL,
	"seal_object_id" text,
	"seal_digest" text,
	"sealed_at" timestamp with time zone,
	"archive_status" "evidence_archive_status" DEFAULT 'PENDING' NOT NULL,
	"archive_file_id" text,
	"walrus_blob_id" text,
	"archived_at" timestamp with time zone,
	"archive_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence_periods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence_periods" ADD CONSTRAINT "evidence_periods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_periods_org_start_idx" ON "evidence_periods" USING btree ("organization_id","period_start");--> statement-breakpoint
CREATE INDEX "evidence_periods_archive_idx" ON "evidence_periods" USING btree ("archive_status","status") WHERE "evidence_periods"."archive_status" = 'PENDING';--> statement-breakpoint
CREATE POLICY "tenant_read_evidence_periods" ON "evidence_periods" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("evidence_periods"."organization_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')));