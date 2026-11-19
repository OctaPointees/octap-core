CREATE TYPE "public"."voucher_approval_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');--> statement-breakpoint
ALTER TYPE "public"."voucher_status" ADD VALUE 'PENDING_APPROVAL';--> statement-breakpoint
CREATE TABLE "voucher_approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	"status" "voucher_approval_status" DEFAULT 'PENDING' NOT NULL,
	"submitted_by_user_id" uuid,
	"submitted_by_credential_id" uuid,
	"reviewed_by_id" uuid,
	"reason" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "voucher_approval_requests_one_submitter" CHECK (num_nonnulls("voucher_approval_requests"."submitted_by_user_id", "voucher_approval_requests"."submitted_by_credential_id") <= 1)
);
--> statement-breakpoint
ALTER TABLE "voucher_approval_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "voucher_approval_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "voucher_approval_requests" ADD CONSTRAINT "voucher_approval_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_approval_requests" ADD CONSTRAINT "voucher_approval_requests_voucher_id_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_approval_requests" ADD CONSTRAINT "voucher_approval_requests_submitted_by_user_id_system_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."system_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_approval_requests" ADD CONSTRAINT "voucher_approval_requests_submitted_by_credential_id_api_credentials_id_fk" FOREIGN KEY ("submitted_by_credential_id") REFERENCES "public"."api_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_approval_requests" ADD CONSTRAINT "voucher_approval_requests_reviewed_by_id_system_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."system_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voucher_approval_requests_voucher_idx" ON "voucher_approval_requests" USING btree ("voucher_id","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "voucher_approval_requests_one_pending_idx" ON "voucher_approval_requests" USING btree ("voucher_id") WHERE "voucher_approval_requests"."status" = 'PENDING';--> statement-breakpoint
CREATE POLICY "tenant_manage_voucher_approval_requests" ON "voucher_approval_requests" AS PERMISSIVE FOR ALL TO "authenticated" USING ("voucher_approval_requests"."organization_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')) and exists (select 1 from "vouchers" where "vouchers"."id" = "voucher_approval_requests"."voucher_id" and "vouchers"."organization_id" = "voucher_approval_requests"."organization_id"));