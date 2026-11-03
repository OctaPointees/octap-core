ALTER TYPE "public"."membership_role" ADD VALUE 'BUSINESS_DEVELOPER';--> statement-breakpoint
ALTER TABLE "system_users" ADD COLUMN "google_subject" text;--> statement-breakpoint
ALTER TABLE "system_users" ADD CONSTRAINT "system_users_google_subject_unique" UNIQUE("google_subject");