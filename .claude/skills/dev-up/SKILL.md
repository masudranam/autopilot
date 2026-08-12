---
name: dev-up
description:
  Brings the whole stack up locally — docker services, migrations, seed, API and both frontends —
  and health-checks everything. Use for "run the app", "start dev", "show me the storefront", or
  before manual verification.
---

# Dev up

## 1 · Infrastructure

```
pnpm infra:up
```

Starts Postgres (5442), Redis (6389), Mailpit (1026 SMTP / 8026 UI) and MinIO (9010 / 9011). Ports
are offset from the defaults because 5432, 5433 and 4200 are already in use on this machine.

Wait for health, then confirm:

```
docker compose -f infra/docker-compose.yml ps
```

If Docker Desktop is not running, start it and wait — everything below depends on it.

## 2 · Environment

```
cp .env.example .env
```

Only if `.env` is missing. **Never edit `.env`** — a hook blocks it, and it may hold real values. If
a required variable is missing, add it to `.env.example` and tell the user what to set.

Generate real JWT secrets with `openssl rand -hex 32` and tell the user to paste them in; do not
invent placeholder secrets that end up looking real.

## 3 · Database

```
pnpm db:migrate
pnpm db:seed
```

Seeded credentials are in `apps/api/prisma/seed.ts` — read them from there rather than assuming.

To start clean:

```
pnpm db:reset
```

## 4 · Applications

```
pnpm dev
```

Turbo runs all three in parallel. Run it in the background and poll the health endpoints rather than
blocking on it.

|               | URL                            |
| ------------- | ------------------------------ |
| Storefront    | http://localhost:3000          |
| API           | http://localhost:3001/api/v1   |
| API docs      | http://localhost:3001/api/docs |
| Admin         | http://localhost:3002          |
| Mailpit       | http://localhost:8026          |
| MinIO console | http://localhost:9011          |

## 5 · Health check

```
curl -s http://localhost:3001/api/v1/health
curl -s http://localhost:3001/api/v1/health/ready
curl -s -o /dev/null -w "storefront %{http_code}\n" http://localhost:3000
curl -s -o /dev/null -w "admin %{http_code}\n" http://localhost:3002
```

`/health/ready` returning 503 means Postgres or Redis is not reachable — check step 1 before
debugging the application.

## Ports already in use

```
netstat -ano | grep LISTENING
```

Do not kill a process on 5432, 5433 or 4200 — those belong to the user's other projects. If one of
this stack's own ports is taken, change it in `.env` and `infra/docker-compose.yml` together.
