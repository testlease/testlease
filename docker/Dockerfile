# syntax=docker/dockerfile:1.7
# Minimal production image for the TestLease server + CLI.
#
#   docker build -f docker/Dockerfile -t testlease/testlease .
#   docker run -p 4747:4747 -e TESTLEASE_TOKEN=change-me-please-32chars \
#     -v ./testlease.yml:/app/testlease.yml -v testlease-data:/data testlease/testlease
#
# better-sqlite3 ships prebuilt binaries for linux-musl, so no compiler is needed.

FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.26.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.build.json ./
COPY packages ./packages
COPY examples/vanilla/package.json ./examples/vanilla/package.json
COPY examples/playwright/package.json ./examples/playwright/package.json
COPY examples/mcp/package.json ./examples/mcp/package.json
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Produce a self-contained, production-only copy of the `testlease` package.
RUN pnpm --filter testlease deploy --prod --legacy /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    TESTLEASE_HOST=0.0.0.0 \
    TESTLEASE_PORT=4747 \
    TESTLEASE_DB=/data/testlease.db \
    TESTLEASE_CONFIG=/app/testlease.yml
RUN apk add --no-cache tini && addgroup -S testlease && adduser -S -G testlease testlease \
    && mkdir -p /data /app && chown -R testlease:testlease /data /app
WORKDIR /app
COPY --from=build --chown=testlease:testlease /out /app
USER testlease
VOLUME ["/data"]
EXPOSE 4747
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TESTLEASE_PORT||4747)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini forwards SIGTERM so `testlease serve` can shut down gracefully (waiters get 503,
# active leases are kept in /data and survive the restart).
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/bin/testlease.js"]
CMD ["serve", "--no-pretty"]
