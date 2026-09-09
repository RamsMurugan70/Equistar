const importsRepository = require('../../repositories/importsRepository');

async function importOrders({ portfolio, fileName, ordersByDate }) {
  if (!portfolio) {
    throw new Error('Portfolio is required.');
  }

  const dates = Object.keys(ordersByDate || {});
  if (!dates.length) {
    throw new Error('No parsed orders found in the uploaded file.');
  }

  const run = await importsRepository.createImportRun('orders-upload', fileName || 'orders-file');
  const rowsSeen = dates.reduce((sum, dateKey) => sum + (ordersByDate[dateKey]?.length || 0), 0);

  try {
    const result = await importsRepository.replaceOrdersForPortfolioDates(portfolio, ordersByDate);
    await importsRepository.finalizeImportRun(
      run.id,
      'COMPLETED',
      {
        rowsSeen,
        rowsInserted: result.inserted,
        rowsSkipped: 0,
      },
      JSON.stringify({ portfolio, dates })
    );

    return {
      importRunId: run.id,
      portfolio,
      replacedDates: result.replacedDates,
      rowsInserted: result.inserted,
      rowsSeen,
    };
  } catch (error) {
    await importsRepository.finalizeImportRun(run.id, 'FAILED', { rowsSeen, rowsInserted: 0, rowsSkipped: 0 }, error.message);
    throw error;
  }
}

async function importPortfolioSnapshot({ portfolio, snapshotDate, fileName, holdings }) {
  if (!portfolio) {
    throw new Error('Portfolio is required.');
  }
  if (!snapshotDate) {
    throw new Error('Snapshot date is required.');
  }
  if (!holdings?.length) {
    throw new Error('No parsed portfolio rows found in the uploaded file.');
  }

  const run = await importsRepository.createImportRun('portfolio-upload', fileName || 'portfolio-file');
  const rowsSeen = holdings.length;

  try {
    const result = await importsRepository.replacePortfolioSnapshot({ portfolio, snapshotDate, holdings });
    await importsRepository.finalizeImportRun(
      run.id,
      'COMPLETED',
      {
        rowsSeen,
        rowsInserted: result.inserted,
        rowsSkipped: 0,
      },
      JSON.stringify({ portfolio, snapshotDate })
    );

    return {
      importRunId: run.id,
      portfolio,
      snapshotDate,
      rowsInserted: result.inserted,
      rowsSeen,
    };
  } catch (error) {
    await importsRepository.finalizeImportRun(run.id, 'FAILED', { rowsSeen, rowsInserted: 0, rowsSkipped: 0 }, error.message);
    throw error;
  }
}

async function getLatestImportRun() {
  return importsRepository.findLatestImportRun();
}

// MUST be keyed on the NORMALISED symbol, because that is what insertOrders stores.
//
// This was the duplicate bug. insertOrders writes resolveNseSymbol(order.symbol) — so an ICICI
// row arrives as FIRSOU and is stored as FSL. The key built from the incoming order therefore
// read FIRSOU while the key built from the stored row read FSL, the two never matched, and the
// row was re-inserted on every single sync. Only the stocks whose broker code differs from the
// NSE symbol were affected, which is why it hid for so long: 18 of 20 rows in a re-import
// skipped correctly and the 2 remapped ones silently doubled.
//
// Required lazily for the same reason importsRepository does it: portfolioService pulls in
// repositories of its own and a top-level require here closes that loop.
function normalizeSymbolForKey(symbol) {
  const { resolveNseSymbol } = require('../portfolio/portfolioService');
  return String(resolveNseSymbol(symbol) || symbol || '').toUpperCase();
}

function buildOrderTupleKey(portfolio, order) {
  return [
    portfolio,
    order.tradeDate,
    normalizeSymbolForKey(order.symbol),
    order.side,
    Number(order.quantity || 0),
    Number(order.price || 0),
    order.exchange || 'NSE',
  ].join('::');
}

async function importMissingOrders({ portfolio, fileName, orders }) {
  if (!portfolio) {
    throw new Error('Portfolio is required.');
  }
  if (!orders?.length) {
    throw new Error('No parsed orders found in the uploaded file.');
  }

  const run = await importsRepository.createImportRun('orders-download-upload', fileName || 'orders-file');
  const rowsSeen = orders.length;
  const tradeDates = [...new Set(orders.map((order) => order.tradeDate).filter(Boolean))];

  try {
    const existingRows = await importsRepository.listExistingOrdersForPortfolioDates(portfolio, tradeDates);
    const existingTradeIds = new Set(
      existingRows
        .map((row) => String(row.legacy_order_id || '').trim())
        .filter(Boolean)
    );
    // The broker's own order id is the ONLY provable re-import marker: two rows carrying it are
    // the same fill seen twice, whereas two rows sharing a natural key are usually a genuine
    // repeat fill (one stock bought at one price several times in a day). Checked first, and
    // separately, so the tuple pass below never has to guess about rows that carry one.
    const existingBrokerOrderIds = new Set(
      existingRows
        .map((row) => String(row.broker_order_id || '').trim())
        .filter(Boolean)
    );

    const tupleCounts = new Map();
    for (const row of existingRows) {
      // Normalised on BOTH sides. The stored symbol is already normalised for rows written by
      // the current importer, but rows imported before that existed sit under the raw broker
      // code — and resolveNseSymbol is idempotent, so passing an already-NSE symbol is a no-op.
      const key = [
        portfolio,
        row.trade_date,
        normalizeSymbolForKey(row.symbol),
        row.side,
        Number(row.quantity || 0),
        Number(row.price || 0),
        row.exchange || 'NSE',
      ].join('::');
      tupleCounts.set(key, (tupleCounts.get(key) || 0) + 1);
    }

    const toInsert = [];
    let skipped = 0;

    for (const order of orders) {
      const brokerOrderId = String(order.brokerOrderId || '').trim();
      if (brokerOrderId && existingBrokerOrderIds.has(brokerOrderId)) {
        skipped += 1;
        continue;
      }

      const tradeId = String(order.tradeId || '').trim();
      if (tradeId && existingTradeIds.has(tradeId)) {
        skipped += 1;
        continue;
      }

      const tupleKey = buildOrderTupleKey(portfolio, order);
      const existingCount = tupleCounts.get(tupleKey) || 0;
      if (existingCount > 0) {
        tupleCounts.set(tupleKey, existingCount - 1);
        skipped += 1;
        continue;
      }

      toInsert.push(order);
      // Both ids are recorded as the batch is walked, so a file that repeats a row inside
      // itself is caught too — not only a file replayed against what is already stored.
      if (brokerOrderId) {
        existingBrokerOrderIds.add(brokerOrderId);
      }
      if (tradeId) {
        existingTradeIds.add(tradeId);
      }
    }

    const result = await importsRepository.insertOrders(portfolio, toInsert);
    // Rows the unique index refused are added to the skip count rather than left unaccounted
    // for. In practice this should stay zero — the checks above catch a replay first — so a
    // non-zero value is a signal that something reached the writer the service did not expect,
    // and it must not be able to hide by making seen ≠ inserted + skipped.
    const totalSkipped = skipped + (result.skipped || 0);
    await importsRepository.finalizeImportRun(
      run.id,
      'COMPLETED',
      {
        rowsSeen,
        rowsInserted: result.inserted,
        rowsSkipped: totalSkipped,
      },
      JSON.stringify({ portfolio, tradeDates, fileName })
    );

    return {
      importRunId: run.id,
      portfolio,
      rowsSeen,
      rowsInserted: result.inserted,
      rowsSkipped: totalSkipped,
      tradeDates,
    };
  } catch (error) {
    await importsRepository.finalizeImportRun(run.id, 'FAILED', { rowsSeen, rowsInserted: 0, rowsSkipped: 0 }, error.message);
    throw error;
  }
}

module.exports = {
  importOrders,
  importMissingOrders,
  importPortfolioSnapshot,
  getLatestImportRun,
};
