# Platform system roles

`system_users.system_role` is the single source of truth for platform role assignments. The Drizzle field is `systemRole`, with public `SystemRole`/`SYSTEM_ROLES` exports from `@octap/contracts`.

| Role | Meaning |
| --- | --- |
| SYSTEM_USER | Default platform identity. Organization access still requires membership. |
| SYSTEM_ADMIN | Explicit platform administration assignment. |

Platform roles are separate from Business Owner / Business Developer organization memberships. Owning an organization does not grant platform administration. Google sign-in must never take role assignments from browser input or Google profile metadata.

## Migration

Migration `0014_system_user_roles` replaces the previously unused `system_user_role` enum (`SUPER_ADMIN/ADMIN/USER`), adds `system_role`, maps existing `is_super_admin = true` users to `SYSTEM_ADMIN`, defaults all other users to `SYSTEM_USER`, and removes `is_super_admin`. User IDs, other profile fields and organization memberships are preserved. Existing migrations remain unchanged.

The schema intentionally declares its enum literals locally because drizzle-kit loads schemas through CommonJS while `@octap/contracts` is ESM-only. Integration tests verify that the database enum matches the public role constants.

Coordinate deployment with this column change: any external consumers still reading or writing `is_super_admin` must move to `system_role`. This migration is tested on disposable databases; it is not automatically applied to a shared or deployed database.

## Authorization boundary

Authenticated database users retain their own-profile SELECT policy and cannot assign their own system role. Do not expose role assignment in ordinary profile updates. Any future platform-admin assignment operation must enforce server-side authorization and record its actor/reason.

This change implements the role representation and migration only. Google-backed console authentication, role guards and a platform user-management API are still OCT-39 follow-up work; the existing customer Google/Enoki login does not use system-user roles.
