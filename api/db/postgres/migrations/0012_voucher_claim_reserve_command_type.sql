-- Paid voucher claims were accepted as POS reserves, told apart only by their payload. Give them
-- their own command type so the recovery and release paths no longer depend on a JSON key.
UPDATE "operations" SET "command_type" = 'VOUCHER_CLAIM_RESERVE'
WHERE "command_type" = 'CREDIT_POS_REDEEM_RESERVE' AND "payload" ? 'voucherOwnershipId';
