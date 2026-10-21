-- Rows provisioned before shards existed are backfilled as shard_count = 0 / total_budget = 0
-- (no shards, no budget) so this applies to a non-empty table; the defaults are dropped right
-- after, so new rows must still set both explicitly, matching the schema.
ALTER TABLE "programs" ADD COLUMN "shard_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "programs" ALTER COLUMN "shard_count" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "total_budget" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "programs" ALTER COLUMN "total_budget" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "operation_shard_ids" text[];--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "budget_shard_ids" text[];
