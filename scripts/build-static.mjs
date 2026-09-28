#!/usr/bin/env node
// TELGRAF statik site üretici — GitHub Actions her gece 00:00 (Türkiye) çalıştırır.
// Tüm veriyi (haberler + kapak görselleri + tam metinler + piyasa + hava) o an
// çekip dist/ altına koyar; site tamamen statik olarak GitHub Pages'ten yayınlanır.
import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNews, getMarketData, getWeatherData } from '../server/store.js';
import { enrichImages, fetchArticle, resolveGoogleBatch } from '../server/enrich.js';
import { SOURCES, CATEGORIES } from '../server/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;
  async function worker() {
    while (i < arr.length) {
      const idx = i++;
      out[idx] = await fn(arr[idx], idx).catch(() => null);
    }
  }
  return Promise.all(Array.from({ length: Math.min(limit, arr.length) }, worker)).then(() => out);
}

const fullName = (id) => `${encodeURIComponent(id)}.json`;

async function main() {
  const t0 = Date.now();
  console.log('▶ TELGRAF statik derleme başladı');

  /* ---------- 1) Topla (bellekte) ---------- */

  // Haberler (31 feed, canlı + seed karışımı)
  const news = await getNews({ force: true });
  const items = news.items;
  console.log(`  haber: ${items.length} (live=${news.live}, hata=${news.errors?.length || 0})`);

  // Google News linklerini TOPLU çöz (Reuters/AP vb. gerçek makale URL'sine)
  try {
    const resolved = await resolveGoogleBatch(items.map((i) => i.link).filter(Boolean));
    let n = 0;
    for (const it of items) {
      const real = resolved.get(it.link);
      if (real && real !== it.link && !real.includes('news.google.com')) {
        it.link = real;
        n++;
      }
    }
    console.log(`  google news çözümü: ${n} link gerçek makaleye yönlendirildi`);
  } catch (e) {
    console.log(`  google news çözümü başarısız: ${e.message}`);
  }

  // Eksik kapak görsellerini 5 katmanlı motorla tamamla (HEPSİ)
  try {
    await enrichImages(items, 5000, 6);
  } catch (e) {
    console.log(`  görsel zenginleştirme hatası: ${e.message}`);
  }
  const withImg = items.filter((i) => i.image).length;
  console.log(`  kapak görseli: ${withImg}/${items.length}`);

  // Tam metinler (modal'da sitede okuma) — paralel, habere özel dayanıklılık
  let fullOk = 0;
  const fullDocs = [];
  await mapLimit(items, 3, async (it) => {
    try {
      const article = await fetchArticle(it);
      if (article?.content) {
        fullDocs.push({ id: it.id, item: it, article });
        fullOk++;
      }
    } catch (e) {
      console.log(`  tam metin yok (${it.id}): ${String(e.message).slice(0, 80)}`);
    }
  });
  console.log(`  tam metin: ${fullOk}/${items.length}`);

  // Piyasa + hava (sunucu tarafında çekim — tarayıcı CORS sorunu yok)
  const [market, weather] = await Promise.all([
    getMarketData().catch((e) => ({ items: [], live: false, error: e.message })),
    getWeatherData().catch((e) => ({ live: false, error: e.message })),
  ]);
  console.log(`  piyasa: ${market.items?.length || 0} kalem (live=${market.live}) · hava (live=${weather.live})`);

  /* ---------- 2) dist/ ağacını kur (tek seferde) ---------- */

  await rm(DIST, { recursive: true, force: true });
  await mkdir(path.join(DIST, 'data', 'full'), { recursive: true });
  for (const dir of ['css', 'js', 'img']) {
    await cp(path.join(ROOT, 'public', dir), path.join(DIST, dir), { recursive: true });
  }
  await cp(path.join(ROOT, 'public', 'index.html'), path.join(DIST, 'index.html'));

  for (const doc of fullDocs) {
    await writeFile(path.join(DIST, 'data', 'full', fullName(doc.id)), JSON.stringify(doc));
  }
  await writeFile(path.join(DIST, 'data', 'news.json'), JSON.stringify({
    items, live: news.live, errors: news.errors || [], fetchedAt: new Date().toISOString(),
  }));
  await writeFile(path.join(DIST, 'data', 'market.json'), JSON.stringify(market));
  await writeFile(path.join(DIST, 'data', 'weather.json'), JSON.stringify(weather));
  await writeFile(path.join(DIST, 'data', 'sources.json'), JSON.stringify({
    sources: SOURCES.map((s) => ({
      id: s.id, name: s.name, short: s.short, domain: s.domain, home: s.home, color: s.color,
      categories: [...new Set(s.feeds.map((f) => f.category))],
    })),
    categories: Object.values(CATEGORIES),
  }));
  await writeFile(path.join(DIST, 'data', 'meta.json'), JSON.stringify({
    builtAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    news: items.length,
    withImage: withImg,
    fullTexts: fullOk,
    marketLive: !!market.live,
    weatherLive: !!weather.live,
  }, null, 2));

  console.log(`✔ dist/ hazır (${Math.round((Date.now() - t0) / 1000)} sn)`);
}

main().catch((e) => {
  console.error('✖ derleme hatası:', e);
  process.exit(1);
});
