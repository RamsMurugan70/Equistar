const { listOverrides, upsertOverride, bulkUpsertOverrides, deleteOverride } = require('../repositories/costBasisRepository');

async function getOverrides(req, res) {
  try {
    const { portfolio } = req.query;
    const rows = await listOverrides(portfolio || '');
    res.json({ overrides: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/portfolio/cost-basis/coverage
 *
 * Where the order history cannot support a cost basis, and why. Deliberately separate from the
 * overrides above, because the two answer opposite questions: an override is a cost the user
 * supplied, whereas this is the set of positions where nobody has supplied one and FIFO has
 * nothing to work with. Its own endpoint so any screen showing realised gains, cost basis or
 * capital gains can carry the warning without recomputing it.
 */
async function getCoverage(req, res) {
  try {
    const { assessCoverage } = require('../services/portfolio/costBasisCoverageService');
    const result = await assessCoverage({ portfolio: req.query.portfolio || null });
    // bySymbol is a Map and exists for in-process callers; JSON.stringify would silently emit
    // {} for it, which reads as "nothing found" rather than "not serialised".
    const { bySymbol, ...serialisable } = result;
    res.json(serialisable);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/portfolio/cost-basis
 * Body: { portfolio, overrides: [{ symbol, avgCost, qty, asOfDate, notes }] }
 * Or single: { portfolio, symbol, avgCost, qty, asOfDate, notes }
 */
async function importOverrides(req, res) {
  try {
    const { portfolio, overrides, symbol, avgCost, qty, asOfDate, notes } = req.body;

    if (!portfolio) {
      return res.status(400).json({ error: 'portfolio is required' });
    }

    // Single entry
    if (symbol && avgCost !== undefined) {
      await upsertOverride({
        portfolio,
        symbol,
        avgCost: Number(avgCost),
        qtyAtOverride: qty ? Number(qty) : null,
        asOfDate: asOfDate || null,
        source: 'manual',
        notes: notes || null,
      });
      return res.json({ upserted: 1 });
    }

    // Bulk from array
    if (!Array.isArray(overrides) || !overrides.length) {
      return res.status(400).json({ error: 'overrides array is required for bulk import' });
    }

    const normalized = overrides.map((o) => ({
      portfolio,
      symbol: String(o.symbol || o.SYMBOL || o.Stock || o.stock || '').trim().toUpperCase(),
      avgCost: Number(o.avgCost ?? o.avg_cost ?? o['Avg Cost'] ?? o['avg cost'] ?? o.AvgCost ?? 0),
      qtyAtOverride: o.qty || o.quantity || o.Qty || o.Quantity ? Number(o.qty ?? o.quantity ?? o.Qty ?? o.Quantity) : null,
      asOfDate: o.asOfDate || o.as_of_date || o.date || o.Date || null,
      source: 'csv-import',
      notes: o.notes || o.Notes || null,
    })).filter((o) => o.symbol && o.avgCost > 0);

    if (!normalized.length) {
      return res.status(400).json({ error: 'No valid overrides found. Each row needs symbol and avgCost > 0.' });
    }

    const result = await bulkUpsertOverrides(normalized);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function removeOverride(req, res) {
  try {
    const { portfolio, symbol } = req.params;
    await deleteOverride(portfolio, symbol);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { getOverrides, getCoverage, importOverrides, removeOverride };
