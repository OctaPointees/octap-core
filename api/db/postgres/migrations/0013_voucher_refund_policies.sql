CREATE TABLE "voucher_refund_policies" (
	"organization_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"policy" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_by_credential_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voucher_refund_policies_organization_id_version_pk" PRIMARY KEY("organization_id","version")
);
--> statement-breakpoint
ALTER TABLE "voucher_refund_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "voucher_ownerships" ADD COLUMN "refund_policy_snapshot" jsonb DEFAULT '{"version":0,"allowUnused":true,"allowExpired":false,"allowRedeemed":false,"restockUnused":true,"refundWindowDays":null}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "voucher_refund_policies" ADD CONSTRAINT "voucher_refund_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_read_refund_policies" ON "voucher_refund_policies" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("voucher_refund_policies"."organization_id"::text = current_setting('app.current_tenant_id', true));--> statement-breakpoint
CREATE POLICY "tenant_insert_refund_policies" ON "voucher_refund_policies" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("voucher_refund_policies"."organization_id"::text = current_setting('app.current_tenant_id', true));