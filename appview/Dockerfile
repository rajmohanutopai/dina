FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ src/

RUN npx tsc --outDir dist

FROM node:22-alpine AS runner

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist dist/

USER node
CMD ["node", "dist/ingester/main.js"]
