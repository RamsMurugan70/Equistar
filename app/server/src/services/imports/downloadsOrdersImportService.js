const fs = require('fs/promises');
const path = require('path');
const config = require('../../config/env');
const importsService = require('./importsService');
const { parseTradebookWorkbook, inferPortfolioFromTradebookName } = require('../../utils/tradebookParser');

async function scanDownloadsAndImportOrders() {
  const entries = await fs.readdir(config.downloadsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /^tradebook-.*-eq.*\.xlsx$/i.test(entry.name))
    .map((entry) => path.join(config.downloadsDir, entry.name))
    .sort();

  const results = [];
  let importedFiles = 0;
  let insertedOrders = 0;
  let skippedOrders = 0;

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const portfolio = inferPortfolioFromTradebookName(fileName);
    if (!portfolio) {
      results.push({
        fileName,
        portfolio: null,
        status: 'skipped',
        reason: 'The tradebook filename does not map to a known portfolio.',
      });
      continue;
    }

    const orders = parseTradebookWorkbook(filePath);
    if (!orders.length) {
      results.push({
        fileName,
        portfolio,
        status: 'skipped',
        reason: 'No EQ orders could be parsed from the tradebook.',
      });
      continue;
    }

    const result = await importsService.importMissingOrders({
      portfolio,
      fileName,
      orders,
    });

    importedFiles += result.rowsInserted > 0 ? 1 : 0;
    insertedOrders += result.rowsInserted;
    skippedOrders += result.rowsSkipped;

    results.push({
      fileName,
      portfolio,
      status: result.rowsInserted > 0 ? 'imported' : 'skipped',
      reason: result.rowsInserted > 0 ? '' : 'All parsed orders from this file were already present.',
      rowsSeen: result.rowsSeen,
      rowsInserted: result.rowsInserted,
      rowsSkipped: result.rowsSkipped,
      tradeDates: result.tradeDates,
    });
  }

  return {
    scannedCount: files.length,
    importedCount: importedFiles,
    skippedCount: results.filter((item) => item.status !== 'imported').length,
    insertedOrders,
    skippedOrders,
    downloadsDir: config.downloadsDir,
    files: results,
  };
}

module.exports = {
  scanDownloadsAndImportOrders,
};
