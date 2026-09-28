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

async function fetchJson(url, timeoutMs = 8000) {
  const txt = await fetchText(url, timeoutMs);
  return JSON.parse(txt);
}

async function fetchQuote(sym) {
  // Yahoo iki uç nokta dener (biri bazen engellenir)
  let json = null;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      json = await fetchJson(`https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`, 10000);
      if (json?.chart?.result?.[0]) break;
    } catch { /* sonraki uç nokta */ }
  }
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

/* Anahtarsız yedek sağlayıcılar (Yahoo engelliyse) */
const frankfurter = async (base) => {
  for (const host of ['api.frankfurter.dev', 'api.frankfurter.app']) {
    try {
      const j = await fetchJson(`https://${host}/v1/latest?base=${base}&symbols=TRY`);
      const r = j?.rates?.TRY;
      if (r) return { price: r, change: 0, changePercent: 0, spark: [] };
    } catch { /* sonraki */ }
  }
  throw new Error('frankfurter yok');
};

const FALLBACKS = {
  usdtry: () => frankfurter('USD'),
  eurtry: () => frankfurter('EUR'),
  gold: async () => {
    const j = await fetchJson('https://api.gold-api.com/price/XAU');
    if (!j?.price) throw new Error('gold-api yok');
    return { price: j.price, change: 0, changePercent: 0, spark: [] };
  },
  btc: async () => {
    const j = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true');
    const b = j?.bitcoin;
    if (!b?.usd) throw new Error('coingecko yok');
    const pct = b.usd_24h_change || 0;
    return { price: b.usd, change: (b.usd * pct) / 100, changePercent: pct, spark: [] };
  },
  bist100: () => stooqQuote(['^xu100', 'xu100', 'xu100.try']),
  brent: () => stooqQuote(['brn.f', 'brn']),
};

async function stooqQuote(symbols) {
  for (const s of symbols) {
    try {
      const txt = await fetchText(`https://stooq.com/q/l/?s=${encodeURIComponent(s)}&f=sd2t2ohlcv&h&e=csv`, 8000);
      const line = txt.trim().split('\n')[1] || '';
      const cols = line.split(',');
      const price = Number(cols[6]);
      const open = Number(cols[3]);
      if (price > 0) {
        const change = open > 0 ? price - open : 0;
        return {
          price,
          change,
          changePercent: open > 0 ? (change / open) * 100 : 0,
          spark: [],
          marketTime: `${cols[1] || ''}T${cols[2] || ''}Z`.includes('T') ? `${cols[1]}T${cols[2] || '00:00:00'}Z` : null,
        };
      }
    } catch { /* sonraki sembol */ }
  }
  throw new Error('stooq yok');
}

export async function getMarket(seedFallback) {
  const now = Date.now();
  if (cache.data && now - cache.at < MARKET_TTL_MS) return cache.data;

  const items = [];
  let realCount = 0;
  try {
    const quotes = await Promise.allSettled(SYMBOLS.map((s) => fetchQuote(s.symbol)));
    quotes.forEach((q, i) => {
      const cfg = SYMBOLS[i];
      if (q.status === 'fulfilled') {
        realCount++;
        items.push({ key: cfg.key, name: cfg.name, currency: cfg.currency, decimals: cfg.decimals, ...q.value });
      }
    });

    // Yahoo'da eksik kalanlar için anahtarsız yedek sağlayıcılar
    const missing = SYMBOLS.filter((s) => !items.some((i) => i.key === s.key));
    await Promise.all(missing.map(async (cfg) => {
      const fb = FALLBACKS[cfg.key];
      if (!fb) return;
      try {
        const q = await fb();
        realCount++;
        items.push({ key: cfg.key, name: cfg.name, currency: cfg.currency, decimals: cfg.decimals, ...q });
      } catch { /* seed'e düşer */ }
    }));

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

    // Hâlâ eksik semboller: seed değeriyle tamamla (bayrak 'Örnek veri')
    const have = new Set(items.map((i) => i.key));
    for (const s of seedFallback.market) {
      if (!have.has(s.key)) items.push({ ...s, sample: true });
    }
    // Sıralama: SYMBOLS sırası + gram altın
    const order = [...SYMBOLS.map((s) => s.key), 'gramgold'];
    items.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  } catch {
    items.length = 0;
    items.push(...seedFallback.market.map((s) => ({ ...s, sample: true })));
  }

  const live = realCount >= 4;
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
