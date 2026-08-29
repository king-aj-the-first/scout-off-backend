# Degradation contracts (#1116)

| Group | Paths | redis | db | rpc | ipfs |
|---|---|---|---|---|---|
| liveness | `/health/liveness`, `/version` | 200 | 200 | 200 | 200 |
| readiness | `/ready` | 200/503 | 503 | 503 (if enabled) | 503 |
| auth | `/api/auth/*` | fail-open RL | degrade | may 503 | N/A |

Combinations: redis+rpc → liveness 200, ready 503; db+ipfs → ready 503.
