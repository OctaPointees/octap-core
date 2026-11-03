CREATE TYPE "public"."organization_type" AS ENUM('INDIVIDUAL_HOUSEHOLD', 'COMPANY');--> statement-breakpoint
CREATE TABLE "organization_identity_details" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"national_id_encrypted" text NOT NULL,
	"national_id_last4" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_identity_details" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "organization_type" "organization_type";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "representative_name" text;--> statement-breakpoint
ALTER TABLE "organization_identity_details" ADD CONSTRAINT "organization_identity_details_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;