CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    legacy_order_id INTEGER,
    trade_date TEXT NOT NULL,
    portfolio TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    quantity REAL NOT NULL,
    price REAL NOT NULL,
    exchange TEXT,
    created_at TEXT,
    imported_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orders_trade_date ON orders (trade_date);
CREATE INDEX IF NOT EXISTS idx_orders_portfolio ON orders (portfolio);
CREATE INDEX IF NOT EXISTS idx_orders_symbol ON orders (symbol);

CREATE TABLE IF NOT EXISTS import_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    source_name TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    rows_seen INTEGER DEFAULT 0,
    rows_inserted INTEGER DEFAULT 0,
    rows_skipped INTEGER DEFAULT 0,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    legacy_snapshot_id INTEGER,
    portfolio TEXT NOT NULL,
    snapshot_date TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT,
    imported_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_snapshots_portfolio_date ON portfolio_snapshots (portfolio, snapshot_date);

CREATE TABLE IF NOT EXISTS portfolio_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    legacy_summary_id INTEGER,
    summary_date TEXT NOT NULL,
    portfolio TEXT NOT NULL,
    total_invested REAL DEFAULT 0,
    total_value REAL DEFAULT 0,
    day_change_value REAL DEFAULT 0,
    day_change_pct REAL DEFAULT 0,
    net_inflow REAL DEFAULT 0,
    stock_count INTEGER DEFAULT 0,
    created_at TEXT,
    imported_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_portfolio_summary_portfolio_date ON portfolio_summary (portfolio, summary_date);

CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    legacy_recommendation_id INTEGER,
    recommendation_date TEXT NOT NULL,
    advisor TEXT NOT NULL,
    symbol TEXT NOT NULL,
    action_type TEXT NOT NULL,
    cmp REAL,
    target_price REAL,
    stop_loss REAL,
    timeframe TEXT,
    status TEXT,
    notes TEXT,
    created_at TEXT,
    imported_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS holding_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    score_date TEXT NOT NULL,
    portfolio TEXT NOT NULL,
    symbol TEXT NOT NULL,
    momentum_score REAL,
    fundamental_score REAL,
    technical_score REAL,
    combined_score REAL,
    score_version TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_holding_scores_lookup ON holding_scores (score_date, portfolio, symbol);

CREATE TABLE IF NOT EXISTS market_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    symbol TEXT NOT NULL,
    data_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_market_cache_provider_symbol ON market_cache (provider, symbol);

-- Cost basis overrides: user-supplied avgCost per symbol for portfolios
-- where the broker API (e.g. ICICI Breeze demat) does not provide buy price.
CREATE TABLE IF NOT EXISTS cost_basis_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio TEXT NOT NULL,
    symbol TEXT NOT NULL,
    avg_cost REAL NOT NULL,
    qty_at_override REAL,       -- optional: qty held when this override was captured
    as_of_date TEXT,            -- date of the source snapshot (e.g. "2026-05-14")
    source TEXT DEFAULT 'manual',
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(portfolio, symbol)
);

CREATE INDEX IF NOT EXISTS idx_cost_basis_portfolio ON cost_basis_overrides (portfolio);

-- Daily brokerage/charges aggregate (one row per trade_date + portfolio + exchange).
-- The `charges` column on orders stores per-trade charges captured from Breeze.
-- This table aggregates them for quick P&L reporting.
CREATE TABLE IF NOT EXISTS daily_brokerage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_date TEXT NOT NULL,
    portfolio TEXT NOT NULL,
    exchange TEXT NOT NULL DEFAULT '',
    brokerage REAL DEFAULT 0,
    stt REAL DEFAULT 0,
    exchange_charges REAL DEFAULT 0,
    gst REAL DEFAULT 0,
    stamp_duty REAL DEFAULT 0,
    sebi_charges REAL DEFAULT 0,
    other_charges REAL DEFAULT 0,
    total_charges REAL DEFAULT 0,
    trade_count INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(trade_date, portfolio, exchange)
);

CREATE INDEX IF NOT EXISTS idx_daily_brokerage_date ON daily_brokerage (trade_date);
CREATE INDEX IF NOT EXISTS idx_daily_brokerage_portfolio ON daily_brokerage (portfolio);

CREATE TABLE IF NOT EXISTS migration_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_label TEXT NOT NULL,
    table_name TEXT NOT NULL,
    source_count INTEGER DEFAULT 0,
    target_count INTEGER DEFAULT 0,
    details_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
