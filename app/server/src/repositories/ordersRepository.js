const { openDatabase, allAsync, getAsync, closeAsync } = require('../db/connection');

async function withDatabase(work) {
  const db = openDatabase();
  try {
    return await work(db);
  } finally {
    await closeAsync(db);
  }
}

async function listOrders(filters) {
  return withDatabase(async (db) => {
    const conditions = [];
    const params = [];

    if (filters.portfolio) {
      conditions.push('portfolio = ?');
      params.push(filters.portfolio);
    }
    if (filters.symbol) {
      conditions.push('symbol LIKE ?');
      params.push(`%${filters.symbol}%`);
    }
    if (filters.from) {
      conditions.push('trade_date >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      conditions.push('trade_date <= ?');
      params.push(filters.to);
    }

    // Segment filter. Explicit rather than a silent default: this same query backs the LTCG
    // page and the symbol drill-down, and quietly dropping F&O for every caller would change
    // those too. Callers that want equity-only ask for it.
    //
    // Exchange alone is not quite enough — a row with a missing or mislabelled exchange would
    // slip through — so the contract shape is excluded as well. The leading space matters:
    // real contracts read "NIFTY 25Aug26 23900 PE", while equities like RELIANCE or FINPIPE
    // end in CE/PE with no space and must NOT be caught.
    const seg = String(filters.segment || 'all').toLowerCase();
    if (seg === 'equity') {
      conditions.push(`COALESCE(exchange,'') NOT IN ('NFO','BFO','MCX')
        AND symbol NOT LIKE '% CE' AND symbol NOT LIKE '% PE' AND symbol NOT LIKE '% FUT'`);
    } else if (seg === 'fno') {
      conditions.push(`(COALESCE(exchange,'') IN ('NFO','BFO','MCX')
        OR symbol LIKE '% CE' OR symbol LIKE '% PE' OR symbol LIKE '% FUT')`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRow = await getAsync(db, `SELECT COUNT(*) AS count FROM orders ${whereClause}`, params);
    const rows = await allAsync(
      db,
      `SELECT id, legacy_order_id, trade_date, portfolio, symbol, side, quantity, price, exchange, created_at
       FROM orders
       ${whereClause}
       ORDER BY trade_date DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, filters.pageSize, filters.offset]
    );

    return {
      total: countRow ? countRow.count : 0,
      rows,
    };
  });
}

async function getOrdersMeta() {
  return withDatabase(async (db) => {
    const portfolios = await allAsync(db, 'SELECT portfolio, COUNT(*) AS count FROM orders GROUP BY portfolio ORDER BY portfolio');
    const range = await getAsync(db, 'SELECT MIN(trade_date) AS minDate, MAX(trade_date) AS maxDate FROM orders');
    return { portfolios, range };
  });
}

async function listSoldSymbols() {
  return withDatabase((db) =>
    allAsync(
      db,
      `SELECT
         portfolio,
         symbol,
         COUNT(*) AS sell_count,
         SUM(quantity) AS sold_quantity,
         SUM(quantity * price) / NULLIF(SUM(quantity), 0) AS average_sell_price,
         SUM(quantity * price) AS total_sale_value,
         MIN(trade_date) AS first_sell_date,
         MAX(trade_date) AS last_sell_date
       FROM orders
       WHERE side = 'SELL'
       GROUP BY portfolio, symbol
       ORDER BY portfolio, symbol`
    )
  );
}

async function listOrdersForSymbol(portfolio, symbol) {
  return withDatabase((db) =>
    allAsync(
      db,
      `SELECT id, legacy_order_id, trade_date, portfolio, symbol, side, quantity, price, exchange, created_at
       FROM orders
       WHERE portfolio = ? AND symbol = ?
       ORDER BY trade_date ASC, id ASC`,
      [portfolio, symbol]
    )
  );
}

async function listRecentBuySummary(fromDate) {
  return withDatabase((db) =>
    allAsync(
      db,
      `SELECT
         portfolio,
         symbol,
         SUM(quantity) AS bought_quantity,
         SUM(quantity * price) / NULLIF(SUM(quantity), 0) AS average_buy_price,
         SUM(quantity * price) AS total_buy_value,
         COUNT(*) AS buy_count,
         MIN(trade_date) AS first_buy_date,
         MAX(trade_date) AS last_buy_date,
         MAX(exchange) AS exchange
       FROM orders
       WHERE side = 'BUY' AND trade_date >= ?
         -- EQUITY ONLY. Option/future buys belong to the Optix F&O reports: they are opened
         -- and squared off within days, so "how has this holding trended since I bought it"
         -- is a meaningless question for them — and there is no equity quote for a contract
         -- like BSESEN 20Aug26 76900 PE, so every such row rendered "Data unavailable" while
         -- still costing a live NSE lookup.
         AND COALESCE(exchange, '') NOT IN ('NFO', 'BFO', 'MCX')
       GROUP BY portfolio, symbol
       ORDER BY last_buy_date DESC, portfolio, symbol`,
      [fromDate]
    )
  );
}

async function listSellDates() {
  return withDatabase((db) =>
    allAsync(
      db,
      `SELECT trade_date AS sale_date, COUNT(*) AS sell_count
       FROM orders
       WHERE side = 'SELL'
       GROUP BY trade_date
       ORDER BY trade_date DESC`
    )
  );
}

async function listSoldSymbolsForDate(saleDate) {
  return withDatabase((db) =>
    allAsync(
      db,
      `SELECT DISTINCT portfolio, symbol
       FROM orders
       WHERE side = 'SELL' AND trade_date = ?
       ORDER BY portfolio, symbol`,
      [saleDate]
    )
  );
}

/**
 * Compute weighted-average cost basis per symbol for a portfolio.
 *
 * Uses the standard Indian weighted-average method:
 *   avgCost = totalBuyCost / totalBuyQty
 *   currentQty = totalBuyQty - totalSellQty
 *   invested = avgCost * currentQty
 *
 * Optionally restrict to orders on or before `beforeDate` (YYYY-MM-DD)
 * to reconstruct cost basis from a historical cut-off.
 */
async function getAvgCostBySymbol(portfolio, beforeDate = null) {
  return withDatabase((db) => {
    const params = [portfolio];
    const dateClause = beforeDate ? 'AND trade_date <= ?' : '';
    if (beforeDate) params.push(beforeDate);

    return allAsync(
      db,
      `SELECT
         symbol,
         SUM(CASE WHEN side = 'BUY'  THEN quantity * price ELSE 0 END)
           / NULLIF(SUM(CASE WHEN side = 'BUY' THEN quantity ELSE 0 END), 0)
           AS avg_cost,
         SUM(CASE WHEN side = 'BUY'  THEN quantity ELSE 0 END) AS total_bought,
         SUM(CASE WHEN side = 'SELL' THEN quantity ELSE 0 END) AS total_sold,
         SUM(CASE WHEN side = 'BUY'  THEN quantity ELSE -quantity END) AS net_qty,
         MIN(CASE WHEN side = 'BUY' THEN trade_date END) AS first_buy_date,
         MAX(CASE WHEN side = 'BUY' THEN trade_date END) AS last_buy_date
       FROM orders
       WHERE portfolio = ? ${dateClause}
       GROUP BY symbol
       HAVING net_qty > 0
       ORDER BY symbol`,
      params
    );
  });
}

module.exports = {
  listOrders,
  getOrdersMeta,
  listSoldSymbols,
  listOrdersForSymbol,
  listRecentBuySummary,
  listSellDates,
  listSoldSymbolsForDate,
  getAvgCostBySymbol,
};
