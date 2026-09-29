#!/usr/bin/env node
// TELGRAF statik site üretici — GitHub Actions her gece 00:00 (Türkiye) çalıştırır.
// Tüm veriyi (haberler + kapak görselleri + tam metinler + piyasa + hava) o an
// çekip dist/ altına koyar; site tamamen statik olarak GitHub Pages'ten yayınlanır.
import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNews, getMarketData, getWeatherData } from '../server/store.js';
import { enrichImages, fetchArticle, resolveGoogleBatch, isArticleUrl, isExpectedPublisherUrl, isScreenshotServiceUrl } from '../server/enrich.js';
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

async function auditImageUrls(items) {
  const urls = [...new Set(items.map((item) => item.image).filter((url) => /^https?:\/\//i.test(url || '')))];
  const screenshot = urls.filter(isScreenshotServiceUrl).length;
  const directUrls = urls.filter((url) => !isScreenshotServiceUrl(url));
  let verified = 0;
  let httpFailures = 0;
  let nonImageResponses = 0;
  let requestFailures = 0;
  await mapLimit(directUrls, 8, async (url) => {
    let response;
    try {
      response = await fetch(url, {
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(4000),
      });
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok) httpFailures++;
      else if (/^image\//i.test(contentType)) verified++;
      else nonImageResponses++;
    } catch {
      requestFailures++;
    } finally {
      try { await response?.body?.cancel(); } catch { /* gövde zaten kapanmış olabilir */ }
    }
  });
  return {
    total: urls.length,
    direct: directUrls.length,
    screenshot,
    verified,
    httpFailures,
    nonImageResponses,
    requestFailures,
  };
}

const fullName = (id) => `${encodeURIComponent(id)}.json`;

function isStoryLink(link) {
  try {
    const u = new URL(link);
    if (u.hostname === 'news.google.com' && /\/(?:rss\/)?articles\/[A-Za-z0-9_-]{10,}/.test(u.pathname)) return true;
    return isArticleUrl(link);
  } catch { return false; }
}

function note(msg) {
  console.log(msg);
  // GitHub Actions annotation'ı — log erişimi olmasa da API'den okunur
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::notice title=TELGRAF derleme::${String(msg).replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);
  }
}

async function main() {
  const t0 = Date.now();
  console.log('▶ TELGRAF statik derleme başladı');

  /* ---------- 1) Topla (bellekte) ---------- */

  // Haberler (31 feed, canlı + seed karışımı)
  const news = await getNews({ force: true });
  const items = news.items;
  note(`haber: ${items.length} (live=${news.live}, hata=${news.errors?.length || 0})`);

  // Google News linklerini TOPLU çöz (Reuters/AP vb. gerçek makale URL'sine)
  try {
    const resolved = await resolveGoogleBatch(items.map((i) => i.link).filter(Boolean));
    let n = 0;
    for (const it of items) {
      const real = resolved.get(it.link);
      if (real && real !== it.link && isArticleUrl(real) && isExpectedPublisherUrl(it.source, real)) {
        it.link = real;
        n++;
      }
    }
    console.log(`  google news çözümü: ${n} link gerçek makaleye yönlendirildi`);
  } catch (e) {
    console.log(`  google news çözümü başarısız: ${e.message}`);
  }

  // Google CSS/asset gibi kazara çözülen veya bozuk RSS linklerini yayına sokma.
  const badLinks = items.filter((it) => !isStoryLink(it.link));
  if (badLinks.length) {
    const badIds = new Set(badLinks.map((it) => it.id));
    for (let i = items.length - 1; i >= 0; i--) if (badIds.has(items[i].id)) items.splice(i, 1);
  }
  note(`makale bağlantıları: ${items.length} geçerli, ${badLinks.length} hatalı kayıt ayıklandı`);

  // Eksik kapak görsellerini challenge-duyarlı görsel motoruyla tamamla (HEPSİ)
  try {
    await enrichImages(items, 5000, 6);
  } catch (e) {
    console.log(`  görsel zenginleştirme hatası: ${e.message}`);
  }
  const withImg = items.filter((i) => i.image).length;
  note(`kapak görseli: ${withImg}/${items.length}`);
  const imageAudit = await auditImageUrls(items);
  note(`görsel denetimi (benzersiz URL; kart=${withImg}/${items.length}): toplam=${imageAudit.total}, doğrudan=${imageAudit.direct}, screenshot-proxy=${imageAudit.screenshot}, doğrulanan=${imageAudit.verified}, HTTP-hatası=${imageAudit.httpFailures}, görsel-olmayan=${imageAudit.nonImageResponses}, istek-hatası=${imageAudit.requestFailures}`);

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
  note(`tam metin: ${fullOk}/${items.length}`);

  // Piyasa + hava (sunucu tarafında çekim — tarayıcı CORS sorunu yok)
  const [market, weather] = await Promise.all([
    getMarketData().catch((e) => ({ items: [], live: false, error: e.message })),
    getWeatherData().catch((e) => ({ live: false, error: e.message })),
  ]);
  const marketSamples = (market.items || []).filter((m) => m.sample).map((m) => m.key);
  note(`piyasa: ${market.items?.length || 0} kalem (live=${market.live}, örnek=${marketSamples.join(',') || 'yok'}) · hava (live=${weather.live})`);

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
    imageAudit,
    fullTexts: fullOk,
    marketLive: !!market.live,
    weatherLive: !!weather.live,
  }, null, 2));

  console.log(`✔ dist/ hazır (${Math.round((Date.now() - t0) / 1000)} sn)`);
}

main().catch((e) => {
  console.error('✖ derleme hatası:', e);
  if (process.env.GITHUB_ACTIONS) {
    const msg = String(e?.stack || e).split('\n').slice(0, 4).join(' | ')
      .replace(/%/g, '%25').replace(/\r?\n/g, '%0A');
    console.log(`::error title=TELGRAF derleme hatası::${msg}`);
  }
  process.exit(1);
});
