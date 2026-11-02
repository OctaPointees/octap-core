ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_change_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX "invitation_org_email_pending_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_org_email_pending_idx" ON "invitations" USING btree ("organization_id","email") WHERE "invitations"."status" = 'PENDING';