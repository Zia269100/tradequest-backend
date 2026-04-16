-- ============================================================================
-- Gamified Trading Simulation — Complete DB Init (schema + migrations + seeds)
-- Run this once against a blank trading_sim database.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS citext;

BEGIN;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE trade_order_type AS ENUM ('buy', 'sell');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE trade_status AS ENUM ('open', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE behavior_action_type AS ENUM (
    'FOMO', 'panic_sell', 'disciplined_trade', 'overtrade'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE virtual_currency_type AS ENUM ('virtual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_side AS ENUM ('buy', 'sell');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_class AS ENUM ('market', 'limit', 'stop');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE pending_order_status AS ENUM ('open', 'filled', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              bigserial PRIMARY KEY,
  username        text NOT NULL,
  email           citext NOT NULL,
  password_hash   text NOT NULL,
  avatar          text,
  xp              bigint NOT NULL DEFAULT 0 CHECK (xp >= 0),
  level           integer NOT NULL DEFAULT 1 CHECK (level >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (lower(username));
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at DESC);

-- ---------------------------------------------------------------------------
-- Wallets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallets (
  user_id         bigint NOT NULL PRIMARY KEY
    REFERENCES users (id) ON DELETE CASCADE,
  balance         numeric(24, 8) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  currency_type   virtual_currency_type NOT NULL DEFAULT 'virtual',
  last_updated    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Trades (RANGE partitioned by trade_timestamp)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trades (
  id              bigserial,
  user_id         bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  asset_symbol    text NOT NULL,
  order_type      trade_order_type NOT NULL,
  quantity        numeric(24, 8) NOT NULL CHECK (quantity > 0),
  entry_price     numeric(24, 8) NOT NULL CHECK (entry_price > 0),
  exit_price      numeric(24, 8) CHECK (exit_price IS NULL OR exit_price > 0),
  stop_loss       numeric(24, 8) CHECK (stop_loss IS NULL OR stop_loss > 0),
  status          trade_status NOT NULL DEFAULT 'open',
  trade_timestamp timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trades_pkey PRIMARY KEY (id, trade_timestamp),
  CONSTRAINT trades_status_exit_consistency CHECK (
    (status = 'open'  AND exit_price IS NULL)
    OR
    (status = 'closed' AND exit_price IS NOT NULL)
  )
) PARTITION BY RANGE (trade_timestamp);

CREATE TABLE IF NOT EXISTS trades_default PARTITION OF trades DEFAULT;

-- Monthly partitions — extend as needed
CREATE TABLE IF NOT EXISTS trades_2026_01 PARTITION OF trades
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS trades_2026_02 PARTITION OF trades
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS trades_2026_03 PARTITION OF trades
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS trades_2026_04 PARTITION OF trades
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS trades_2026_05 PARTITION OF trades
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS trades_2026_06 PARTITION OF trades
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS trades_2026_07 PARTITION OF trades
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS trades_2026_08 PARTITION OF trades
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS trades_2026_09 PARTITION OF trades
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS trades_2026_10 PARTITION OF trades
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS trades_2026_11 PARTITION OF trades
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS trades_2026_12 PARTITION OF trades
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

CREATE INDEX IF NOT EXISTS idx_trades_user_id_ts   ON trades (user_id, trade_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trades_asset_ts      ON trades (asset_symbol, trade_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trades_user_asset_ts ON trades (user_id, asset_symbol, trade_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trades_status_open   ON trades (user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_trades_stop_loss_check ON trades (asset_symbol, trade_timestamp ASC)
  WHERE status = 'open' AND order_type = 'buy' AND stop_loss IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Portfolio positions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portfolio (
  id             bigserial PRIMARY KEY,
  user_id        bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  asset_symbol   text NOT NULL,
  quantity       numeric(24, 8) NOT NULL CHECK (quantity > 0),
  avg_price      numeric(24, 8) NOT NULL CHECK (avg_price > 0),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portfolio_user_asset_unique UNIQUE (user_id, asset_symbol)
);

CREATE INDEX IF NOT EXISTS idx_portfolio_user   ON portfolio (user_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_symbol ON portfolio (asset_symbol);

-- ---------------------------------------------------------------------------
-- Pending orders (limit / stop orders awaiting trigger)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_orders (
  id                  bigserial PRIMARY KEY,
  user_id             bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  asset_symbol        text NOT NULL,
  side                order_side NOT NULL,
  class               order_class NOT NULL,
  quantity            numeric(24, 8) NOT NULL CHECK (quantity > 0),
  limit_price         numeric(24, 8) CHECK (limit_price IS NULL OR limit_price > 0),
  stop_trigger_price  numeric(24, 8) CHECK (stop_trigger_price IS NULL OR stop_trigger_price > 0),
  status              pending_order_status NOT NULL DEFAULT 'open',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_orders_open ON pending_orders (status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_pending_orders_user ON pending_orders (user_id);

-- ---------------------------------------------------------------------------
-- Leaderboard snapshot
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leaderboard (
  user_id            bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  rank               integer NOT NULL CHECK (rank > 0),
  roi                numeric(14, 6) NOT NULL,
  win_rate           numeric(5, 4) NOT NULL CHECK (win_rate >= 0 AND win_rate <= 1),
  consistency_score  numeric(5, 4) NOT NULL CHECK (consistency_score >= 0 AND consistency_score <= 1),
  computed_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_rank ON leaderboard (rank ASC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_roi  ON leaderboard (roi DESC);

-- ---------------------------------------------------------------------------
-- Behavior / psychology telemetry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS behavior_logs (
  id                bigserial PRIMARY KEY,
  user_id           bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  action_type       behavior_action_type NOT NULL,
  confidence_score  numeric(5, 4) NOT NULL CHECK (confidence_score >= 0 AND confidence_score <= 1),
  event_timestamp   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_behavior_user_ts    ON behavior_logs (user_id, event_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_behavior_action_ts  ON behavior_logs (action_type, event_timestamp DESC);

-- ---------------------------------------------------------------------------
-- Missions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS missions (
  id           bigserial PRIMARY KEY,
  title        text NOT NULL,
  description  text,
  reward_xp    bigint NOT NULL CHECK (reward_xp >= 0),
  difficulty   smallint NOT NULL CHECK (difficulty BETWEEN 1 AND 5)
);

-- ---------------------------------------------------------------------------
-- User missions progress
-- MIGRATION FIX: reward_granted column is required by mission.service.ts
-- but was missing from the original schema — added here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_missions (
  user_id        bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  mission_id     bigint NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  progress       smallint NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  completed      boolean NOT NULL DEFAULT false,
  reward_granted boolean NOT NULL DEFAULT false,   -- ← BUG FIX: was missing
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mission_id)
);

CREATE INDEX IF NOT EXISTS idx_user_missions_user       ON user_missions (user_id);
CREATE INDEX IF NOT EXISTS idx_user_missions_incomplete ON user_missions (user_id) WHERE NOT completed;

-- ---------------------------------------------------------------------------
-- Market data cache (DB-backed audit / fallback; hot path lives in Redis)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS market_data_cache (
  asset_symbol  text NOT NULL,
  price         numeric(24, 8) NOT NULL CHECK (price > 0),
  captured_at   timestamptz NOT NULL,
  PRIMARY KEY (asset_symbol, captured_at)
);

CREATE INDEX IF NOT EXISTS idx_market_cache_symbol_latest
  ON market_data_cache (asset_symbol, captured_at DESC);

COMMIT;

-- ============================================================================
-- Seeds — starter missions
-- ============================================================================
INSERT INTO missions (title, description, reward_xp, difficulty) VALUES
  ('First Trade',         'Place your first trade',                              100,  1),
  ('Getting Started',     'Complete 10 trades',                                  250,  1),
  ('Active Trader',       'Complete 50 trades',                                  500,  2),
  ('Day Trader',          'Complete 100 trades',                                1000,  3),
  ('Stop Loss Discipline','Have at least 3 open trades with stop losses set',    300,  2),
  ('Profit Taker',        'Close 5 trades in profit',                            400,  2),
  ('Diversified',         'Hold positions in 3 or more different assets',        350,  2)
ON CONFLICT DO NOTHING;
