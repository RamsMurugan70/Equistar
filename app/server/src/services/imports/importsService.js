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

function buildOrderTupleKey(portfolio, order) {
  return [
    portfolio,
    order.tradeDate,
    order.symbol,
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
    const tupleCounts = new Map();
    for (const row of existingRows) {
      const key = [
        portfolio,
        row.trade_date,
        row.symbol,
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
      if (tradeId) {
        existingTradeIds.add(tradeId);
      }
    }

    const result = await importsRepository.insertOrders(portfolio, toInsert);
    await importsRepository.finalizeImportRun(
      run.id,
      'COMPLETED',
      {
        rowsSeen,
        rowsInserted: result.inserted,
        rowsSkipped: skipped,
      },
      JSON.stringify({ portfolio, tradeDates, fileName })
    );

    return {
      importRunId: run.id,
      portfolio,
      rowsSeen,
      rowsInserted: result.inserted,
      rowsSkipped: skipped,
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
