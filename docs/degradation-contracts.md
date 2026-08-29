# Dependency Degradation Contracts

Authoritative graceful-degradation contracts for ScoutOff backend route groups
when Redis, the database, Soroban RPC, or IPFS are unavailable.

These contracts are asserted by the chaos harness in `tests/chaos/`
(`npm run test:chaos`). When behavior changes intentionally, update this doc
and the harness in the same PR.

## Dependencies

| Dependency | Injection seam | Failure modes simulated |
| ---------- | -------------- | ----------------------- |
| **Redis** | `RateLimitStore` / `RedisCacheStore` / `FakeRedisClient` | connection refused, command hang |
| **DB** | `getDriver()` / `DbDriver` methods | probe throw, write fail, query throw |
| **Soroban RPC** | `stellarBreaker` / `server.*` (proxied) | network error, circuit OPEN |
| **IPFS** | `checkHealth` / `pinJson` | reject / HTTP 500 |

Redis is **not** part of `/ready` — a Redis outage alone must not flip readiness
to degraded. DB, IPFS, and (when enabled) Stellar/RPC are.

## Cross-cutting middleware

| Concern | Contract when dependency fails |
| ------- | ------------------------------ |
| IP / wallet rate limit (`rateLimit`, `walletRateLimit`) | **Fail open**: allow the request; never 5xx/429 solely because the store errored. Warn-logged. |
| Player/search cache (`cacheGet` / `cacheSet`) | **Degrade to miss**: reads return `undefined`; writes are best-effort (no throw). |
| Token revocation check (`isTokenRevoked`) | **Fail open**: allow the request if the blocklist store errors. |
| Global request timeout | Never hang past `REQUEST_TIMEOUT_MS`; timeout yields **503** `REQUEST_TIMEOUT`. |
| Stellar circuit breaker | After threshold failures → **OPEN**; callers that map `NETWORK_ERROR` return **503**, not 500. `/ready` reports `stellar: unavailable` when OPEN (if health check enabled). |
| Webhook delivery | Exhausted retries → **dead-letter** row; `dispatchEventWebhook` does not reject. |
| Indexer poll (`index.ts`) | RPC/index errors are **caught and logged**; the process keeps polling (no crash). |

## Route-group contracts

Status codes below are the *expected graceful* outcomes. Where a dependency is
required to serve the request and no graceful path exists, **5xx is allowed**
and noted as "hard fail". Chaos asserts: no unexpected 5xx where a graceful
code is listed, and responses complete within the hang budget.

### Health & probes

| Route | Redis | DB | RPC / Stellar | IPFS |
| ----- | ----- | -- | ------------- | ---- |
| `GET /health` | 200 | **200** with `healthStatus.db=error` | 200 (`stellar` ok/error/disabled) | N/A |
| `GET /health/liveness` | 200 | 200 | 200 | 200 |
| `GET /ready` | 200 (unaffected) | **503** `degraded` | **503** when check enabled & unavailable/OPEN | **503** `degraded` |
| `GET /health/readiness` | same as `/ready` | same | same | same |
| `GET /health/dependencies` | 200 body `status=degraded` when redis error | 200 `degraded` when db error | 200 `degraded` | 200 `degraded` |
| `GET /metrics` | 200 | 200 | 200 | 200 |
| `GET /version` | 200 | 200 | 200 | 200 |

### Auth (`/auth/*`)

| Route | Redis | DB | RPC | IPFS |
| ----- | ----- | -- | --- | ---- |
| `GET /auth/challenge` | Rate limit fail-open → still issues challenge (local SEP-10 build) | N/A for challenge build | N/A | N/A |
| `POST /auth/token` | Fail-open on rate-limit store | May hard-fail if audit/DB write required | N/A | N/A |
| `POST /auth/refresh` | Fail-open | Revocation fail-open; DB hard-fail if required | N/A | N/A |
| `POST /auth/logout` | Fail-open | Best-effort revoke | N/A | N/A |

### Players (`/api/players`, `/api/v1`, `/api/v2`)

| Capability | Redis | DB | RPC | IPFS |
| ---------- | ----- | -- | --- | ---- |
| List / get (read) | Cache miss → DB; **200** if DB up | Hard fail (5xx) if DB required | N/A | N/A |
| Register / update (write) | Fail-open rate limit; cache invalidate best-effort | Hard fail | **503** `NETWORK_ERROR` when mapped | Pin failure → queue/pending or error per `#346` |

### Scouts (`/api/scouts`)

| Capability | Redis | DB | RPC | IPFS |
| ---------- | ----- | -- | --- | ---- |
| Reads | Cache/rate-limit degrade as above | Hard fail if DB required | N/A | N/A |
| Chain writes | Fail-open rate limit | Hard fail | **503** when network/breaker mapped | As players |

### Validators (`/api/validators`)

| Capability | Redis | DB | RPC | IPFS |
| ---------- | ----- | -- | --- | ---- |
| Pending list (read) | Fail-open | Hard fail | N/A | N/A |
| Milestone submit / approve | Fail-open | Hard fail | **503** network | Pin degrade / queue |

### Admin (`/api/admin`)

| Capability | Redis | DB | RPC | IPFS |
| ---------- | ----- | -- | --- | ---- |
| Stats / audit / flags (read) | Fail-open | Hard fail | N/A | N/A |
| On-chain admin (pause, fees, validators) | Fail-open | Hard fail | **503** `NETWORK_ERROR` | N/A |
| Dead-letter admin | N/A | Hard fail | N/A | N/A |

### Events / GraphQL / Docs

| Route group | Redis | DB | RPC | IPFS |
| ----------- | ----- | -- | --- | ---- |
| `GET /api/events/stream` | Revocation fail-open | Auth/DB hard fail | N/A | N/A |
| GraphQL | Same as underlying loaders | Hard fail | Per-field | Per-field |
| `GET /api/docs*` | 200 (static) | 200 | 200 | 200 |

## Combination failures (critical paths)

| Path | Combo | Expected |
| ---- | ----- | -------- |
| `/ready` | DB + IPFS down | **503** degraded; both services `unavailable`; no hang |
| `/ready` | Redis + RPC (stellar OPEN) | Redis ignored; **503** if stellar check enabled else **200** when DB+IPFS ok |
| `/health` | Redis + DB down | **200**; `db=error` |
| Auth challenge | Redis store failing | **200/400** (validation), never 5xx from rate limit |
| Player GET | Redis cache failing + healthy DB | **200** (miss → DB) |
| Rate limit + circuit OPEN | Redis unavailable + breaker OPEN | Request still admitted by rate limit; chain ops → **503** |

## Hang budget

Chaos probes must complete within **5 s** wall time (well under the default
30 s request timeout). A probe that exceeds the budget fails the harness even
if it eventually returns a correct status.
