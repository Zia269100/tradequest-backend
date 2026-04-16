# TradeQuest Backend — Fixed & Deployment-Ready

## Project layout expected on disk

```
project-root/
├── docker-compose.yml        ← from this package
├── backend/                  ← everything in this package (src/, Dockerfile, etc.)
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── db/
│   │   └── init.sql          ← schema + migrations + seeds (run once automatically)
│   └── src/
│       └── ...
└── frontend/                 ← your Vite/React app (unchanged)
    ├── Dockerfile
    └── ...
```

---

## Quick start (Docker Compose)

```bash
# 1. Place your frontend folder alongside the backend folder
# 2. (Optional) set strong JWT secrets
export JWT_ACCESS_SECRET="your-32-char-minimum-secret-here!"
export JWT_REFRESH_SECRET="your-32-char-minimum-secret-here2"

# 3. Boot everything — DB schema is applied automatically on first run
docker compose up --build
```

The API will be available at `http://localhost:4000`  
The frontend will be at `http://localhost:8080`  
WebSocket feed: `ws://localhost:4000/ws/market`

---

## Connecting the frontend

| Item | Value |
|------|-------|
| REST base URL | `http://localhost:4000` (or `http://api:4000` inside Docker network) |
| WebSocket | `ws://localhost:4000/ws/market` |
| Auth header | `Authorization: Bearer <accessToken>` |

### API surface

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/signup` | — | Register |
| POST | `/api/auth/login` | — | Login, returns `accessToken` + `refreshToken` |
| POST | `/api/auth/refresh` | — | Exchange refresh token |
| POST | `/api/auth/logout` | — | Revoke refresh token |
| GET  | `/api/auth/me` | ✓ | Current user + balance |
| POST | `/api/trade` | ✓ | Place order (`market`/`limit`/`stop`) |
| GET  | `/api/trade/open` | ✓ | Open positions |
| GET  | `/api/trade/history` | ✓ | Trade history |
| GET  | `/api/trade/pnl` | ✓ | Unrealized + realized P&L |
| GET  | `/api/portfolio` | ✓ | Full portfolio snapshot |
| GET  | `/api/leaderboard` | — | Top traders |
| GET  | `/api/missions` | ✓ | User missions + progress |
| POST | `/api/missions/:id/claim` | ✓ | Claim mission XP reward |
| GET  | `/api/analytics` | ✓ | Trade stats + behavior |
| GET  | `/health` | — | Health check |

### WebSocket message format
```json
{ "type": "quote", "symbol": "AAPL", "price": 152.34, "ts": "2026-03-31T10:00:00.000Z" }
```

---

## Environment variables

All have sensible defaults for development. For production override these:

| Variable | Default | Notes |
|----------|---------|-------|
| `JWT_ACCESS_SECRET` | `dev-access-secret...` | **Must be 32+ chars** |
| `JWT_REFRESH_SECRET` | `dev-refresh-secret...` | **Must be 32+ chars** |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `REDIS_URL` | — | Redis connection string |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated allowed origins |
| `STARTING_BALANCE` | `100000` | Virtual cash per new user |
| `MARKET_SYMBOLS` | `AAPL,MSFT,GOOG` | Simulated ticker symbols |
| `MARKET_TICK_MS` | `2000` | Price update interval |
| `ENFORCE_HTTPS` | `false` | Set `true` behind a TLS proxy |
| `TRUST_PROXY` | `0` | Hop count behind reverse proxy |
| `METRICS_ENABLED` | `false` | Expose `/metrics` endpoint |

---

## Bugs fixed (summary)

### 1. `middleware/rateLimits.ts` — Import crash
`RedisReply` type doesn't exist in `rate-limit-redis` v4. Fixed import and corrected
`sendCommand` signature to match ioredis `call()` API.

### 2. `services/trading.service.ts` — Partitioned table corruption
The `trades` table is `PARTITION BY RANGE (trade_timestamp)`. Any `UPDATE`/`DELETE`
using only `WHERE id = $1` silently scans all partitions and can update the wrong row.
Fixed all trade mutations to include `AND trade_timestamp = $2`.

Also fixed partial-sell lot logic where the newly inserted closed-portion trade was
discarded, and fixed pending order status rollback on execution failure.

### 3. `services/auth.service.ts` — Non-existent column
`INSERT INTO users ... equity_baseline` — this column does not exist in the schema.
Every signup call crashed with a PG error. Removed the reference; starting balance
is stored only in the wallet.

### 4. `services/leaderboard.service.ts` — Non-existent column + constraint violation
`SELECT equity_baseline FROM users` crashed every leaderboard compute. Fixed to use
`STARTING_BALANCE` from env config as the baseline.

Also: `win_rate` and `consistency_score` columns have `CHECK (value BETWEEN 0 AND 1)`.
The computed values were not clamped before insert, causing constraint failures.

### 5. `services/mission.service.ts` — Missing DB column
`reward_granted` referenced in all mission queries but was absent from the original
`user_missions` schema. Added the column to `db/init.sql`.

### 6. `server.ts` — Race condition + no graceful shutdown
`setInterval` for market ticks and leaderboard refresh started before `bootstrap()`
resolved, firing against an un-initialized DB. Moved intervals inside bootstrap.
Added `SIGTERM`/`SIGINT` graceful shutdown.

### 7. `db/init.sql` — Missing `pending_orders` table
The `trading.service.ts` inserts into `pending_orders` for limit/stop orders but the
table was absent from the schema. Added with correct ENUMs and indexes.
