-- Every delivery queued before this migration becomes its own event, keeping its id: that id is the
-- X-OctaP-Event-Id its endpoint already saw, so a retry or replay still dedupes on it.
INSERT INTO "organization_events" ("id", "organization_id", "type", "payload", "created_at")
SELECT "id", "organization_id", "event_type", "payload", "created_at" FROM "webhook_deliveries" ORDER BY "created_at", "id";--> statement-breakpoint
UPDATE "webhook_deliveries" SET "event_id" = "id";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "event_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP COLUMN "event_type";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP COLUMN "payload";