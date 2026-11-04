ALTER TABLE "loyalty_transactions" ADD COLUMN "purchase_amount" bigint;
--> statement-breakpoint
-- Recover the purchase input from durable earn commands, including already settled history.
UPDATE loyalty_transactions t SET purchase_amount = COALESCE(o.payload->>'purchaseAmount', o.payload->>'pointsAmount')::bigint
FROM operations o WHERE t.organization_id=o.tenant_id AND t.idempotency_key=o.idempotency_key
AND t.transaction_type='EARN' AND o.command_type='CREDIT_EARN_CHAIN_SUBMIT';
--> statement-breakpoint
-- Existing PENDING rows reserved the purchase input. Convert their holds to point estimates
-- atomically with the ownership delta. Stop API/workers during this contract upgrade.
WITH estimates AS (
  SELECT t.id,t.organization_end_user_id,t.points_amount AS old_points,
    floor(t.purchase_amount::numeric*p.earn_bps/10000)::bigint AS new_points
  FROM loyalty_transactions t JOIN programs p ON p.organization_id=t.organization_id
  WHERE t.transaction_type='EARN' AND t.status='PENDING' AND t.purchase_amount IS NOT NULL
), changed AS (
  UPDATE loyalty_transactions t SET points_amount=e.new_points FROM estimates e WHERE t.id=e.id
  RETURNING e.organization_end_user_id,e.old_points,e.new_points
), deltas AS (
  SELECT organization_end_user_id,sum(new_points-old_points) AS delta FROM changed GROUP BY organization_end_user_id
)
UPDATE credit_ownerships c SET pending_earn=c.pending_earn+d.delta
FROM deltas d WHERE c.organization_end_user_id=d.organization_end_user_id;
