// Veri katmanı: canlı çekim + önbellek + seed'e düşüş
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, CACHE_TTL_MS } from './config.js';
import { fetchFeed } from './rss.js';
import { getMarket, seedMarketFromJson } from './market.js';
import { getWeather, seedWeatherFromJson } from './weather.js';
import { enrichImages, fetchArticle } from './enrich.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.join(__dirname, '..', 'data', 'seed.json');

const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));

let newsCache = { at: 0, items: null, live: false, errors: [] };

function mergeItems(...lists) {
  const seen = new Set();
  const out = [];
  for (const it of lists.flat(2)) {
    if (!it || !it.link) continue;
    const key = String(it.link).replace(/[?#].*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  out.sort((a, b) => new Date(b.published) - new Date(a.published));
  return out;
}

export async function getNews({ force = false } = {}) {
  const now = Date.now();
  if (!force && newsCache.items && now - newsCache.at < CACHE_TTL_MS) {
    return { items: newsCache.items, live: newsCache.live, errors: newsCache.errors, fetchedAt: new Date(newsCache.at).toISOString() };
  }

  const jobs = [];
  for (const source of SOURCES) {
    for (const feed of source.feeds) {
      jobs.push(
        fetchFeed(feed, source)
          .then((items) => ({ ok: true, items }))
          .catch((e) => ({ ok: false, err: `${source.id}: ${e.message}`, items: [] }))
      );
    }
  }
  const results = await Promise.all(jobs);
  const errors = results.filter((r) => !r.ok).map((r) => r.err);
  const liveItems = mergeItems(...results.map((r) => r.items));

  let items;
  let live;
  if (liveItems.length >= 10) {
    items = mergeItems(liveItems, seed.articles); // canlı veri önde; seed yedek dolgu
    live = true;
  } else {
    items = seed.articles;
    live = false;
  }

  // Görseli olmayan haberler için hızlı çözüm (kalanlar /api/thumb ile tembel yüklenir)
  try {
    await enrichImages(items, 12, 6);
  } catch {
    /* sessiz: yer tutucu kullanılır */
  }

  newsCache = { at: now, items, live, errors };
  return { items, live, errors, fetchedAt: new Date(now).toISOString() };
}

export async function getArticleContent(id) {
  const { items } = await getNews();
  const item = items.find((i) => i.id === id) || seed.articles.find((i) => i.id === id);
  if (!item) return null;
  return { item, article: await fetchArticle(item) };
}

export function filterNews(items, { category, source, q, limit = 24, offset = 0 }) {
  let out = items;
  if (category && category !== 'all') out = out.filter((i) => i.category === category);
  if (source && source !== 'all') out = out.filter((i) => i.source === source);
  if (q) {
    const needle = q.toLocaleLowerCase('tr');
    out = out.filter(
      (i) =>
        i.title.toLocaleLowerCase('tr').includes(needle) ||
        (i.summary || '').toLocaleLowerCase('tr').includes(needle) ||
        i.source.includes(needle)
    );
  }
  const total = out.length;
  return { items: out.slice(offset, offset + limit), total };
}

export async function getMarketData() {
  return getMarket({ market: seedMarketFromJson(seed.market) });
}

export async function getWeatherData() {
  return getWeather({ weather: seedWeatherFromJson(seed.weather) });
}

export function getSeedMeta() {
  return { generatedAt: seed.generatedAt, note: seed.note };
}
