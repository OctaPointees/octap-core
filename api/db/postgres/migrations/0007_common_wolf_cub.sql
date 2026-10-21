CREATE TABLE "indexer_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stream_name" text NOT NULL,
	"cursor" text,
	"last_checkpoint" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "indexer_cursors_stream_name_unique" UNIQUE("stream_name")
);
--> statement-breakpoint
ALTER TABLE "credit_ownerships" DROP COLUMN "as_of_checkpoint";