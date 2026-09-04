import { read, utils } from 'xlsx';

function splitCSV(str, separator) {
  const parts = [];
  let current = '';
  let inQuote = false;

  for (let index = 0; index < str.length; index += 1) {
    const char = str[index];
    if (char === '"') {
      inQuote = !inQuote;
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

export async function fileToText(file) {
  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) {
    const buffer = await file.arrayBuffer();
    const workbook = read(buffer, { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    return utils.sheet_to_csv(worksheet);
  }

  return file.text();
}

export function parsePortfolioCSV(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];

  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const cleanCell = (value) => value?.replace(/^"|"$/g, '').trim() || '';
  const headers = splitCSV(lines[0], delimiter).map((header) => cleanCell(header).toLowerCase());
  const isNewFormat = ['symbol', 'isin', 'sector', 'quantity available'].every((header) => headers.includes(header));
  // ICICI Direct demat: Stock Name | Stock (ticker) | ISIN | Allocated Qty | ...
  // Identified by having both 'stock name' AND 'stock' AND 'isin' as separate columns
  const isIciciDematFormat = ['stock name', 'stock', 'isin', 'allocated quantity', 'current market price', 'market value'].every((header) => headers.includes(header));
  // Zerodha demat: Stock Name (IS the ticker) | ISIN | Allocated Qty | ...
  const isDematFormat = !isIciciDematFormat && ['stock name', 'allocated quantity', 'current market price', 'market value'].every((header) => headers.includes(header));
  const hasHeader = headers.includes('instrument') || headers.includes('symbol') || headers.includes('stock name');
  const startIndex = hasHeader ? 1 : 0;

  const toNumber = (value) => {
    const parsed = Number.parseFloat(String(value || '').replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const holdings = [];

  for (let index = startIndex; index < lines.length; index += 1) {
    const columns = splitCSV(lines[index], delimiter).map(cleanCell);
    if (columns.length < 2) continue;

    let item;
    if (isIciciDematFormat) {
      // ICICI Direct Demat. Header-driven (column ORDER changes between exports — ICICI
      // added pledge columns), falling back to the legacy fixed positions.
      //
      // Quantity: the same shares can be reported under more than one column, so summing
      // double-counts. Observed layouts:
      //   • older export : Allocated Quantity 13667 + Block For Margin 13667  (SAME shares)
      //   • newer export : Allocated Quantity 0, "Pledge for SAM" 13667       (pledged out)
      // max(allocated, blockedTrade + blockMargin + pledgedForSAM) handles both: it never
      // double-counts, and it rescues fully-pledged rows that would otherwise total 0 and
      // be dropped from the portfolio entirely.
      const at = (name, fallbackIdx) => {
        const i = headers.findIndex((h) => h === name);
        return toNumber(columns[i >= 0 ? i : fallbackIdx]);
      };
      // "Pledge for SAM" only — NOT "Pledge requested Quantity" / "Pledge withdrawal quantity",
      // which are in-flight requests, not held shares.
      const pledgeIdx = headers.findIndex((h) =>
        h.includes('pledge') && !h.includes('request') && !h.includes('withdraw'));
      const pledgedForSAM = pledgeIdx >= 0 ? toNumber(columns[pledgeIdx]) : 0;

      const allocatedQty     = at('allocated quantity', 3);
      const blockedForTrade  = at('blocked for trade', 4);
      const blockedForMargin = at('block for margin', 5);
      const totalQty = Math.max(allocatedQty, blockedForTrade + blockedForMargin + pledgedForSAM);

      const ltpIdx = headers.findIndex((h) => h === 'current market price');
      const ltp    = toNumber(columns[ltpIdx >= 0 ? ltpIdx : 6]);
      const chgIdx = headers.findIndex((h) => h === '% change');
      item = {
        instrument: columns[1],          // columns[1] = short stock code e.g. "ANARAT"
        isin:       columns[2] || '',
        qty:        totalQty,
        avgCost:    0,
        ltp,
        invested:   0,
        // NOTE: ICICI reports Market Value as 0.00 for pledged rows, so always derive it.
        curVal:     totalQty * ltp,
        pnl:        0,
        netChg:     0,
        pledgedQty: pledgedForSAM,
        dayChg:     toNumber(columns[chgIdx >= 0 ? chgIdx : 7]),
      };
    } else if (isDematFormat) {
      // Zerodha Demat Holdings: Stock Name (ticker) | ISIN | Allocated Qty | Blocked Trade | Block Margin | CMP | % Change | Market Value
      const allocatedQty   = toNumber(columns[3]);
      const blockedForTrade  = toNumber(columns[4]);
      const blockedForMargin = toNumber(columns[5]);
      const totalQty = allocatedQty + blockedForTrade + blockedForMargin;
      const ltp = toNumber(columns[6]);
      item = {
        instrument: columns[0],
        qty:        totalQty,
        avgCost:    0,
        ltp,
        invested:   0,
        curVal:     totalQty * ltp,
        pnl:        0,
        netChg:     0,
        dayChg:     toNumber(columns[7]),
      };
    } else if (isNewFormat) {
      const qty = toNumber(columns[3]);
      const avgCost = toNumber(columns[8]);
      const ltp = toNumber(columns[9]);
      item = {
        instrument: columns[0],
        qty,
        avgCost,
        ltp,
        invested: qty * avgCost,
        curVal: qty * ltp,
        pnl: toNumber(columns[10]),
        netChg: 0,
        dayChg: 0,
      };
    } else {
      item = {
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
    }

    const instrument = item.instrument?.toLowerCase() || '';
    const blacklist = ['instrument', 'symbol', 'summary', 'invested value', 'present value', 'unrealized p&l', 'client id', 'equity holdings', 'stock name'];
    if (!item.instrument || blacklist.some((term) => instrument.includes(term))) {
      continue;
    }

    holdings.push(item);
  }

  return holdings;
}

export function parseZerodhaOrders(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const ordersByDate = {};
  const headerLineIndex = lines.findIndex((line) => {
    const normalized = line.toLowerCase();
    return normalized.includes('symbol')
      && normalized.includes('trade date')
      && normalized.includes('trade type')
      && normalized.includes('quantity')
      && normalized.includes('price');
  });

  const firstLine = headerLineIndex >= 0 ? lines[headerLineIndex] : (lines[0] || '');
  const delimiter = firstLine.includes('\t') ? '\t' : ',';

  const headers = splitCSV(firstLine, delimiter).map((header) => header.trim().toLowerCase().replace(/['"]/g, ''));
  const columns = {
    symbol: headers.findIndex((header) => header.includes('symbol') || header === 'scrip'),
    date: headers.findIndex((header) => header === 'trade_date' || header === 'order_date' || header.includes('date')),
    quantity: headers.findIndex((header) => header.includes('quantity') || header.includes('qty')),
    price: headers.findIndex((header) => header === 'price' || header === 'rate' || header.includes('avg.')),
    side: headers.findIndex((header) => header.includes('type') || header.includes('side') || header === 'buy/sell'),
    exchange: headers.findIndex((header) => header.includes('exchange')),
  };

  const normalizeDate = (dateValue) => {
    if (!dateValue) return '';
    if (dateValue.includes('T')) return dateValue.split('T')[0];
    const dmyMatch = dateValue.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (dmyMatch) {
      const [, dd, mm, yyyy] = dmyMatch;
      return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }
    return dateValue;
  };

  if (columns.symbol === -1 || columns.quantity === -1 || columns.price === -1) {
    return ordersByDate;
  }

  const dataStartIndex = headerLineIndex >= 0 ? headerLineIndex + 1 : 1;

  for (let index = dataStartIndex; index < lines.length; index += 1) {
    const cells = splitCSV(lines[index], delimiter);
    const symbol = cells[columns.symbol];
    if (!symbol) continue;

    const quantity = Number.parseFloat(String(cells[columns.quantity] || '').replace(/,/g, ''));
    const price = Number.parseFloat(String(cells[columns.price] || '').replace(/,/g, ''));
    if (!Number.isFinite(quantity) || !Number.isFinite(price)) continue;

    const date = normalizeDate(cells[columns.date] || '');
    if (!date) continue;
    const sideCell = String(cells[columns.side] || 'BUY').toUpperCase();
    const side = sideCell.includes('SELL') ? 'SELL' : 'BUY';
    const exchange = cells[columns.exchange] || 'NSE';

    if (!ordersByDate[date]) ordersByDate[date] = [];
    ordersByDate[date].push({
      symbol,
      side,
      exchange,
      quantity,
      price,
    });
  }

  return ordersByDate;
}
