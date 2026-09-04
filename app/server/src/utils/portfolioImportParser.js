const fs = require('fs/promises');
const path = require('path');

function splitCSV(str, separator) {
  const parts = [];
  let current = '';
  let inQuote = false;

  for (let index = 0; index < str.length; index += 1) {
    const char = str[index];

    if (char === '"') {
      const nextChar = str[index + 1];
      if (inQuote && nextChar === '"') {
        current += '"';
        index += 1;
      } else {
        inQuote = !inQuote;
      }
    } else if (char === separator && !inQuote) {
      parts.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += char;
    }
  }

  parts.push(current.trim().replace(/^"|"$/g, ''));
  return parts;
}

function parsePortfolioCSV(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];

  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const cleanCell = (value) => value?.replace(/^"|"$/g, '').trim() || '';
  const headers = splitCSV(lines[0], delimiter).map((header) => cleanCell(header).toLowerCase());
  const hasHeader = headers.includes('instrument') || headers.includes('symbol');
  const startIndex = hasHeader ? 1 : 0;

  const toNumber = (value) => {
    const parsed = Number.parseFloat(String(value || '').replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const holdings = [];

  for (let index = startIndex; index < lines.length; index += 1) {
    const columns = splitCSV(lines[index], delimiter).map(cleanCell);
    if (columns.length < 2) continue;

    const item = {
      instrument: columns[0],
      qty: toNumber(columns[1]),
      avgCost: toNumber(columns[2]),
      ltp: toNumber(columns[3]),
      invested: toNumber(columns[4]),
      curVal: toNumber(columns[5]),
      pnl: toNumber(columns[6]),
      netChg: toNumber(columns[7]),
      dayChg: toNumber(columns[8]),
    };

    const instrument = item.instrument?.toLowerCase() || '';
    const blacklist = ['instrument', 'symbol', 'summary', 'invested value', 'present value', 'unrealized p&l', 'client id', 'equity holdings'];
    if (!item.instrument || blacklist.some((term) => instrument.includes(term))) {
      continue;
    }

    holdings.push(item);
  }

  return holdings;
}

async function loadPortfolioFile(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  return parsePortfolioCSV(text);
}

function extractSnapshotDateFromFileName(fileName) {
  const baseName = path.basename(fileName);
  const match = baseName.match(/(\d{4}-\d{2}-\d{2})T\d{6}\.\d+/);
  return match ? match[1] : null;
}

module.exports = {
  parsePortfolioCSV,
  loadPortfolioFile,
  extractSnapshotDateFromFileName,
};
