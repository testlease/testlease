# Docker

```bash
docker build -f docker/Dockerfile -t testlease/testlease .

docker run --rm -p 4747:4747 \
  -e TESTLEASE_TOKEN=change-me-please-at-least-16-chars \
  -e BUYER_01_PASSWORD=... -e BUYER_02_PASSWORD=... -e BUYER_03_PASSWORD=... \
  -v "$PWD/examples/playwright/testlease.yml:/app/testlease.yml:ro" \
  -v testlease-data:/data \
  testlease/testlease
```

- The container binds `0.0.0.0` so the port can be published; therefore a token is **required**
  (`TESTLEASE_TOKEN`, or `auth.tokens` in the YAML). Without one the server refuses to start.
- SQLite lives in `/data/testlease.db` (`TESTLEASE_DB`). Mount a volume: active leases survive
  container restarts by design.
- Configuration is read from `/app/testlease.yml` (`TESTLEASE_CONFIG`). Secret references such
  as `env:BUYER_01_PASSWORD` resolve from the container environment.
- `SIGTERM` triggers a graceful shutdown: waiting acquisitions receive `SERVER_SHUTTING_DOWN`,
  active leases are kept, the database is closed cleanly.
- The health check hits `GET /healthz`.
- The image runs as an unprivileged user and contains only the production dependencies of the
  `testlease` package (prebuilt SQLite binary, no compiler).

`docker/docker-compose.yml` wires the same thing up with a named volume.
