ALTER TABLE "voucher_approval_requests" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "created_by_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "activated_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "activated_by_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_created_by_user_id_system_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."system_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_created_by_credential_id_api_credentials_id_fk" FOREIGN KEY ("created_by_credential_id") REFERENCES "public"."api_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_activated_by_user_id_system_users_id_fk" FOREIGN KEY ("activated_by_user_id") REFERENCES "public"."system_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_activated_by_credential_id_api_credentials_id_fk" FOREIGN KEY ("activated_by_credential_id") REFERENCES "public"."api_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_one_creator" CHECK (num_nonnulls("vouchers"."created_by_user_id", "vouchers"."created_by_credential_id") <= 1);--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_one_activator" CHECK (num_nonnulls("vouchers"."activated_by_user_id", "vouchers"."activated_by_credential_id") <= 1);--> statement-breakpoint
-- Backfill what is already known. A voucher of a batch was created by whoever created its batch.
UPDATE "vouchers" SET "created_by_user_id" = b."created_by_user_id", "created_by_credential_id" = b."created_by_credential_id"
FROM "voucher_import_batches" b
WHERE b."id" = "vouchers"."import_batch_id" AND b."organization_id" = "vouchers"."organization_id";--> statement-breakpoint
-- One that went live through an Owner's approval was taken live by that Owner, when they approved it.
UPDATE "vouchers" SET "activated_by_user_id" = r."reviewed_by_id", "activated_at" = r."reviewed_at"
FROM (
  SELECT DISTINCT ON ("voucher_id") "voucher_id", "reviewed_by_id", "reviewed_at"
  FROM "voucher_approval_requests" WHERE "status" = 'APPROVED'
  ORDER BY "voucher_id", "reviewed_at" DESC
) r
WHERE r."voucher_id" = "vouchers"."id" AND "vouchers"."publish_status" IN ('PUBLISHING', 'PUBLISHED');
