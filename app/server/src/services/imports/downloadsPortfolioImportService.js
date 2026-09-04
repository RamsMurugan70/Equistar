const fs = require('fs/promises');
const path = require('path');
const config = require('../../config/env');
const importsService = require('./importsService');
const portfolioRepository = require('../../repositories/portfolioRepository');
const scoringService = require('../scoring/scoringService');
const { loadPortfolioFile, extractSnapshotDateFromFileName } = require('../../utils/portfolioImportParser');

function parseSnapshotPayload(snapshot) {
  try {
    return {
      ...snapshot,
      payload: JSON.parse(snapshot.payload_json),
    };
  } catch (_error) {
    return {
      ...snapshot,
      payload: null,
    };
  }
}

function pickLatestSnapshotsByPortfolio(snapshots) {
  const latestByPortfolio = new Map();

  for (const snapshot of snapshots) {
    if (!latestByPortfolio.has(snapshot.portfolio)) {
      latestByPortfolio.set(snapshot.portfolio, snapshot);
    }
  }

  return [...latestByPortfolio.values()];
}

function buildPortfolioHistory(snapshots) {
  const history = new Map();

  for (const snapshot of pickLatestSnapshotsByPortfolio(snapshots)) {
    const portfolio = snapshot.portfolio;
    const entry = history.get(portfolio) || {
      symbolCounts: new Map(),
      totalSnapshots: 0,
    };

    const holdings = snapshot.payload?.portfolio || [];
    const symbolsSeen = new Set();
    for (const holding of holdings) {
      const symbol = String(holding.instrument || '').trim().toUpperCase();
      if (!symbol || symbolsSeen.has(symbol)) continue;
      symbolsSeen.add(symbol);
      entry.symbolCounts.set(symbol, (entry.symbolCounts.get(symbol) || 0) + 1);
    }

    entry.totalSnapshots += 1;
    history.set(portfolio, entry);
  }

  return history;
}

function inferPortfolio(holdings, history) {
  const fileSymbols = [...new Set(
    holdings
      .map((holding) => String(holding.instrument || '').trim().toUpperCase())
      .filter(Boolean)
  )];

  if (!fileSymbols.length) {
    return {
      portfolio: null,
      confidence: 0,
      matchedSymbols: 0,
      totalSymbols: 0,
      candidates: [],
      reason: 'No portfolio symbols were found in the file.',
    };
  }

  const candidates = [...history.entries()].map(([portfolio, entry]) => {
    let matchedSymbols = 0;
    let weightedMatches = 0;

    for (const symbol of fileSymbols) {
      const count = entry.symbolCounts.get(symbol) || 0;
      if (count > 0) {
        matchedSymbols += 1;
        weightedMatches += count;
      }
    }

    return {
      portfolio,
      matchedSymbols,
      totalSymbols: fileSymbols.length,
      coverage: matchedSymbols / fileSymbols.length,
      weightedMatches,
    };
  }).sort((left, right) => {
    if (right.coverage !== left.coverage) return right.coverage - left.coverage;
    if (right.matchedSymbols !== left.matchedSymbols) return right.matchedSymbols - left.matchedSymbols;
    return right.weightedMatches - left.weightedMatches;
  });

  const best = candidates[0];
  const second = candidates[1];
  if (!best || best.matchedSymbols === 0) {
    return {
      portfolio: null,
      confidence: 0,
      matchedSymbols: 0,
      totalSymbols: fileSymbols.length,
      candidates,
      reason: 'No strong symbol overlap was found with the portfolio history in the app.',
    };
  }

  const bestConfidence = Number(best.coverage.toFixed(2));
  const secondConfidence = second ? Number(second.coverage.toFixed(2)) : 0;
  const matchGap = best.matchedSymbols - (second?.matchedSymbols || 0);

  if (bestConfidence < 0.5 && best.matchedSymbols < 3) {
    return {
      portfolio: null,
      confidence: bestConfidence,
      matchedSymbols: best.matchedSymbols,
      totalSymbols: fileSymbols.length,
      candidates,
      reason: 'The file does not match enough known holdings to infer a portfolio safely.',
    };
  }

  if (second && (bestConfidence - secondConfidence) < 0.2 && matchGap < 2) {
    return {
      portfolio: null,
      confidence: bestConfidence,
      matchedSymbols: best.matchedSymbols,
      totalSymbols: fileSymbols.length,
      candidates,
      reason: `The file looks too close to both ${best.portfolio} and ${second.portfolio} to classify safely.`,
    };
  }

  return {
    portfolio: best.portfolio,
    confidence: bestConfidence,
    matchedSymbols: best.matchedSymbols,
    totalSymbols: fileSymbols.length,
    candidates,
    reason: '',
  };
}

async function scanDownloadsAndImportPortfolios() {
  const entries = await fs.readdir(config.downloadsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /^holdings - .*\.csv$/i.test(entry.name))
    .map((entry) => path.join(config.downloadsDir, entry.name))
    .sort();

  if (!files.length) {
    return {
      scannedCount: 0,
      importedCount: 0,
      skippedCount: 0,
      refreshedScores: false,
      downloadsDir: config.downloadsDir,
      files: [],
    };
  }

  const snapshots = (await portfolioRepository.listPortfolioSnapshotPayloads(250)).map(parseSnapshotPayload);
  const history = buildPortfolioHistory(snapshots);
  const results = [];
  let importedCount = 0;

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const snapshotDate = extractSnapshotDateFromFileName(fileName);

    if (!snapshotDate) {
      results.push({
        fileName,
        snapshotDate: null,
        portfolio: null,
        status: 'skipped',
        reason: 'The file name does not contain a usable snapshot date.',
      });
      continue;
    }

    const holdings = await loadPortfolioFile(filePath);
    if (!holdings.length) {
      results.push({
        fileName,
        snapshotDate,
        portfolio: null,
        status: 'skipped',
        reason: 'No holdings could be parsed from the file.',
      });
      continue;
    }

    const match = inferPortfolio(holdings, history);
    if (!match.portfolio) {
      results.push({
        fileName,
        snapshotDate,
        portfolio: null,
        status: 'skipped',
        reason: match.reason,
        matchedSymbols: match.matchedSymbols,
        totalSymbols: match.totalSymbols,
        confidence: match.confidence,
      });
      continue;
    }

    const existingSnapshot = await portfolioRepository.getPortfolioSnapshot(match.portfolio, snapshotDate);
    if (existingSnapshot) {
      results.push({
        fileName,
        snapshotDate,
        portfolio: match.portfolio,
        status: 'skipped',
        reason: `${match.portfolio} already has a snapshot for ${snapshotDate}.`,
        matchedSymbols: match.matchedSymbols,
        totalSymbols: match.totalSymbols,
        confidence: match.confidence,
      });
      continue;
    }

    await importsService.importPortfolioSnapshot({
      portfolio: match.portfolio,
      snapshotDate,
      fileName,
      holdings,
    });

    importedCount += 1;
    results.push({
      fileName,
      snapshotDate,
      portfolio: match.portfolio,
      status: 'imported',
      reason: '',
      matchedSymbols: match.matchedSymbols,
      totalSymbols: match.totalSymbols,
      confidence: match.confidence,
      rowsInserted: holdings.length,
    });
  }

  if (importedCount > 0) {
    await scoringService.refreshCurrentScores();
  }

  return {
    scannedCount: files.length,
    importedCount,
    skippedCount: results.filter((item) => item.status !== 'imported').length,
    refreshedScores: importedCount > 0,
    downloadsDir: config.downloadsDir,
    files: results,
  };
}

module.exports = {
  scanDownloadsAndImportPortfolios,
};
