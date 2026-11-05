CREATE TYPE "public"."voucher_publish_status" AS ENUM('NOT_PUBLISHED', 'PUBLISHING', 'PUBLISHED', 'FAILED');--> statement-breakpoint
ALTER TABLE "vouchers" ALTER COLUMN "discount_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "voucher_ownerships" ADD COLUMN "pending_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "terms" jsonb;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "publish_status" "voucher_publish_status" DEFAULT 'NOT_PUBLISHED' NOT NULL;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "sui_terms_id" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "refund_policy_snapshot" jsonb;--> statement-breakpoint
UPDATE "vouchers" SET "status" = 'DRAFT' WHERE "status" = 'ACTIVE';
