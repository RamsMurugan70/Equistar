const ordersRepository = require('../../repositories/ordersRepository');
const nseService = require('../market/nseService');
const { resolveNseSymbol } = require('../portfolio/portfolioService');

function toDisplayDate(date) {
  const [year, month, day] = String(date || '').split('-');
  if (!year || !month || !day) return '';
  return `${day}-${month}-${year}`;
}

// One dropdown option per SYMBOL (not per portfolio/symbol pair) — a stock sold in
// both Rams and Geetha shows once, with `portfolios` listing where. The evaluator
// (evaluateSoldSymbolCombined below) pulls sells from every portfolio that has them.
function buildSellOptions(rows) {
  const bySymbol = new Map();
  for (const row of rows) {
    const soldQuantity = Number(row.sold_quantity || 0);
    const totalSaleValue = Number(row.total_sale_value || 0);
    const existing = bySymbol.get(row.symbol);
    if (!existing) {
      bySymbol.set(row.symbol, {
        symbol: row.symbol,
        label: row.symbol,
        portfolios: [row.portfolio],
        sellCount: Number(row.sell_count || 0),
        soldQuantity,
        totalSaleValue,
        firstSellDate: row.first_sell_date,
        lastSellDate: row.last_sell_date,
      });
      continue;
    }
    existing.portfolios.push(row.portfolio);
    existing.sellCount += Number(row.sell_count || 0);
    existing.soldQuantity += soldQuantity;
    existing.totalSaleValue += totalSaleValue;
    if (row.first_sell_date < existing.firstSellDate) existing.firstSellDate = row.first_sell_date;
    if (row.last_sell_date > existing.lastSellDate) existing.lastSellDate = row.last_sell_date;
  }
  return [...bySymbol.values()]
    .map((o) => ({ ...o, averageSellPrice: o.soldQuantity > 0 ? o.totalSaleValue / o.soldQuantity : 0 }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function buildFifoEvaluation(orders) {
  const buyLots = [];
  const saleLots = [];

  for (const order of orders) {
    const quantity = Number(order.quantity || 0);
    const price = Number(order.price || 0);
    if (quantity <= 0 || price <= 0) continue;

    if (order.side === 'BUY') {
      buyLots.push({
        remainingQuantity: quantity,
        buyPrice: price,
        buyDate: order.trade_date,
      });
      continue;
    }

    if (order.side !== 'SELL') continue;

    let remainingToMatch = quantity;
    let matchedCost = 0;
    let matchedQuantity = 0;

    while (remainingToMatch > 0 && buyLots.length > 0) {
      const currentLot = buyLots[0];
      const matched = Math.min(remainingToMatch, currentLot.remainingQuantity);
      matchedCost += matched * currentLot.buyPrice;
      matchedQuantity += matched;
      currentLot.remainingQuantity -= matched;
      remainingToMatch -= matched;

      if (currentLot.remainingQuantity <= 0) {
        buyLots.shift();
      }
    }

    saleLots.push({
      saleDate: order.trade_date,
      soldQuantity: quantity,
      salePrice: price,
      saleValue: quantity * price,
      matchedQuantity,
      unmatchedQuantity: quantity - matchedQuantity,
      matchedCost,
      realizedPnl: (quantity * price) - matchedCost,
    });
  }

  return saleLots;
}

function applyCorporateActions(saleLots, actions, currentPrice) {
  const evaluatedLots = saleLots.map((lot) => {
    const saleTime = nseService.parseDateValue(lot.saleDate)?.getTime() || 0;
    const applicableActions = actions.filter((action) => {
      const actionTime = nseService.parseDateValue(action.actionDate)?.getTime() || 0;
      return actionTime > saleTime;
    });

    let adjustedQuantityToday = lot.soldQuantity;
    let dividendCashReceived = 0;
    const appliedActions = [];
    const unsupportedActions = [];

    for (const action of applicableActions) {
      if (!action.supported) {
        unsupportedActions.push(action);
        continue;
      }

      if (action.effectType === 'quantity') {
        adjustedQuantityToday *= action.factor || 1;
        appliedActions.push(action);
        continue;
      }

      if (action.effectType === 'cash') {
        dividendCashReceived += adjustedQuantityToday * (action.amountPerShare || 0);
        appliedActions.push(action);
        continue;
      }
    }

    const adjustmentFactor = lot.soldQuantity > 0 ? adjustedQuantityToday / lot.soldQuantity : 1;
    const hasPrice = Number.isFinite(currentPrice) && currentPrice > 0;
    const holdValueToday = hasPrice ? (adjustedQuantityToday * currentPrice) + dividendCashReceived : null;
    const missedProfitVsSale = hasPrice ? holdValueToday - lot.saleValue : null;

    return {
      ...lot,
      adjustmentFactor,
      adjustedQuantityToday,
      dividendCashReceived,
      holdValueToday,
      missedProfitVsSale,
      appliedActions,
      unsupportedActions,
    };
  });

  return evaluatedLots;
}

async function listSellEvaluatorOptions() {
  const rows = await ordersRepository.listSoldSymbols();
  return buildSellOptions(rows);
}

async function listSellEvaluatorDates() {
  const rows = await ordersRepository.listSellDates();
  return rows.map((row) => ({
    saleDate: row.sale_date,
    sellCount: Number(row.sell_count || 0),
    label: `${row.sale_date} (${row.sell_count})`,
  }));
}

function summarizeLots(lots) {
  // Hold-vs-today metrics are only meaningful if every lot has a current price
  const hasPrice = lots.length > 0 && lots.every((lot) => lot.holdValueToday != null);
  const summary = lots.reduce((accumulator, lot) => {
    accumulator.soldQuantity += lot.soldQuantity;
    accumulator.saleValue += lot.saleValue;
    accumulator.matchedCost += lot.matchedCost;
    accumulator.realizedPnl += lot.realizedPnl;
    accumulator.adjustedQuantityToday += lot.adjustedQuantityToday;
    accumulator.dividendCashReceived += lot.dividendCashReceived;
    accumulator.holdValueToday += (lot.holdValueToday || 0);
    accumulator.missedProfitVsSale += (lot.missedProfitVsSale || 0);
    accumulator.matchedQuantity += lot.matchedQuantity;
    accumulator.unmatchedQuantity += lot.unmatchedQuantity;
    return accumulator;
  }, {
    soldQuantity: 0,
    saleValue: 0,
    matchedCost: 0,
    realizedPnl: 0,
    adjustedQuantityToday: 0,
    dividendCashReceived: 0,
    holdValueToday: 0,
    missedProfitVsSale: 0,
    matchedQuantity: 0,
    unmatchedQuantity: 0,
  });

  return {
    soldQuantity: summary.soldQuantity,
    averageSellPrice: summary.soldQuantity > 0 ? summary.saleValue / summary.soldQuantity : 0,
    totalSaleValue: summary.saleValue,
    fifoCostBasis: summary.matchedCost,
    realizedPnlAtSale: summary.realizedPnl,
    matchedQuantity: summary.matchedQuantity,
    unmatchedQuantity: summary.unmatchedQuantity,
    adjustedQuantityToday: summary.adjustedQuantityToday,
    dividendCashReceived: summary.dividendCashReceived,
    holdValueToday: hasPrice ? summary.holdValueToday : null,
    missedProfitVsSale: hasPrice ? summary.missedProfitVsSale : null,
  };
}

async function evaluateSoldSymbol(portfolio, symbol) {
  if (!portfolio || !symbol) {
    throw new Error('Portfolio and symbol are required.');
  }

  // Raw per-(portfolio,symbol) rows — NOT listSellEvaluatorOptions(), which merges
  // across portfolios for the dropdown and no longer carries a single `.portfolio`.
  const rawRows = await ordersRepository.listSoldSymbols();
  const row = rawRows.find((item) => item.portfolio === portfolio && item.symbol === symbol);
  if (!row) {
    throw new Error(`No sell history found for ${portfolio} / ${symbol}.`);
  }
  const selection = {
    portfolio: row.portfolio, symbol: row.symbol,
    sellCount: Number(row.sell_count || 0), soldQuantity: Number(row.sold_quantity || 0),
    averageSellPrice: Number(row.average_sell_price || 0), totalSaleValue: Number(row.total_sale_value || 0),
    firstSellDate: row.first_sell_date, lastSellDate: row.last_sell_date,
  };

  const orders = await ordersRepository.listOrdersForSymbol(portfolio, symbol);
  const saleLots = buildFifoEvaluation(orders);

  // Current price — NSE quote 403s server-side, so use the Yahoo-fallback path
  // (fetchMomentumSnapshot). Tolerate failure: realized P&L still works without it.
  const nseSymbol = resolveNseSymbol(symbol);
  let currentPrice = null;
  let currentPriceAsOf = '';
  try {
    const snap = await nseService.fetchMomentumSnapshot(nseSymbol);
    currentPrice = snap.currentPrice;
    currentPriceAsOf = snap.asOf || '';
  } catch (_e) { /* price unavailable → hold-vs-today columns blank */ }

  // Corporate actions also hit NSE and can fail — tolerate.
  let corporateActions = [];
  try {
    corporateActions = await nseService.fetchCorporateActions(
      symbol,
      toDisplayDate(selection.firstSellDate),
      toDisplayDate(new Date().toISOString().slice(0, 10))
    );
  } catch (_e) { corporateActions = []; }

  const evaluatedLots = applyCorporateActions(saleLots, corporateActions, currentPrice);

  return {
    mode: 'symbol',
    portfolio,
    symbol,
    selection,
    currentPrice,
    currentPriceAsOf,
    priceUnavailable: currentPrice == null,
    saleSummary: summarizeLots(evaluatedLots),
    saleLots: evaluatedLots,
    corporateActions,
  };
}

// Merged view for the dropdown: pulls FIFO-evaluated sales for a symbol from EVERY
// portfolio that sold it (each portfolio's FIFO is still computed independently —
// buy lots aren't shared across portfolios — the merge only happens at display time).
// Each returned sale lot is tagged with its portfolio so provenance isn't lost.
async function evaluateSoldSymbolCombined(symbol) {
  if (!symbol) {
    throw new Error('Symbol is required.');
  }

  const rawRows = await ordersRepository.listSoldSymbols();
  const portfolios = rawRows.filter((row) => row.symbol === symbol).map((row) => row.portfolio);
  if (!portfolios.length) {
    throw new Error(`No sell history found for ${symbol}.`);
  }

  const evaluations = await Promise.all(portfolios.map((p) => evaluateSoldSymbol(p, symbol)));
  const mergedLots = evaluations.flatMap((ev) => ev.saleLots.map((lot) => ({ ...lot, portfolio: ev.portfolio })));
  const withPrice = evaluations.find((ev) => ev.currentPrice != null);

  return {
    mode: 'symbol-combined',
    symbol,
    portfolios,
    currentPrice: withPrice ? withPrice.currentPrice : null,
    currentPriceAsOf: withPrice ? withPrice.currentPriceAsOf : '',
    priceUnavailable: !withPrice,
    saleSummary: summarizeLots(mergedLots),
    saleLots: mergedLots,
    corporateActions: evaluations.flatMap((ev) => ev.corporateActions || []),
  };
}

async function evaluateSoldDate(saleDate) {
  if (!saleDate) {
    throw new Error('Sale date is required.');
  }

  const soldSymbols = await ordersRepository.listSoldSymbolsForDate(saleDate);
  if (!soldSymbols.length) {
    throw new Error(`No sell history found for ${saleDate}.`);
  }

  const rowsBySymbol = new Map();

  for (const item of soldSymbols) {
    const evaluation = await evaluateSoldSymbol(item.portfolio, item.symbol);
    const dateLots = evaluation.saleLots.filter((lot) => lot.saleDate === saleDate);
    if (!dateLots.length) continue;

    const existing = rowsBySymbol.get(item.symbol);
    if (!existing) {
      rowsBySymbol.set(item.symbol, {
        symbol: item.symbol,
        portfolios: [item.portfolio],
        currentPrice: evaluation.currentPrice,
        currentPriceAsOf: evaluation.currentPriceAsOf,
        saleLots: [...dateLots],
      });
      continue;
    }

    if (!existing.portfolios.includes(item.portfolio)) {
      existing.portfolios.push(item.portfolio);
    }

    existing.saleLots.push(...dateLots);
  }

  const rows = Array.from(rowsBySymbol.values())
    .map((row) => ({
      ...row,
      portfolioLabel: row.portfolios.join(', '),
      orderCount: row.saleLots.length,
      saleSummary: summarizeLots(row.saleLots),
    }))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));

  const overallLots = rows.flatMap((row) => row.saleLots);

  return {
    mode: 'date',
    saleDate,
    rows,
    saleSummary: summarizeLots(overallLots),
  };
}

module.exports = {
  listSellEvaluatorOptions,
  listSellEvaluatorDates,
  evaluateSoldSymbol,
  evaluateSoldSymbolCombined,
  evaluateSoldDate,
  buildFifoEvaluation,
  applyCorporateActions,
};
