DROP INDEX "voucher_ownership_voucher_member_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "voucher_ownership_voucher_member_idx" ON "voucher_ownerships" USING btree ("voucher_id","organization_end_user_id") WHERE "voucher_ownerships"."status" <> 'CANCELLED';
--> statement-breakpoint
-- Compatibility: the pre-merge voucher branch already recorded a later 0010 timestamp,
-- so Drizzle skips dev's earlier operations-index migration on those databases.
CREATE INDEX IF NOT EXISTS "operations_pending_unsent_idx" ON "operations" USING btree ("tenant_id","command_type","updated_at") WHERE "operations"."status" = 'PENDING' and "operations"."sui_tx_digest" is null;
