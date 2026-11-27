CREATE TYPE "public"."license_order_status" AS ENUM('PENDING', 'PAID', 'CANCELED');--> statement-breakpoint
CREATE TABLE "license_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"tier" "license_tier" NOT NULL,
	"plan_name" text NOT NULL,
	"term_months" integer NOT NULL,
	"amount_vnd" integer NOT NULL,
	"payment_code" text NOT NULL,
	"status" "license_order_status" DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_id" uuid,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "license_orders_amount_positive" CHECK ("license_orders"."amount_vnd" > 0),
	CONSTRAINT "license_orders_term_positive" CHECK ("license_orders"."term_months" > 0)
);
--> statement-breakpoint
ALTER TABLE "license_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "license_orders" ADD CONSTRAINT "license_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_orders" ADD CONSTRAINT "license_orders_plan_id_license_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."license_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_orders" ADD CONSTRAINT "license_orders_created_by_id_system_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."system_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "license_orders_payment_code_idx" ON "license_orders" USING btree ("payment_code");--> statement-breakpoint
CREATE INDEX "license_orders_organization_created_idx" ON "license_orders" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation_license_orders" ON "license_orders" AS PERMISSIVE FOR ALL TO "authenticated" USING ("license_orders"."organization_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')));