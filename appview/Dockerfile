FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ src/

RUN npx tsc --outDir dist \
 && npx -y tsc-alias -p tsconfig.json --outDir dist -f

# Migration stage: keeps devDependencies (drizzle-kit) for schema migrations
FROM node:22-alpine AS migrator

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY drizzle.config.ts tsconfig.json ./
COPY drizzle/ drizzle/
COPY src/ src/
COPY --from=builder /app/dist dist/

# `drizzle-kit migrate` reads the journal + applies any unapplied
# migrations from drizzle/ in order, tracked in `drizzle.__drizzle_migrations`.
# Non-interactive (unlike `push --force`, which still prompts on renames),
# idempotent (re-runs are no-ops once everything's applied), and works
# against both fresh and existing databases.
CMD ["npx", "drizzle-kit", "migrate"]

# Runtime stage: production dependencies only
FROM node:22-alpine AS runner

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist dist/

# Build identity for the /version endpoint (scripts/release/component_version.sh).
# Declared LAST so a version/tree change only invalidates this final layer,
# never the npm ci or dist layers above.
ARG VERSION=dev
ARG TREE=unknown
ARG DIRTY=0
ENV BUILD_VERSION=${VERSION} \
    BUILD_TREE=${TREE} \
    BUILD_DIRTY=${DIRTY}

USER node
CMD ["node", "dist/src/ingester/main.js"]
