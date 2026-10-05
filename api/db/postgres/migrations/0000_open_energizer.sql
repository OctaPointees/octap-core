CREATE TYPE "public"."change_request_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."change_request_type" AS ENUM('CREATE_ORGANIZATION', 'UPDATE_PROFILE', 'TRANSFER_OWNERSHIP', 'DEACTIVATE');--> statement-breakpoint
CREATE TYPE "public"."invitation_status" AS ENUM('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('OWNER', 'ADMIN', 'MANAGER', 'STAFF', 'VIEWER');--> statement-breakpoint
CREATE TYPE "public"."system_user_role" AS ENUM('SUPER_ADMIN', 'ADMIN', 'USER');--> statement-breakpoint
CREATE TYPE "public"."api_credential_status" AS ENUM('ACTIVE', 'REVOKED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."organization_status" AS ENUM('ACTIVE', 'SUSPENDED', 'PENDING_APPROVAL', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."end_user_status" AS ENUM('ACTIVE', 'BLOCKED', 'PENDING_VERIFICATION');--> statement-breakpoint
CREATE TYPE "public"."blockchain_tx_status" AS ENUM('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."loyalty_tx_status" AS ENUM('PENDING', 'CONFIRMED', 'FAILED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."loyalty_tx_type" AS ENUM('EARN', 'REDEEM', 'REVERSAL', 'TRANSFER', 'EXPIRY', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."voucher_ownership_status" AS ENUM('AVAILABLE', 'RESERVED', 'REDEEMED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."voucher_status" AS ENUM('DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'DEPLETED');--> statement-breakpoint
CREATE TYPE "public"."billing_plan_interval" AS ENUM('MONTHLY', 'ANNUAL');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('DRAFT', 'OPEN', 'PAID', 'UNCOLLECTIBLE', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELED', 'INCOMPLETE');--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invited_by_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "membership_role" DEFAULT 'STAFF' NOT NULL,
	"token" text NOT NULL,
	"status" "invitation_status" DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "organization_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"requested_by_id" uuid NOT NULL,
	"reviewed_by_id" uuid,
	"request_type" "change_request_type" NOT NULL,
	"status" "change_request_status" DEFAULT 'PENDING' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"system_user_id" uuid NOT NULL,
	"role" "membership_role" DEFAULT 'STAFF' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "system_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"full_name" text NOT NULL,
	"avatar_url" text,
	"is_super_admin" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "system_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "api_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '["read","write"]'::jsonb NOT NULL,
	"status" "api_credential_status" DEFAULT 'ACTIVE' NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_credentials_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "api_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"tax_id" text,
	"status" "organization_status" DEFAULT 'ACTIVE' NOT NULL,
	"sui_package_id" text,
	"sui_treasury_cap" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "end_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sui_address" text,
	"email" text,
	"phone_number" text,
	"display_name" text,
	"avatar_url" text,
	"status" "end_user_status" DEFAULT 'ACTIVE' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "end_users_sui_address_unique" UNIQUE("sui_address"),
	CONSTRAINT "end_users_email_unique" UNIQUE("email"),
	CONSTRAINT "end_users_phone_number_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
ALTER TABLE "end_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organization_end_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"end_user_id" uuid NOT NULL,
	"external_member_id" text,
	"tier" text DEFAULT 'BRONZE' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_end_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "blockchain_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest" text NOT NULL,
	"checkpoint" bigint,
	"sender" text NOT NULL,
	"status" "blockchain_tx_status" DEFAULT 'PENDING' NOT NULL,
	"gas_used" bigint,
	"error_message" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blockchain_transactions_digest_unique" UNIQUE("digest")
);
--> statement-breakpoint
CREATE TABLE "credit_ownerships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_end_user_id" uuid NOT NULL,
	"sui_credit_account_id" text,
	"confirmed_balance" bigint DEFAULT 0 NOT NULL,
	"pending_earn" bigint DEFAULT 0 NOT NULL,
	"pending_redemption" bigint DEFAULT 0 NOT NULL,
	"lifetime_earned" bigint DEFAULT 0 NOT NULL,
	"lifetime_redeemed" bigint DEFAULT 0 NOT NULL,
	"as_of_checkpoint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ownerships_organization_end_user_id_unique" UNIQUE("organization_end_user_id")
);
--> statement-breakpoint
CREATE TABLE "loyalty_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"organization_end_user_id" uuid NOT NULL,
	"created_by_membership_id" uuid,
	"blockchain_transaction_id" uuid,
	"transaction_type" "loyalty_tx_type" NOT NULL,
	"points_amount" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"receipt_reference" text,
	"status" "loyalty_tx_status" DEFAULT 'PENDING' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "voucher_ownerships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voucher_id" uuid NOT NULL,
	"organization_end_user_id" uuid NOT NULL,
	"loyalty_transaction_id" uuid,
	"serial_code" text NOT NULL,
	"status" "voucher_ownership_status" DEFAULT 'AVAILABLE' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redeemed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voucher_ownerships_voucher_id_unique" UNIQUE("voucher_id"),
	CONSTRAINT "voucher_ownerships_serial_code_unique" UNIQUE("serial_code")
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"points_cost" bigint DEFAULT 0 NOT NULL,
	"discount_type" text NOT NULL,
	"discount_value" numeric(12, 2),
	"total_supply" integer,
	"claimed_count" integer DEFAULT 0 NOT NULL,
	"status" "voucher_status" DEFAULT 'DRAFT' NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vouchers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"price" numeric(10, 2) NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"billing_interval" "billing_plan_interval" DEFAULT 'MONTHLY' NOT NULL,
	"stripe_price_id" text,
	"features" jsonb DEFAULT '{}'::jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_plans_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"payment_method_id" uuid,
	"organization_id" uuid NOT NULL,
	"stripe_invoice_id" text,
	"invoice_number" text NOT NULL,
	"amount_due" numeric(10, 2) NOT NULL,
	"amount_paid" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"status" "invoice_status" DEFAULT 'OPEN' NOT NULL,
	"due_date" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"hosted_invoice_url" text,
	"invoice_pdf" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_stripe_invoice_id_unique" UNIQUE("stripe_invoice_id")
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"stripe_payment_method_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"type" text DEFAULT 'card' NOT NULL,
	"card_brand" text,
	"card_last4" text,
	"card_exp_month" integer,
	"card_exp_year" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_methods_stripe_payment_method_id_unique" UNIQUE("stripe_payment_method_id")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"billing_plan_id" uuid NOT NULL,
	"payment_method_id" uuid,
	"stripe_subscription_id" text,
	"status" "subscription_status" DEFAULT 'ACTIVE' NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_type" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"sui_tx_digest" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"content" text
);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_system_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."system_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_change_requests" ADD CONSTRAINT "organization_change_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_change_requests" ADD CONSTRAINT "organization_change_requests_requested_by_id_system_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."system_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_change_requests" ADD CONSTRAINT "organization_change_requests_reviewed_by_id_system_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."system_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_system_user_id_system_users_id_fk" FOREIGN KEY ("system_user_id") REFERENCES "public"."system_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_end_users" ADD CONSTRAINT "organization_end_users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_end_users" ADD CONSTRAINT "organization_end_users_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ownerships" ADD CONSTRAINT "credit_ownerships_organization_end_user_id_organization_end_users_id_fk" FOREIGN KEY ("organization_end_user_id") REFERENCES "public"."organization_end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_organization_end_user_id_organization_end_users_id_fk" FOREIGN KEY ("organization_end_user_id") REFERENCES "public"."organization_end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_created_by_membership_id_organization_memberships_id_fk" FOREIGN KEY ("created_by_membership_id") REFERENCES "public"."organization_memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_blockchain_transaction_id_blockchain_transactions_id_fk" FOREIGN KEY ("blockchain_transaction_id") REFERENCES "public"."blockchain_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_ownerships" ADD CONSTRAINT "voucher_ownerships_voucher_id_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_ownerships" ADD CONSTRAINT "voucher_ownerships_organization_end_user_id_organization_end_users_id_fk" FOREIGN KEY ("organization_end_user_id") REFERENCES "public"."organization_end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_ownerships" ADD CONSTRAINT "voucher_ownerships_loyalty_transaction_id_loyalty_transactions_id_fk" FOREIGN KEY ("loyalty_transaction_id") REFERENCES "public"."loyalty_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_billing_plan_id_billing_plans_id_fk" FOREIGN KEY ("billing_plan_id") REFERENCES "public"."billing_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_org_email_pending_idx" ON "invitations" USING btree ("organization_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_org_user_idx" ON "organization_memberships" USING btree ("organization_id","system_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_end_user_unique_idx" ON "organization_end_users" USING btree ("organization_id","end_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_external_member_id_idx" ON "organization_end_users" USING btree ("organization_id","external_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_tx_org_idempotency_idx" ON "loyalty_transactions" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "voucher_ownership_serial_idx" ON "voucher_ownerships" USING btree ("serial_code");--> statement-breakpoint
CREATE UNIQUE INDEX "voucher_org_code_idx" ON "vouchers" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "operations_tenant_idempotency_idx" ON "operations" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE POLICY "members_can_view_their_org_memberships" ON "organization_memberships" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("organization_memberships"."system_user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "users_can_view_own_profile" ON "system_users" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("system_users"."id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "tenant_can_manage_api_credentials" ON "api_credentials" AS PERMISSIVE FOR ALL TO "authenticated" USING ("api_credentials"."organization_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')));--> statement-breakpoint
CREATE POLICY "tenant_members_can_view_organization" ON "organizations" AS PERMISSIVE FOR SELECT TO "authenticated" USING (exists (
        select 1 from organization_memberships m
        where m.organization_id = "organizations"."id" and m.system_user_id = auth.uid()
      ));--> statement-breakpoint
CREATE POLICY "end_users_can_view_own_profile" ON "end_users" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("end_users"."id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "tenant_or_user_access_org_end_user" ON "organization_end_users" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("organization_end_users"."end_user_id" = (select auth.uid()) or "organization_end_users"."organization_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')));--> statement-breakpoint
CREATE POLICY "tenant_isolation_loyalty_transactions" ON "loyalty_transactions" AS PERMISSIVE FOR ALL TO "authenticated" USING ("loyalty_transactions"."organization_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')));--> statement-breakpoint
CREATE POLICY "tenant_manage_vouchers" ON "vouchers" AS PERMISSIVE FOR ALL TO "authenticated" USING ("vouchers"."organization_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')));--> statement-breakpoint
CREATE POLICY "tenant_isolation_operations" ON "operations" AS PERMISSIVE FOR ALL TO "authenticated" USING ("operations"."tenant_id"::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')));--> statement-breakpoint
CREATE POLICY "user_can_access_own_docs" ON "documents" AS PERMISSIVE FOR ALL TO "authenticated" USING ("documents"."user_id" = (select auth.uid()));