CREATE TYPE "public"."voucher_batch_source" AS ENUM('CONSOLE', 'API');--> statement-breakpoint
CREATE TABLE "voucher_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source" "voucher_batch_source" NOT NULL,
	"created_by_user_id" uuid,
	"created_by_credential_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "voucher_import_batches_one_creator" CHECK (num_nonnulls("voucher_import_batches"."created_by_user_id", "voucher_import_batches"."created_by_credential_id") <= 1)
);
--> statement-breakpoint
ALTER TABLE "voucher_import_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "voucher_import_batches" ADD CONSTRAINT "voucher_import_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_import_batches" ADD CONSTRAINT "voucher_import_batches_created_by_user_id_system_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."system_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_import_batches" ADD CONSTRAINT "voucher_import_batches_created_by_credential_id_api_credentials_id_fk" FOREIGN KEY ("created_by_credential_id") REFERENCES "public"."api_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voucher_import_batches_org_created_idx" ON "voucher_import_batches" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "voucher_import_batches_org_id_idx" ON "voucher_import_batches" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_import_batch_fk" FOREIGN KEY ("organization_id","import_batch_id") REFERENCES "public"."voucher_import_batches"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vouchers_import_batch_idx" ON "vouchers" USING btree ("import_batch_id");--> statement-breakpoint
CREATE POLICY "tenant_manage_voucher_import_batches" ON "voucher_import_batches" AS PERMISSIVE FOR ALL TO "authenticated" USING ("voucher_import_batches"."organization_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')));