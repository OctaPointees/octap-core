-- The legacy system_user_role enum is not used by any column in the baseline.
-- Replace it before adding the new column; never cast the old boolean into a role.
DROP TYPE "public"."system_user_role";--> statement-breakpoint
CREATE TYPE "public"."system_user_role" AS ENUM('SYSTEM_USER', 'SYSTEM_ADMIN');--> statement-breakpoint
ALTER TABLE "system_users" ADD COLUMN "system_role" "system_user_role" DEFAULT 'SYSTEM_USER' NOT NULL;--> statement-breakpoint
UPDATE "system_users" SET "system_role" = 'SYSTEM_ADMIN' WHERE "is_super_admin" = true;--> statement-breakpoint
ALTER TABLE "system_users" DROP COLUMN "is_super_admin";
