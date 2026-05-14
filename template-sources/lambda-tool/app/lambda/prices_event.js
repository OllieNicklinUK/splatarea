// lambda/prices_event.js
// Fetches live currency exchange rates from Frankfurter (api.frankfurter.app).
// No API key required — data sourced from European Central Bank, updated daily.
//
// Expected context.data:
//   base     {string}   Base currency, e.g. "USD" (default: "USD")
//   symbols  {string[]} Target currencies, e.g. ["TWD","EUR","JPY","GBP"]
//
// Deploy via:
//   bash scripts/sync-lambda-config.sh --approve --verify --test

var input = context.data || {};
var base = String(input.base || 'USD').toUpperCase();
var symbols = Array.isArray(input.symbols) && input.symbols.length > 0
  ? input.symbols.map(function(s) { return String(s).toUpperCase(); })
  : ['TWD', 'EUR', 'JPY', 'GBP', 'HKD', 'SGD'];

console.log('[prices_event] fetching rates base:', base, 'symbols:', symbols.join(','));

var endpoint = 'https://api.frankfurter.app/latest?from=' + base + '&to=' + symbols.join(',');

var resp = fetch(endpoint, {
  method: 'GET',
  headers: { 'Accept': 'application/json' }
});

if (resp.status !== 200) {
  reply({ success: false, error: 'frankfurter fetch failed', status: resp.status });
} else {
  var body = resp.body || {};
  var rates = body.rates || {};
  var date = body.date || '';

  // Normalise into the same shape app.js expects: [{ symbol, price, change24h }]
  // Frankfurter does not provide 24h change — set to 0, UI will hide the change column
  var prices = symbols.map(function(sym) {
    return {
      symbol: sym,
      price: Number(rates[sym] || 0),
      change24h: 0
    };
  }).filter(function(p) { return p.price > 0; });

  console.log('[prices_event] returned', prices.length, 'rates, date:', date);
  reply({
    success: true,
    prices: prices,
    currency: base,
    date: date,
    base: base
  });
}
