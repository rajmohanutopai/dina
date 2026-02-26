FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ src/

RUN npx tsc --outDir dist

# Migration stage: keeps devDependencies (drizzle-kit) for schema migrations
FROM node:22-alpine AS migrator

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY drizzle.config.ts ./
COPY drizzle/ drizzle/
COPY --from=builder /app/dist dist/

CMD ["npx", "drizzle-kit", "migrate"]

# Runtime stage: production dependencies only
FROM node:22-alpine AS runner

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist dist/

USER node
CMD ["node", "dist/ingester/main.js"]
