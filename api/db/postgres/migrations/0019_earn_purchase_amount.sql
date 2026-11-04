ALTER TABLE "loyalty_transactions" ADD COLUMN "purchase_amount" bigint;
--> statement-breakpoint
-- Earn commands named the purchase `pointsAmount`. Their hash covered a generated id, so clear it:
-- `acceptCommand` adopts the new hash on the next retry of that key.
UPDATE "operations"
SET "payload" = ("payload" - 'pointsAmount') || jsonb_build_object('purchaseAmount', "payload" -> 'pointsAmount'),
    "payload_hash" = NULL
WHERE "command_type" = 'CREDIT_EARN_CHAIN_SUBMIT' AND "payload" ? 'pointsAmount';
