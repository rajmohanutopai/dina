# Grants service — build from the REPO ROOT context (workspace deps):
#   docker build -f apps/grants-service/Dockerfile .
#
# Runtime = tsx over the TypeScript sources, matching how the fleet's
# TS servers actually run (`npm start` → tsx src/bin.ts). This is also
# the only correct option: @dina/protocol's package.json points at
# src/index.ts (TypeScript), so a plain `node dist/...` runtime cannot
# resolve the workspace import (review P1 — the previous image crashed
# at boot). tsc still runs in the build stage as a type gate.

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/protocol packages/protocol
COPY apps/grants-service apps/grants-service
# Workspace-scoped install creates the @dina/protocol symlink. The deployment
# context intentionally contains only these two workspaces, so the repo-level
# patch-package postinstall is neither available nor relevant here. Rebuild the
# one native dependency explicitly after the script-free install.
RUN npm install --ignore-scripts --workspace=packages/protocol --workspace=apps/grants-service \
    && npm rebuild better-sqlite3
# Type gate — fail the image build on type errors.
RUN npm run typecheck --workspace=apps/grants-service

FROM node:22-alpine
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/protocol ./packages/protocol
COPY --from=build /repo/apps/grants-service ./apps/grants-service
EXPOSE 8300
CMD ["./node_modules/.bin/tsx", "apps/grants-service/src/bin.ts"]
