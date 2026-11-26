DROP TABLE "billing_plans" CASCADE;--> statement-breakpoint
DROP TABLE "invoices" CASCADE;--> statement-breakpoint
DROP TABLE "payment_methods" CASCADE;--> statement-breakpoint
DROP TABLE "subscriptions" CASCADE;--> statement-breakpoint
DROP TYPE "public"."billing_plan_interval";--> statement-breakpoint
DROP TYPE "public"."invoice_status";--> statement-breakpoint
DROP TYPE "public"."subscription_status";--> statement-breakpoint
CREATE TYPE "public"."license_source" AS ENUM('TRIAL', 'MIGRATION', 'PURCHASE', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."license_tier" AS ENUM('TRIAL', 'STARTER', 'GROWTH', 'ENTERPRISE');--> statement-breakpoint
CREATE TABLE "license_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tier" "license_tier" NOT NULL,
	"name" text NOT NULL,
	"monthly_price_vnd" integer NOT NULL,
	"term_months_allowed" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"duration_days" integer,
	"entitlements" jsonb NOT NULL,
	"purchasable" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "license_plans_price_not_negative" CHECK ("license_plans"."monthly_price_vnd" >= 0),
	CONSTRAINT "license_plans_duration_positive" CHECK ("license_plans"."duration_days" is null or "license_plans"."duration_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "licenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"tier" "license_tier" NOT NULL,
	"plan_name" text NOT NULL,
	"entitlements" jsonb NOT NULL,
	"source" "license_source" NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "licenses_ends_after_start" CHECK ("licenses"."ends_at" > "licenses"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "licenses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_plan_id_license_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."license_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "licenses_organization_starts_idx" ON "licenses" USING btree ("organization_id","starts_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation_licenses" ON "licenses" AS PERMISSIVE FOR ALL TO "authenticated" USING ("licenses"."organization_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')));--> statement-breakpoint
-- The catalogue to start from (OCT-329). Sample prices and limits: the System Admin edits them.
-- The trial gets Growth's features with small limits; Enterprise is granted by contract, not bought.
INSERT INTO "license_plans" ("tier", "name", "monthly_price_vnd", "term_months_allowed", "duration_days", "entitlements", "purchasable") VALUES
  ('TRIAL', 'Trial', 0, '{}', 14,
   '{"features":["voucher.batches","voucher.approval","webhooks","mcp","assistant","sandbox"],"limits":{"transactionsMonthly":1000,"members":500,"apiKeys":2,"teamMembers":3}}', false),
  ('STARTER', 'Starter', 990000, '{3,6,12}', NULL,
   '{"features":["voucher.batches","webhooks","sandbox"],"limits":{"transactionsMonthly":10000,"members":5000,"apiKeys":2,"teamMembers":3}}', true),
  ('GROWTH', 'Growth', 2990000, '{3,6,12}', NULL,
   '{"features":["voucher.batches","voucher.approval","webhooks","mcp","assistant","sandbox"],"limits":{"transactionsMonthly":50000,"members":50000,"apiKeys":10,"teamMembers":10}}', true),
  ('ENTERPRISE', 'Enterprise', 0, '{}', NULL,
   '{"features":["voucher.batches","voucher.approval","webhooks","mcp","assistant","sandbox"],"limits":{"transactionsMonthly":null,"members":null,"apiKeys":25,"teamMembers":null}}', false);--> statement-breakpoint
-- Every organization already here keeps working: Growth for 12 months, free.
INSERT INTO "licenses" ("organization_id", "plan_id", "tier", "plan_name", "entitlements", "source", "starts_at", "ends_at")
SELECT o."id", p."id", p."tier", p."name", p."entitlements", 'MIGRATION', now(), now() + interval '12 months'
FROM "organizations" o
CROSS JOIN (SELECT * FROM "license_plans" WHERE "tier" = 'GROWTH' LIMIT 1) p
WHERE o."status" <> 'ARCHIVED';
