# Frontend scaffold
One Next.js App Router project with distinct route/layout slots:
- /merchant: partner owners/developers, organizations, campaigns, members and billing.
- /admin: platform governance, approval, monitoring and audit.
- /customer: Google/zkLogin, balance/history and customer signing reference.
- /pos: SDK integration reference for merchant POS.

Pages return null and layouts only compose children. Authentication, authorization,
navigation, visual design, data access and all business screens are unimplemented.
Route separation does not enforce permissions.
Run npm run dev:frontend at the repository root; the host listens on localhost:3002.
See [architecture mapping](../docs/architecture.md).
