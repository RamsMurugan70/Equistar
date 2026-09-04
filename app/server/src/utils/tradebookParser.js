const path = require('path');

// A normal dependency of this package. It used to be required by absolute path out of the
// CLIENT's node_modules, which works on one developer's machine and nowhere else — the server
// is deployed without the client's dependency tree.
const xlsx = require('xlsx');
const PF = require('../config/portfolios');

function normalizeDate(value) {
  if (!value) return '';
  const stringValue = String(value).trim();
  if (!stringValue) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(stringValue)) return stringValue;
  if (stringValue.includes('T')) return stringValue.split('T')[0];
  return stringValue;
}

function normalizeSide(value) {
  return String(value || '').trim().toUpperCase().includes('SELL') ? 'SELL' : 'BUY';
}

function inferPortfolioFromTradebookName(fileName) {
  const normalized = fileName.toUpperCase();
  if (/TRADEBOOK-ZN5175-EQ/.test(normalized)) return PF.ICICI;
  if (/TRADEBOOK-WFF224-EQ/.test(normalized)) return PF.ZERODHA;
  return null;
}

function parseTradebookWorkbook(filePath) {
  const workbook = xlsx.readFile(filePath);
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(firstSheet, { header: 1, blankrows: false });

  const headerIndex = rows.findIndex((row) => Array.isArray(row)
    && row.some((cell) => String(cell || '').trim().toLowerCase() === 'symbol')
    && row.some((cell) => String(cell || '').trim().toLowerCase() === 'trade date')
    && row.some((cell) => String(cell || '').trim().toLowerCase() === 'trade type'));

  if (headerIndex === -1) {
    return [];
  }

  const headers = rows[headerIndex].map((cell) => String(cell || '').trim().toLowerCase());
  const columnIndex = {
    symbol: headers.indexOf('symbol'),
    date: headers.indexOf('trade date'),
    exchange: headers.indexOf('exchange'),
    segment: headers.indexOf('segment'),
    side: headers.indexOf('trade type'),
    quantity: headers.indexOf('quantity'),
    price: headers.indexOf('price'),
    tradeId: headers.indexOf('trade id'),
  };

  const orders = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!Array.isArray(row) || !row.length) continue;

    const segment = String(row[columnIndex.segment] || '').trim().toUpperCase();
    if (segment && segment !== 'EQ') continue;

    const symbol = String(row[columnIndex.symbol] || '').trim().toUpperCase();
    const tradeDate = normalizeDate(row[columnIndex.date]);
    const exchange = String(row[columnIndex.exchange] || 'NSE').trim().toUpperCase();
    const quantity = Number(row[columnIndex.quantity] || 0);
    const price = Number(row[columnIndex.price] || 0);

    if (!symbol || !tradeDate || !Number.isFinite(quantity) || !Number.isFinite(price) || quantity <= 0) {
      continue;
    }

    orders.push({
      symbol,
      tradeDate,
      exchange,
      side: normalizeSide(row[columnIndex.side]),
      quantity,
      price,
      tradeId: columnIndex.tradeId >= 0 ? String(row[columnIndex.tradeId] || '').trim() : '',
    });
  }

  return orders;
}

module.exports = {
  parseTradebookWorkbook,
  inferPortfolioFromTradebookName,
};
