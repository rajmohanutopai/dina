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

USER node
CMD ["node", "dist/src/ingester/main.js"]
