# BUILD CONTEXT IS THE REPO ROOT, not `appview/`.
#
# appview used to be built from its own directory with its own lockfile, which
# is why it carried a hand-maintained COPY of the commerce wire rules: it could
# not see `@dina/commerce-protocol`. Two review rounds found the two copies
# disagreeing in 145 places, every one invisible to a green suite. The context
# widened so the duplicate could be deleted.
FROM node:22-alpine AS builder

WORKDIR /repo
# Workspace manifests first, so `npm ci` caches independently of source.
#
# `tsconfig.base.json` comes along because the protocol's build config reaches
# it: tsconfig.build.json -> ./tsconfig.json -> ../../tsconfig.base.json. Omit
# it and tsc does not stop — it falls back to its own defaults, which target
# ES5, and the first symptom is "BigInt literals are not available" from a file
# that compiles cleanly on a developer's machine.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/commerce-protocol/package.json packages/commerce-protocol/
COPY appview/package.json appview/
RUN npm ci --workspace @dina/commerce-protocol --workspace @dina/appview --ignore-scripts

# The protocol is built FIRST: appview resolves its `compiled` condition, which
# points at `dist/`. Without this step the import resolves to TypeScript source
# and Node refuses it at startup — loudly, which is the failure mode we want.
COPY packages/commerce-protocol/ packages/commerce-protocol/
RUN npm run build --workspace @dina/commerce-protocol

COPY appview/tsconfig.json appview/
COPY appview/src/ appview/src/

WORKDIR /repo/appview
# BOTH BINARIES COME FROM THE LOCKFILE, and `--no-install` says so out loud.
#
# `npx -y tsc-alias` fetched the registry's CURRENT version at every build,
# because tsc-alias was in no manifest and no lockfile. The image was therefore
# neither reproducible nor buildable offline, and a future release of a package
# nobody here had pinned could rewrite the import paths of the shipping
# artifact — from an unchanged repository.
RUN npx --no-install tsc --outDir dist \
 && npx --no-install tsc-alias -p tsconfig.json --outDir dist -f

# Migration stage: keeps devDependencies (drizzle-kit) for schema migrations
FROM node:22-alpine AS migrator

WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/commerce-protocol/package.json packages/commerce-protocol/
COPY appview/package.json appview/
RUN npm ci --workspace @dina/commerce-protocol --workspace @dina/appview --ignore-scripts

COPY packages/commerce-protocol/ packages/commerce-protocol/
COPY appview/drizzle.config.ts appview/tsconfig.json appview/
COPY appview/drizzle/ appview/drizzle/
COPY appview/src/ appview/src/
COPY --from=builder /repo/appview/dist appview/dist/
WORKDIR /repo/appview

# `drizzle-kit migrate` reads the journal + applies any unapplied
# migrations from drizzle/ in order, tracked in `drizzle.__drizzle_migrations`.
# Non-interactive (unlike `push --force`, which still prompts on renames),
# idempotent (re-runs are no-ops once everything's applied), and works
# against both fresh and existing databases.
CMD ["npx", "drizzle-kit", "migrate"]

# Runtime stage: production dependencies only
FROM node:22-alpine AS runner

WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/commerce-protocol/package.json packages/commerce-protocol/
COPY appview/package.json appview/
RUN npm ci --omit=dev --workspace @dina/commerce-protocol --workspace @dina/appview --ignore-scripts

# The protocol's BUILD only — its source never reaches the runtime image, which
# is the point of the `compiled` condition.
COPY --from=builder /repo/packages/commerce-protocol/dist packages/commerce-protocol/dist/
COPY --from=builder /repo/appview/dist appview/dist/
WORKDIR /repo/appview

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
CMD ["node", "--conditions=compiled", "dist/src/ingester/main.js"]
