const { openDatabase, runAsync, getAsync, allAsync, closeAsync } = require('../db/connection');

async function withDatabase(work) {
  const db = openDatabase();
  try {
    return await work(db);
  } finally {
    await closeAsync(db);
  }
}

async function createImportRun(sourceType, sourceName, startedAt = new Date().toISOString()) {
  return withDatabase(async (db) => {
    const result = await runAsync(
      db,
      `INSERT INTO import_runs (source_type, source_name, status, started_at)
       VALUES (?, ?, 'RUNNING', ?)`,
      [sourceType, sourceName, startedAt]
    );

    return {
      id: result.lastID,
      startedAt,
    };
  });
}

async function finalizeImportRun(id, status, counts, notes = '') {
  return withDatabase(async (db) => {
    await runAsync(
      db,
      `UPDATE import_runs
       SET status = ?, completed_at = ?, rows_seen = ?, rows_inserted = ?, rows_skipped = ?, notes = ?
       WHERE id = ?`,
      [
        status,
        new Date().toISOString(),
        counts.rowsSeen || 0,
        counts.rowsInserted || 0,
        counts.rowsSkipped || 0,
        notes,
        id,
      ]
    );
  });
}

async function replaceOrdersForPortfolioDates(portfolio, ordersByDate) {
  return withDatabase(async (db) => {
    await runAsync(db, 'BEGIN TRANSACTION');
    try {
      let inserted = 0;
      const dates = Object.keys(ordersByDate);

      for (const tradeDate of dates) {
        await runAsync(db, 'DELETE FROM orders WHERE portfolio = ? AND trade_date = ?', [portfolio, tradeDate]);

        for (const order of ordersByDate[tradeDate]) {
          await runAsync(
            db,
            `INSERT INTO orders
              (trade_date, portfolio, symbol, side, quantity, price, exchange, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              tradeDate,
              portfolio,
              order.symbol,
              order.side,
              Number(order.quantity || 0),
              Number(order.price || 0),
              order.exchange || 'NSE',
              new Date().toISOString(),
            ]
          );
          inserted += 1;
        }
      }

      await runAsync(db, 'COMMIT');
      return { inserted, replacedDates: dates.length };
    } catch (error) {
      await runAsync(db, 'ROLLBACK');
      throw error;
    }
  });
}

async function listExistingOrdersForPortfolioDates(portfolio, tradeDates) {
  if (!tradeDates?.length) {
    return [];
  }

  return withDatabase((db) => {
    const placeholders = tradeDates.map(() => '?').join(', ');
    return allAsync(
      db,
      `SELECT id, legacy_order_id, trade_date, portfolio, symbol, side, quantity, price, exchange
       FROM orders
       WHERE portfolio = ?
         AND trade_date IN (${placeholders})`,
      [portfolio, ...tradeDates]
    );
  });
}

// trade_time was added after the orders table existed, and the schema runner here is a
// one-shot script rather than an auto-migrator — so the column is ensured defensively at the
// point of use, the same way the advisory and external-recs tables migrate themselves.
async function ensureTradeTimeColumn(db) {
  const cols = await allAsync(db, 'PRAGMA table_info(orders)');
  if (!cols.some((c) => c.name === 'trade_time')) {
    await runAsync(db, 'ALTER TABLE orders ADD COLUMN trade_time TEXT');
    console.log('◇ orders.trade_time column added (execution time for same-day FIFO ordering)');
  }
  if (!cols.some((c) => c.name === 'broker_order_id')) {
    await runAsync(db, 'ALTER TABLE orders ADD COLUMN broker_order_id TEXT');
    console.log('◇ orders.broker_order_id column added (intraday sequence for FIFO ordering)');
  }
}

// Run at BOOT so no write path can depend on remembering to migrate. The lazy call inside
// insertOrders stays as a second line of defence, but the bug it is guarding against —
// a column added to an INSERT while the migration sat in a DIFFERENT function — cost two days
// of silently-dropped broker imports, and per-path migration is what made that possible.
// The broker's own code for the instrument, kept beside the normalised NSE symbol so a
// rewritten row's provenance stays visible and a bad mapping stays traceable.
async function ensureBrokerSymbolColumn(db) {
  const cols = await allAsync(db, 'PRAGMA table_info(orders)');
  if (!cols.some((c) => c.name === 'broker_symbol')) {
    await runAsync(db, 'ALTER TABLE orders ADD COLUMN broker_symbol TEXT');
  }
}

async function ensureOrderColumns() {
  return withDatabase(async (db) => {
    await ensureTradeTimeColumn(db);
    await ensureBrokerSymbolColumn(db);
  });
}

async function insertOrders(portfolio, orders) {
  if (!orders?.length) {
    return { inserted: 0 };
  }

  return withDatabase(async (db) => {
    // Ensure the added columns exist BEFORE the INSERT names them. This is the Breeze save
    // path; the call previously sat in importOrders (the CSV path) instead, so every broker
    // import failed with 'no column named trade_time' and silently saved nothing.
    await ensureTradeTimeColumn(db);
    await ensureBrokerSymbolColumn(db);
    // Required lazily: portfolioService pulls in repositories of its own, and a top-level
    // require here closes that loop. Same reason ordersService defers it.
    const { resolveNseSymbol } = require('../services/portfolio/portfolioService');
    await runAsync(db, 'BEGIN TRANSACTION');
    try {
      let inserted = 0;

      for (const order of orders) {
        await runAsync(
          db,
          `INSERT INTO orders
            (legacy_order_id, trade_date, trade_time, broker_order_id, portfolio, symbol, broker_symbol, side, quantity, price, exchange, charges, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            order.tradeId ? Number(order.tradeId) || null : null,
            order.tradeDate,
            // Nullable: CSV imports and historical rows have no execution time. FIFO falls
            // back to insert order for those and flags the row rather than asserting a side.
            order.tradeTime || null,
            order.brokerOrderId || null,
            portfolio,
            // NORMALISED, NOT AS THE BROKER SENT IT.
            // ICICI returns its own codes (RELIND, HDFAMC, BHAELE ...) while CSV imports and
            // the demat file use NSE symbols, so the same stock was landing under two names and
            // the app treated them as two stocks. That is not cosmetic: FIFO lot matching,
            // LTCG/STCG, the sell evaluator and realised P&L all key off `symbol`, so a split
            // divorced sells from the buys that funded them - RELIANCE sat at 120 bought / 37
            // sold while a separate RELIND held 218 sells with no cost basis reachable.
            // 33 codes and 120 rows had accumulated before this was caught.
            // resolveNseSymbol is an exact-key lookup and returns its input unchanged when
            // there is no mapping, so F&O descriptors ("NIFTY 26AUG26 24000 CE") pass through.
            resolveNseSymbol(order.symbol) || order.symbol,
            order.symbol,
            order.side,
            Number(order.quantity || 0),
            Number(order.price || 0),
            order.exchange || 'NSE',
            Number(order.charges || 0),
            new Date().toISOString(),
          ]
        );
        inserted += 1;
      }

      await runAsync(db, 'COMMIT');
      return { inserted };
    } catch (error) {
      await runAsync(db, 'ROLLBACK');
      throw error;
    }
  });
}

async function replacePortfolioSnapshot({ portfolio, snapshotDate, holdings }) {
  return withDatabase(async (db) => {
    const normalizedHoldings = holdings.map((holding) => ({
      instrument: holding.instrument,
      qty: Number(holding.qty || 0),
      avgCost: Number(holding.avgCost || 0),
      ltp: Number(holding.ltp || 0),
      invested: Number(holding.invested || 0),
      curVal: Number(holding.curVal || 0),
      pnl: Number(holding.pnl || 0),
      netChg: Number(holding.netChg || 0),
      dayChg: Number(holding.dayChg || 0),
      // PLEDGED FOR MARGIN. breezeService works this out (demat reports 0 while
      // portfolioholdings carries the real quantity) and it was being dropped here, so the
      // stored capture could not distinguish "quantity 0 because pledged" from "quantity 0
      // because sold". That ambiguity cost real time: 34 captures between 2026-06-02 and
      // 07-17 show the gold and silver ETFs at zero or absent, and they read as a Rs 71L
      // position vanishing and reappearing rather than as collateral. Persisted now so the
      // next reader is told, not left to infer.
      pledged: holding.pledged === true,
      momentumScore: 0,
      momentumLabel: 'Pending',
      fundamentalScore: 0,
      fundamentalLabel: 'Pending',
      technicalScore: 0,
      technicalLabel: 'Pending',
      momFunTechScore: 0,
      momFunTechLabel: 'Pending',
      beta: 1,
      sector: 'Unknown',
      industry: 'Unknown',
      fiftyTwoWeekHigh: 0,
      drawdown: 0,
    }));

    const payload = {
      name: portfolio,
      date: snapshotDate,
      lastUpdated: new Date().toISOString(),
      marketStatus: null,
      portfolio: normalizedHoldings,
    };

    const summary = normalizedHoldings.reduce(
      (accumulator, holding) => {
        accumulator.totalInvested += holding.invested;
        accumulator.totalValue += holding.curVal;
        accumulator.stockCount += 1;
        return accumulator;
      },
      {
        totalInvested: 0,
        totalValue: 0,
        stockCount: 0,
      }
    );

    // ── INTEGRITY CHECK BEFORE OVERWRITING A GOOD DAY ────────────────────────
    // This insert DELETES the existing rows for (portfolio, date) first, so a broken capture
    // does not just add noise — it destroys whatever was there. That is how the May-July 2026
    // history was lost: captures arrived with holdings present but every price at zero, or
    // with the largest positions missing entirely, and each one silently replaced a good day.
    // A Rs 1.2cr book ended up recorded as Rs 2.84L, and nothing anywhere said so.
    //
    // Two things are checked, both against the LAST GOOD capture for this portfolio rather
    // than against fixed numbers, so the guard follows the book as it grows:
    //
    //   * priced ratio — most holdings must carry a real price. A few permanently unpriced
    //     dead scrips (IMAMAR, ORASTA) are normal, an all-zero capture is not.
    //   * holding count — a truncated fetch returns 7 names where 36 were held. Count is the
    //     right measure because it does not depend on prices resolving.
    //
    // A failing capture is REJECTED, leaving the previous good day intact. Refusing to write
    // is always recoverable; overwriting is not.
    const priced = normalizedHoldings.filter((h) => (h.qty || 0) > 0 && (h.ltp || 0) > 0).length;
    const pricedRatio = normalizedHoldings.length ? priced / normalizedHoldings.length : 0;

    const previous = await getAsync(
      db,
      `SELECT stock_count, total_value FROM portfolio_summary
        WHERE portfolio = ? AND summary_date < ? AND total_value > 0
        ORDER BY summary_date DESC LIMIT 1`,
      [portfolio, snapshotDate]
    );

    const problems = [];
    if (!normalizedHoldings.length) {
      problems.push('the capture contains no holdings at all');
    } else if (pricedRatio < 0.7) {
      problems.push(`only ${priced} of ${normalizedHoldings.length} holdings have a price `
        + `(${Math.round(pricedRatio * 100)}%) — the price fetch appears to have failed`);
    }
    if (previous?.stock_count && normalizedHoldings.length < previous.stock_count * 0.5) {
      problems.push(`only ${normalizedHoldings.length} holdings against ${previous.stock_count} `
        + 'in the last good capture — this looks like a truncated fetch');
    }

    if (problems.length) {
      const error = new Error(
        `Refused to save the ${portfolio} snapshot for ${snapshotDate}: ${problems.join('; ')}. `
        + 'The previous capture has been left untouched. Re-run the import once the source is '
        + 'returning complete data.'
      );
      error.code = 'SNAPSHOT_REJECTED';
      error.details = {
        portfolio, snapshotDate, problems,
        holdings: normalizedHoldings.length,
        priced,
        previousCount: previous?.stock_count ?? null,
      };
      throw error;
    }

    await runAsync(db, 'BEGIN TRANSACTION');
    try {
      await runAsync(db, 'DELETE FROM portfolio_snapshots WHERE portfolio = ? AND snapshot_date = ?', [portfolio, snapshotDate]);
      await runAsync(db, 'DELETE FROM portfolio_summary WHERE portfolio = ? AND summary_date = ?', [portfolio, snapshotDate]);
      // NOTE: do NOT delete holding_scores here. Scores are an independent
      // artifact (replaced per (date, portfolio) by the next health scan) —
      // deleting them silently destroyed same-day scans on every holdings import.

      await runAsync(
        db,
        `INSERT INTO portfolio_snapshots
          (portfolio, snapshot_date, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
        [portfolio, snapshotDate, JSON.stringify(payload), new Date().toISOString()]
      );

      await runAsync(
        db,
        `INSERT INTO portfolio_summary
          (summary_date, portfolio, total_invested, total_value, day_change_value, day_change_pct, net_inflow, stock_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshotDate,
          portfolio,
          summary.totalInvested,
          summary.totalValue,
          0,
          0,
          summary.totalInvested,
          summary.stockCount,
          new Date().toISOString(),
        ]
      );

      await runAsync(db, 'COMMIT');
      return {
        inserted: normalizedHoldings.length,
        snapshotDate,
      };
    } catch (error) {
      await runAsync(db, 'ROLLBACK');
      throw error;
    }
  });
}

async function findLatestImportRun() {
  return withDatabase((db) =>
    getAsync(
      db,
      `SELECT id, source_type, source_name, status, started_at, completed_at, rows_seen, rows_inserted, rows_skipped, notes
       FROM import_runs
       ORDER BY id DESC
       LIMIT 1`
    )
  );
}

module.exports = {
  ensureOrderColumns,
  createImportRun,
  finalizeImportRun,
  replaceOrdersForPortfolioDates,
  listExistingOrdersForPortfolioDates,
  insertOrders,
  replacePortfolioSnapshot,
  findLatestImportRun,
};
