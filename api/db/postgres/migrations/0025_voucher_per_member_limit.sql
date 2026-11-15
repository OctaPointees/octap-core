DROP INDEX "voucher_ownership_voucher_member_idx";--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "per_member_limit" integer;--> statement-breakpoint
CREATE INDEX "voucher_ownership_voucher_member_count_idx" ON "voucher_ownerships" USING btree ("voucher_id","organization_end_user_id");--> statement-breakpoint
-- Vouchers created before OCT-291 keep the one-per-member rule the dropped unique index enforced.
UPDATE "vouchers" SET "per_member_limit" = 1;
