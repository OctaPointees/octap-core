# Frontend scaffold
One Next.js App Router project with distinct route/layout slots:
- /merchant: owners/developers, organizations, campaigns, members and billing.
- /admin: platform governance, approval, monitoring and audit.
- /customer: Google/zkLogin, balance/history and customer signing reference.
- /pos: merchant POS SDK integration reference.

## Implementation locations

- src/app: pages, layouts and route composition; keep business logic out of pages.
- src/components/<feature>: product UI; components/shared and components/ui hold shared pieces.
- src/hooks/<feature>: feature queries, mutation state and view orchestration.
- src/lib/octap-api: typed API access and transport mapping.
- src/lib/auth, config, monitoring, utils: reusable non-UI helpers.
- src/providers: session, tenant and query provider composition.
- src/types: shared wire types; feature-specific view models stay with their feature.
- tests/unit, integration, e2e: tests added with actual feature implementation.

Pages return null; layouts/providers pass children through. No UI, authentication, hooks,
API calls, caches or context state are implemented. Route separation does not enforce permissions.
Run npm run dev:frontend at the root; the host listens on localhost:3002.
Read [the implementation guide](../docs/implementation-guide.md).
