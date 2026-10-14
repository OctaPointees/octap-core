# Members (minimal slice)

`ensure-by-phone` only: find-or-create an `end_users` row by phone, find-or-create its
`organization_end_users` row for one organization, return the `organizationEndUserId` every
credits/rewards endpoint needs. No verification (OTP/SMS), no profile editing, no roles.

Exists to unblock a caller that only has a phone number — the `octap-demo` app, which has no other
notion of identity for its POS "Issue points" flow — not a start on the full `domain/members`
roadmap item (enrollment, identity binding). Extend this file when that gets built for real instead
of assuming this is already it.
