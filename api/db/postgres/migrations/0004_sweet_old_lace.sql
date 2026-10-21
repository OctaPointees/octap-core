CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"program_control_id" text NOT NULL,
	"admin_cap_id" text NOT NULL,
	"policy_version_id" text NOT NULL,
	"issuer_cap_id" text NOT NULL,
	"policy_version" integer NOT NULL,
	"earn_bps" integer NOT NULL,
	"expiry_ms" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "programs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "programs_organization_id_idx" ON "programs" USING btree ("organization_id");--> statement-breakpoint
CREATE POLICY "tenant_can_view_own_program" ON "programs" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("programs"."organization_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')));