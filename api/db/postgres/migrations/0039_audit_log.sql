CREATE TYPE "public"."audit_actor_type" AS ENUM('USER', 'CREDENTIAL', 'SYSTEM');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"request_id" uuid,
	"changes" jsonb,
	CONSTRAINT "audit_log_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "audit_log_actor" CHECK (("audit_log"."actor_type" = 'SYSTEM') = ("audit_log"."actor_id" is null))
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_org_sequence_idx" ON "audit_log" USING btree ("organization_id","sequence");--> statement-breakpoint
CREATE INDEX "audit_log_org_occurred_idx" ON "audit_log" USING btree ("organization_id","occurred_at","sequence");--> statement-breakpoint
CREATE INDEX "audit_log_org_actor_idx" ON "audit_log" USING btree ("organization_id","actor_type","actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_org_target_idx" ON "audit_log" USING btree ("organization_id","target_type","target_id");--> statement-breakpoint
CREATE POLICY "tenant_read_audit_log" ON "audit_log" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("audit_log"."organization_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')));--> statement-breakpoint
CREATE POLICY "tenant_insert_audit_log" ON "audit_log" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("audit_log"."organization_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')));--> statement-breakpoint
CREATE FUNCTION "audit_log_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_log_append_only" BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "audit_log_append_only"();--> statement-breakpoint
CREATE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON "audit_log" FOR EACH STATEMENT EXECUTE FUNCTION "audit_log_append_only"();
