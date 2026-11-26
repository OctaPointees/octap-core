# One image for every deployed process (OCT-316). The command picks the process:
#   node api/dist/main.js                    the HTTP API (default)
#   node api/dist/worker.js                  the worker (and, with ORG_PROVISION_WORKER_ENABLED, organization setup)
#   node scripts/migrate.mjs                 the database migrations, run once per deploy
#   node ts-sdks/packages/mcp/dist/cli.js serve-http   the remote MCP server (OCT-307)
# Configuration comes from the environment only: no .env file is copied in or read.

FROM node:24-bookworm-slim AS build
WORKDIR /app

# Manifests first, so `npm ci` stays cached until a dependency changes.
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY ts-sdks/packages/contracts/package.json ts-sdks/packages/contracts/
COPY ts-sdks/packages/verify/package.json ts-sdks/packages/verify/
COPY ts-sdks/packages/chain/package.json ts-sdks/packages/chain/
COPY ts-sdks/packages/node/package.json ts-sdks/packages/node/
COPY ts-sdks/packages/mcp/package.json ts-sdks/packages/mcp/
COPY ts-sdks/packages/browser/package.json ts-sdks/packages/browser/
RUN npm ci --no-audit --no-fund

COPY tsconfig.base.json ./
COPY scripts scripts
COPY api api
COPY ts-sdks ts-sdks
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
# NO_COLOR: plain log lines, so CloudWatch shows text rather than terminal colour codes.
ENV NODE_ENV=production \
    NO_COLOR=1 \
    API_HOST=0.0.0.0 \
    API_PORT=3000
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/api/package.json api/
COPY --from=build /app/api/node_modules api/node_modules
COPY --from=build /app/api/dist api/dist
COPY --from=build /app/api/db api/db
# Workspace packages are symlinked from node_modules/@octap/*; they need their manifest and build.
COPY --from=build /app/ts-sdks/packages/contracts/package.json ts-sdks/packages/contracts/
COPY --from=build /app/ts-sdks/packages/contracts/dist ts-sdks/packages/contracts/dist
COPY --from=build /app/ts-sdks/packages/verify/package.json ts-sdks/packages/verify/
COPY --from=build /app/ts-sdks/packages/verify/dist ts-sdks/packages/verify/dist
COPY --from=build /app/ts-sdks/packages/chain/package.json ts-sdks/packages/chain/
COPY --from=build /app/ts-sdks/packages/chain/dist ts-sdks/packages/chain/dist
COPY --from=build /app/ts-sdks/packages/node/package.json ts-sdks/packages/node/
COPY --from=build /app/ts-sdks/packages/node/dist ts-sdks/packages/node/dist
COPY --from=build /app/ts-sdks/packages/mcp/package.json ts-sdks/packages/mcp/
COPY --from=build /app/ts-sdks/packages/mcp/dist ts-sdks/packages/mcp/dist
COPY docker/postgres-init docker/postgres-init
COPY scripts/migrate.mjs scripts/

USER node
EXPOSE 3000
CMD ["node", "api/dist/main.js"]
