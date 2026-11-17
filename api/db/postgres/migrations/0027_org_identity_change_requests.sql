ALTER TYPE "public"."change_request_type" ADD VALUE 'UPDATE_IDENTITY';--> statement-breakpoint
CREATE TABLE "organization_change_request_secrets" (
	"change_request_id" uuid PRIMARY KEY NOT NULL,
	"national_id_encrypted" text NOT NULL,
	"national_id_last4" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_change_request_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "logo_url" text;--> statement-breakpoint
ALTER TABLE "organization_change_request_secrets" ADD CONSTRAINT "organization_change_request_secrets_change_request_id_organization_change_requests_id_fk" FOREIGN KEY ("change_request_id") REFERENCES "public"."organization_change_requests"("id") ON DELETE cascade ON UPDATE no action;