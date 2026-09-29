#!/usr/bin/env node
// TELGRAF statik site üretici — GitHub Actions her gece 00:00 (Türkiye) çalıştırır.
// Tüm veriyi (haberler + kapak görselleri + tam metinler + piyasa + hava) o an
// çekip dist/ altına koyar; site tamamen statik olarak GitHub Pages'ten yayınlanır.
import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNews, getMarketData, getWeatherData } from '../server/store.js';
import { enrichImages, fetchArticle, resolveGoogleBatch, isArticleUrl, isExpectedPublisherUrl, isGoogleNewsArticleUrl, isScreenshotServiceUrl } from '../server/enrich.js';
import { SOURCES, CATEGORIES } from '../server/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const FULL_TEXT_BUILD_LIMIT = 300;

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
  await mapLimit(directUrls, 24, async (url) => {
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
  // GitHub Actions annotation'ı — log erişimi olmasa da API'den okunur.
  // NOT: adımda başına ~10 not düşer; bu yüzden derleme en fazla 5 konsolide not yayar.
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::notice title=TELGRAF derleme::${String(msg).replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);
  }
}

async function writeStepSummary(text) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const { appendFile } = await import('node:fs/promises');
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n${text}\n`);
}

let stageStartedAt = 0;
function noteStage(name) {
  const seconds = ((Date.now() - stageStartedAt) / 1000).toFixed(1);
  console.log(`zamanlama ${name}: ${seconds} sn`);
  stageStartedAt = Date.now();
}

async function main() {
  const t0 = Date.now();
  stageStartedAt = t0;
  console.log('▶ TELGRAF statik derleme başladı');

  /* ---------- 1) Topla (bellekte) ---------- */

  // Haberler (31 feed, canlı + seed karışımı)
  const news = await getNews({ force: true });
  const items = news.items;
  console.log(`haber: ${items.length} (live=${news.live}, hata=${news.errors?.length || 0})`);
  noteStage('haber çekimi');

  // Google News linklerini TOPLU çöz (Reuters/AP vb. gerçek makale URL'sine)
  let gnBatch = 0;
  try {
    const resolved = await resolveGoogleBatch(items.map((i) => i.link).filter(Boolean));
    for (const it of items) {
      const real = resolved.get(it.link);
      if (real && real !== it.link && isArticleUrl(real) && isExpectedPublisherUrl(it.source, real)) {
        it.link = real;
        gnBatch++;
      }
    }
    console.log(`  google news çözümü: ${gnBatch} link gerçek makaleye yönlendirildi`);
  } catch (e) {
    console.log(`  google news çözümü başarısız: ${e.message}`);
  }
  // 2) Kalan Google News linklerini stealth tarayıcıyla çöz
  let gnStealth = 0;
  let gnStill = 0;
  {
    const still = items.filter((it) => isGoogleNewsArticleUrl(it.link));
    gnStill = still.length;
    if (still.length) {
      console.log(`google news kalan: ${still.length} link tarayıcıyla çözülecek`);
      const { stealthResolveGoogleNews } = await import('../server/stealth.js');
      await mapLimit(still, 4, async (it) => {
        try {
          const real = await stealthResolveGoogleNews(it.link);
          if (real && isArticleUrl(real) && isExpectedPublisherUrl(it.source, real)) {
            it.link = real;
            gnStealth++;
          }
        } catch { /* yedek bağlantıda kalır */ }
      });
      console.log(`google news stealth çözümü: ${gnStealth}/${still.length} link gerçek makaleye yönlendirildi`);
    }
  }
  noteStage('Google News çözümü');

  // Bozuk ve AP/Reuters yayıncı alan adıyla uyuşmayan doğrudan linkleri yayına sokma.
  const badLinks = items.filter((it) => !isStoryLink(it.link)
    || (['ap', 'reuters'].includes(it.source)
      && !isGoogleNewsArticleUrl(it.link)
      && !isExpectedPublisherUrl(it.source, it.link)));
  if (badLinks.length) {
    const badIds = new Set(badLinks.map((it) => it.id));
    for (let i = items.length - 1; i >= 0; i--) if (badIds.has(items[i].id)) items.splice(i, 1);
  }
  note(`makale bağlantıları: ${items.length} geçerli, ${badLinks.length} hatalı kayıt ayıklandı`);
  const publisherItems = items.filter((it) => ['ap', 'reuters'].includes(it.source));
  const publisherMatched = publisherItems.filter((it) => !isGoogleNewsArticleUrl(it.link)
    && isExpectedPublisherUrl(it.source, it.link)).length;
  const googleFallbacks = publisherItems.filter((it) => isGoogleNewsArticleUrl(it.link)).length;
  const publisherMismatches = publisherItems.length - publisherMatched - googleFallbacks;
  note(`kaynaklar: haber=${items.length} (live=${news.live}, feed-hata=${news.errors?.length || 0}) · google-news: batch=${gnBatch}, stealth=${gnStealth}/${gnStill} · AP/Reuters: toplam=${publisherItems.length} eşleşen=${publisherMatched} yedek=${googleFallbacks} uyuşmazlık=${publisherMismatches}`);

  // Eksik kapak görsellerini challenge-duyarlı görsel motoruyla tamamla (HEPSİ)
  try {
    await enrichImages(items, 5000, 8);
  } catch (e) {
    console.log(`  görsel zenginleştirme hatası: ${e.message}`);
  }
  const withImg = items.filter((i) => i.image).length;
  const imageAudit = await auditImageUrls(items);
  note(`görsel: kart=${withImg}/${items.length} · denetim: doğrulanan=${imageAudit.verified}/${imageAudit.direct}, HTTP-hata=${imageAudit.httpFailures}, görsel-değil=${imageAudit.nonImageResponses}, istek-hata=${imageAudit.requestFailures}`);
  noteStage('görsel zenginleştirme ve denetim');

  // Derlemeyi kısa tutmak ve kaynakları yormamak için en yeni 300 haberin tam metnini üret.
  // Daha eski haberler kartta kalır; okuyucu kaynak yayına gidebilir.
  const fullTextItems = items.slice(0, FULL_TEXT_BUILD_LIMIT);
  let fullOk = 0;
  const fullDocs = [];
  const hostStats = new Map(); // host -> { ok, fail, via: Map, reasons: Map }
  const bump = (it, ok, via = '', reason = '') => {
    let host = '?';
    try { host = new URL(it.link).hostname.replace(/^www\./, ''); } catch { /* bilinmeyen */ }
    const s = hostStats.get(host) || { ok: 0, fail: 0, via: new Map(), reasons: new Map() };
    ok ? s.ok++ : s.fail++;
    if (ok && via) s.via.set(via, (s.via.get(via) || 0) + 1);
    if (!ok && reason) s.reasons.set(reason, (s.reasons.get(reason) || 0) + 1);
    hostStats.set(host, s);
  };
  await mapLimit(fullTextItems, 10, async (it) => {
    try {
      const article = await fetchArticle(it);
      if (article?.content) {
        fullDocs.push({ id: it.id, item: it, article });
        fullOk++;
        bump(it, true, article.via || '?');
      } else {
        bump(it, false, '', 'empty');
      }
    } catch (e) {
      bump(it, false, '', e.reason || 'other');
      console.log(`  tam metin yok (${it.id}): ${String(e.message).slice(0, 80)}`);
    }
  });
  const hostSummary = [...hostStats.entries()]
    .sort((a, b) => (b[1].fail - a[1].fail) || (b[1].ok + b[1].fail) - (a[1].ok + a[1].fail))
    .map(([h, s]) => {
      const via = s.via.size ? ` [${[...s.via.entries()].map(([v, n]) => `${v}=${n}`).join(',')}]` : '';
      const why = s.reasons.size ? ` {${[...s.reasons.entries()].map(([v, n]) => `${v}:${n}`).join(',')}}` : '';
      return `${h}: ${s.ok}/${s.ok + s.fail}${via}${why}`;
    })
    .join(' · ');
  note(`tam metin: ${fullOk}/${fullTextItems.length} denenen (en yeni ${fullTextItems.length}/${items.length}) · ${hostSummary}`);
  noteStage('tam metinler');

  // Piyasa + hava (sunucu tarafında çekim — tarayıcı CORS sorunu yok)
  const [market, weather] = await Promise.all([
    getMarketData().catch((e) => ({ items: [], live: false, error: e.message })),
    getWeatherData().catch((e) => ({ live: false, error: e.message })),
  ]);
  const marketSamples = (market.items || []).filter((m) => m.sample).map((m) => m.key);
  console.log(`piyasa: ${market.items?.length || 0} kalem (live=${market.live}, örnek=${marketSamples.join(',') || 'yok'}) · hava (live=${weather.live})`);
  noteStage('piyasa ve hava');

  // Stealth tarayıcı teşhisi + kapanış notu + adım özeti (ayrıntılı rapor)
  let stealthLine = 'stealth: kapalı';
  try {
    const { stealthStats, closeStealth } = await import('../server/stealth.js');
    const s = stealthStats();
    stealthLine = `stealth: denenen=${s.attempts} başarılı=${s.successes} challenge=${s.challengeSeen} geçen=${s.challengeCleared} bütçe=${Math.round(s.budgetSpentMs / 1000)}sn duvarlı=${s.hosts.filter((h) => h.hardBlocked).map((h) => h.host).join(',') || 'yok'}`;
    await closeStealth();
  } catch { /* stealth kapalı olabilir */ }
  note(`özet: piyasa=${market.items?.length || 0}kalem(live=${market.live}) hava(live=${weather.live}) · ${stealthLine} · süre=${Math.round((Date.now() - t0) / 1000)}sn`);
  await writeStepSummary([
    '## TELGRAF derleme raporu',
    '',
    `| Alan | Değer |`,
    `|---|---|`,
    `| Haber | ${items.length} (live=${news.live}, feed-hata=${news.errors?.length || 0}) |`,
    `| Google News | batch=${gnBatch}, stealth=${gnStealth}/${gnStill} |`,
    `| Kapak görseli | ${withImg}/${items.length} |`,
    `| Tam metin | ${fullOk}/${fullTextItems.length} |`,
    `| Piyasa / Hava | live=${market.live} / live=${weather.live} |`,
    `| Süre | ${Math.round((Date.now() - t0) / 1000)} sn |`,
    '',
    `**Stealth:** ${stealthLine}`,
    '',
    `**Kaynak bazlı tam metin:** ${hostSummary || 'veri yok'}`,
  ].join('\n'));

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
    fullTextRequested: fullTextItems.length,
    fullTexts: fullOk,
    marketLive: !!market.live,
    weatherLive: !!weather.live,
  }, null, 2));

  noteStage('statik dosyalar');
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
