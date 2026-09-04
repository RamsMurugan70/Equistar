// A row is F&O if it's on an F&O exchange, or its symbol is a real option/future
// contract. Real contracts carry a strike/expiry DIGIT and end in CE/PE/FUT —
// requiring the digit excludes equities like RELIANCE, BAJFINANCE, FINPIPE
// (which merely end in "CE"/"PE") and ETFs like NIFTYBEES.
function isFno(row) {
  const ex = String(row.exchange || '').toUpperCase();
  if (ex === 'NFO' || ex === 'BFO' || ex === 'MCX') return true;
  const s = String(row.symbol || '').toUpperCase().replace(/\s+/g, '');
  return /\d/.test(s) && /(CE|PE|FUT)$/.test(s);
}

module.exports = { isFno };
