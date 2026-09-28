// Pusula Haber — Express sunucu
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, CATEGORIES } from './config.js';
import { getNews, filterNews, getMarketData, getWeatherData, getSeedMeta, getArticleContent } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.use(express.static(PUBLIC, { maxAge: '5m', etag: true }));

// ---- API ----

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'pusula-haber', time: new Date().toISOString() });
});

app.get('/api/sources', (_req, res) => {
  res.json({
    sources: SOURCES.map((s) => ({
      id: s.id, name: s.name, short: s.short, domain: s.domain, home: s.home, color: s.color,
      categories: [...new Set(s.feeds.map((f) => f.category))],
    })),
    categories: Object.values(CATEGORIES),
  });
});

app.get('/api/news', async (req, res) => {
  try {
    const { items, live, errors, fetchedAt } = await getNews({ force: req.query.refresh === '1' });
    const limit = Math.min(parseInt(req.query.limit ?? '24', 10) || 24, 100);
    const offset = parseInt(req.query.offset ?? '0', 10) || 0;
    const filtered = filterNews(items, {
      category: req.query.category,
      source: req.query.source,
      q: req.query.q,
      limit,
      offset,
    });
    res.json({ ...filtered, live, fetchedAt, errors: errors.slice(0, 5) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/news/:id', async (req, res) => {
  const { items } = await getNews();
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Haber bulunamadı' });
  res.json(item);
});

// Tam metin: haberi sitede okumak için
app.get('/api/news/:id/full', async (req, res) => {
  try {
    const result = await getArticleContent(req.params.id);
    if (!result) return res.status(404).json({ error: 'Haber bulunamadı' });
    res.json({
      item: result.item,
      article: result.article,
      live: true,
    });
  } catch (e) {
    // İçerik çekilemezse özetle devam edilir
    try {
      const { items } = await getNews();
      const item = items.find((i) => i.id === req.params.id);
      if (!item) return res.status(404).json({ error: 'Haber bulunamadı' });
      res.json({ item, article: null, live: false, error: e.message });
    } catch {
      res.status(500).json({ error: e.message });
    }
  }
});

app.get('/api/market', async (_req, res) => {
  try {
    res.json(await getMarketData());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/weather', async (_req, res) => {
  try {
    res.json(await getWeatherData());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/seed-meta', (_req, res) => res.json(getSeedMeta()));

// SPA giriş noktası
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Pusula Haber http://0.0.0.0:${PORT} üzerinde çalışıyor`);
  // Açılışta bir kez ön ısıtma (hatalar sessizce yutulur, seed'e düşülür)
  getNews().then((r) => console.log(`Haberler hazır: ${r.items.length} kayıt (canlı=${r.live})`)).catch(() => {});
});
