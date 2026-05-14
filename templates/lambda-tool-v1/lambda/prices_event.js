// lambda/prices_event.js
// Fetches crypto/stock prices from an external API using a secret API key.
// Required Lambda env keys:
//   PRICES_API_KEY   — your data provider API key
//   PRICES_API_URL   — (optional) override endpoint URL
//
// Deploy this script via:
//   bash scripts/sync-lambda-config.sh --approve --verify --test

var apiKey = getEnv('PRICES_API_KEY');
var endpoint = getEnv('PRICES_API_URL') || 'https://api.example-prices.com/v1/quotes';

if (!apiKey) {
  reply({ success: false, error: 'missing PRICES_API_KEY' });
} else {
  var input = context.data || {};
  var symbols = input.symbols;
  var currency = String(input.currency || 'USD').toUpperCase();

  if (!Array.isArray(symbols) || symbols.length === 0) {
    reply({ success: false, error: 'missing symbols array' });
  } else {
    console.log('[prices_event] fetching symbols:', symbols.join(','), 'currency:', currency);

    var resp = fetch(endpoint + '?symbols=' + symbols.join(',') + '&currency=' + currency, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Accept': 'application/json'
      }
    });

    if (resp.status !== 200) {
      reply({
        success: false,
        error: 'prices fetch failed',
        status: resp.status
      });
    } else {
      var body = resp.body || {};
      var rawPrices = Array.isArray(body.data) ? body.data : (Array.isArray(body) ? body : []);

      // Sanitize — never return raw upstream response
      var prices = rawPrices.map(function (p) {
        return {
          symbol: String(p.symbol || p.id || '').toUpperCase(),
          price: Number(p.price || p.last || p.close || 0),
          change24h: Number(p.change_24h || p.percent_change_24h || p.changePercent || 0)
        };
      });

      console.log('[prices_event] returned', prices.length, 'prices');
      reply({ success: true, prices: prices, currency: currency });
    }
  }
}
