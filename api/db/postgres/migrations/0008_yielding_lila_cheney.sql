CREATE TABLE "credit_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_ownership_id" uuid NOT NULL,
	"earn_transaction_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"remaining" bigint NOT NULL,
	"expires_at_ms" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_buckets_earn_transaction_id_unique" UNIQUE("earn_transaction_id")
);
--> statement-breakpoint
ALTER TABLE "credit_buckets" ADD CONSTRAINT "credit_buckets_credit_ownership_id_credit_ownerships_id_fk" FOREIGN KEY ("credit_ownership_id") REFERENCES "public"."credit_ownerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_buckets" ADD CONSTRAINT "credit_buckets_earn_transaction_id_loyalty_transactions_id_fk" FOREIGN KEY ("earn_transaction_id") REFERENCES "public"."loyalty_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_buckets_ownership_expiry_idx" ON "credit_buckets" USING btree ("credit_ownership_id","expires_at_ms");