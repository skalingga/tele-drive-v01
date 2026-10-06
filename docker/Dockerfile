# TeleDrive production image. Build from the repository root:
#   docker build -f docker/Dockerfile -t teledrive .
# Secrets are passed at runtime (docker compose / env), never baked into the image.

FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY workers/ ./workers/
COPY apps/ ./apps/
RUN npm ci
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/teledrive.sqlite \
    UPLOAD_TEMP_DIR=/app/data/tmp/uploads

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY workers/ ./workers/
COPY apps/ ./apps/
RUN npm ci --omit=dev && npm cache clean --force
# Compiled workspace packages and the client bundle from the builder stage.
COPY --from=builder /app/packages/ ./packages/
COPY --from=builder /app/workers/ ./workers/
COPY --from=builder /app/apps/web/dist ./apps/web/dist

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000

# Single instance only: this process owns every user's MTProto session (ADR-007).
CMD ["node", "apps/web/server/main.ts"]
