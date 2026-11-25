CREATE TYPE "public"."api_credential_environment" AS ENUM('LIVE', 'SANDBOX');--> statement-breakpoint
CREATE TABLE "sandbox_credit_balances" (
	"organization_end_user_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"confirmed_balance" bigint DEFAULT 0 NOT NULL,
	"pending_redemption" bigint DEFAULT 0 NOT NULL,
	"lifetime_earned" bigint DEFAULT 0 NOT NULL,
	"lifetime_redeemed" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_balance_not_negative" CHECK ("sandbox_credit_balances"."confirmed_balance" >= 0 and "sandbox_credit_balances"."pending_redemption" >= 0),
	CONSTRAINT "sandbox_hold_covered" CHECK ("sandbox_credit_balances"."pending_redemption" <= "sandbox_credit_balances"."confirmed_balance")
);
--> statement-breakpoint
ALTER TABLE "sandbox_credit_balances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sandbox_loyalty_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"organization_end_user_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"transaction_type" "loyalty_tx_type" NOT NULL,
	"status" "loyalty_tx_status" NOT NULL,
	"points_amount" bigint NOT NULL,
	"purchase_amount" bigint,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"receipt_reference" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_loyalty_transactions_digest_unique" UNIQUE("digest"),
	CONSTRAINT "sandbox_tx_type" CHECK ("sandbox_loyalty_transactions"."transaction_type" in ('EARN', 'REDEEM')),
	CONSTRAINT "sandbox_tx_digest" CHECK ("sandbox_loyalty_transactions"."digest" like 'sandbox\_%')
);
--> statement-breakpoint
ALTER TABLE "sandbox_loyalty_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_credentials" ADD COLUMN "environment" "api_credential_environment" DEFAULT 'LIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_credit_balances" ADD CONSTRAINT "sandbox_credit_balances_organization_end_user_id_organization_end_users_id_fk" FOREIGN KEY ("organization_end_user_id") REFERENCES "public"."organization_end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_credit_balances" ADD CONSTRAINT "sandbox_credit_balances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_loyalty_transactions" ADD CONSTRAINT "sandbox_loyalty_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_loyalty_transactions" ADD CONSTRAINT "sandbox_loyalty_transactions_organization_end_user_id_organization_end_users_id_fk" FOREIGN KEY ("organization_end_user_id") REFERENCES "public"."organization_end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_loyalty_transactions" ADD CONSTRAINT "sandbox_loyalty_transactions_credential_id_api_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."api_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_loyalty_tx_org_idempotency_idx" ON "sandbox_loyalty_transactions" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "sandbox_loyalty_tx_member_created_idx" ON "sandbox_loyalty_transactions" USING btree ("organization_end_user_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant_manage_sandbox_credit_balances" ON "sandbox_credit_balances" AS PERMISSIVE FOR ALL TO "authenticated" USING ("sandbox_credit_balances"."organization_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')));--> statement-breakpoint
CREATE POLICY "tenant_manage_sandbox_loyalty_transactions" ON "sandbox_loyalty_transactions" AS PERMISSIVE FOR ALL TO "authenticated" USING ("sandbox_loyalty_transactions"."organization_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')));