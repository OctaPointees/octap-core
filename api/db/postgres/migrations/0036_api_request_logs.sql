CREATE TABLE "api_request_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "api_request_logs_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tx_id" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL,
	"organization_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"path" text NOT NULL,
	"status_code" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"category" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"error_body" jsonb,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_request_logs_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "api_request_logs_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
ALTER TABLE "api_request_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_request_logs" ADD CONSTRAINT "api_request_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_request_logs" ADD CONSTRAINT "api_request_logs_credential_id_api_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."api_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_request_logs_org_created_idx" ON "api_request_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "api_request_logs_org_credential_created_idx" ON "api_request_logs" USING btree ("organization_id","credential_id","created_at");--> statement-breakpoint
CREATE INDEX "api_request_logs_created_idx" ON "api_request_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "api_request_logs_org_tail_idx" ON "api_request_logs" USING btree ("organization_id","tx_id","sequence");--> statement-breakpoint
CREATE POLICY "tenant_read_api_request_logs" ON "api_request_logs" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("api_request_logs"."organization_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')));--> statement-breakpoint
CREATE POLICY "tenant_insert_api_request_logs" ON "api_request_logs" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("api_request_logs"."organization_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')));