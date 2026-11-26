CREATE TABLE "license_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"license_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"transactions" integer DEFAULT 0 NOT NULL,
	"warned_80_at" timestamp with time zone,
	"warned_100_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "license_usage_transactions_not_negative" CHECK ("license_usage"."transactions" >= 0)
);
--> statement-breakpoint
ALTER TABLE "license_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "license_usage" ADD CONSTRAINT "license_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_usage" ADD CONSTRAINT "license_usage_license_id_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."licenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "license_usage_license_period_idx" ON "license_usage" USING btree ("license_id","period_start");--> statement-breakpoint
CREATE POLICY "tenant_isolation_license_usage" ON "license_usage" AS PERMISSIVE FOR ALL TO "authenticated" USING ("license_usage"."organization_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')));