// Piyasa verileri: BIST 100, USD/TRY, EUR/TRY, gram altın, Brent, Bitcoin
// Birincil kaynak: Yahoo Finance chart API (anahtarsız). Ağ kapalıysa seed'e düşer.
import { MARKET_TTL_MS, USER_AGENT } from './config.js';
import { fetchText } from './rss.js';

const SYMBOLS = [
  { symbol: 'XU100.IS', key: 'bist100', name: 'BIST 100', currency: 'TRY', decimals: 2 },
  { symbol: 'TRY=X', key: 'usdtry', name: 'Dolar/TL', currency: 'TRY', decimals: 4 },
  { symbol: 'EURTRY=X', key: 'eurtry', name: 'Euro/TL', currency: 'TRY', decimals: 4 },
  { symbol: 'GC=F', key: 'gold', name: 'Ons Altın', currency: 'USD', decimals: 2 },
  { symbol: 'BZ=F', key: 'brent', name: 'Brent Petrol', currency: 'USD', decimals: 2 },
  { symbol: 'BTC-USD', key: 'btc', name: 'Bitcoin', currency: 'USD', decimals: 0 },
];

let cache = { at: 0, data: null };

async function fetchQuote(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
  const txt = await fetchText(url, 10000);
  const json = JSON.parse(txt);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`no quote for ${sym}`);
  const meta = result.meta;
  const price = meta.regularMarketPrice ?? meta.previousClose ?? meta.chartPreviousClose;
  const prev = meta.chartPreviousClose ?? meta.previousClose ?? price;
  const change = price - prev;
  const changePercent = prev ? (change / prev) * 100 : 0;
  // 5 günlük kapanış serisi (sparkline için)
  const closes = (result.indicators?.quote?.[0]?.close || []).filter((v) => v != null);
  return {
    price,
    change,
    changePercent,
    spark: closes.slice(-24),
    marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
  };
}

export async function getMarket(seedFallback) {
  const now = Date.now();
  if (cache.data && now - cache.at < MARKET_TTL_MS) return cache.data;

  const items = [];
  let live = true;
  try {
    const quotes = await Promise.allSettled(SYMBOLS.map((s) => fetchQuote(s.symbol)));
    let anyOk = false;
    quotes.forEach((q, i) => {
      const cfg = SYMBOLS[i];
      if (q.status === 'fulfilled') {
        anyOk = true;
        items.push({ key: cfg.key, name: cfg.name, currency: cfg.currency, decimals: cfg.decimals, ...q.value });
      }
    });
    if (!anyOk) throw new Error('no quotes');
    // Gram altın hesabı (TL): ons * usdtry / 31.1035
    const gold = items.find((i) => i.key === 'gold');
    const usd = items.find((i) => i.key === 'usdtry');
    if (gold && usd) {
      const gram = (gold.price * usd.price) / 31.1035;
      const gramPrev = (gold.price - gold.change) * (usd.price - usd.change) / 31.1035;
      items.push({
        key: 'gramgold',
        name: 'Gram Altın',
        currency: 'TRY',
        decimals: 2,
        price: gram,
        change: gram - gramPrev,
        changePercent: gramPrev ? ((gram - gramPrev) / gramPrev) * 100 : 0,
        spark: [],
      });
    }
  } catch {
    live = false;
    items.push(...seedFallback.market);
  }

  cache = {
    at: now,
    data: { items, live, fetchedAt: new Date(now).toISOString(), ttl: MARKET_TTL_MS },
  };
  return cache.data;
}

export function seedMarketFromJson(market) {
  return market.map((m) => ({
    key: m.key,
    name: m.name,
    currency: m.currency ?? 'TRY',
    decimals: m.decimals ?? 2,
    price: m.price,
    change: m.change,
    changePercent: m.changePercent,
    spark: m.spark ?? [],
  }));
}
