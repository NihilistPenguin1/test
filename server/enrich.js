// Görsel zenginleştirme + tam metin çıkarma (5 katmanlı, derinlemesine)
//
// GÖRSEL katmanları:
//   1) feed görseli (çağıran yerde)
//   2) sayfa analizi: og:image / twitter:image / JSON-LD / içerik görseli
//   3) WordPress oEmbed thumbnail_url (TechCrunch, Ars ve WP tabanlı siteler)
//   4) r.jina.ai ilk görsel (bot korumalı siteler + Google News yönlendirmesi)
//   5) ekran görüntüsü servisleri (thum.io → mShots) — son çare
//
// Google News yönlendirme linkleri gerçek makale URL'sine çözülür (metin + görsel için).
import sanitizeHtml from 'sanitize-html';
import { USER_AGENT } from './config.js';
import { fetchText } from './rss.js';

const JINA_PREFIX = 'https://r.jina.ai/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ogCache = new Map();        // orijinal link -> görsel URL (kalıcı)
const googleUrlCache = new Map(); // google news link -> gerçek makale URL
const articleCache = new Map();   // id -> { at, data }
const ARTICLE_TTL = 24 * 60 * 60 * 1000;

async function fetchHtml(url, timeoutMs = 9000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,tr;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { html: await res.text(), finalUrl: res.url || url };
  } finally {
    clearTimeout(t);
  }
}

async function fetchJina(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(JINA_PREFIX + url, {
      signal: ac.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' },
    });
    if (!res.ok) throw new Error(`jina HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/* ============================================================
   1) Google News yönlendirme çözümü
   ============================================================ */
const isGoogleHost = (h) => /(?:^|\.)(google|gstatic|googleusercontent|ggpht|youtube|blogger|blogspot)\./i.test(h);

function unescapeUrl(u) {
  return String(u)
    .replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/\\u002f/g, '/')
    .replace(/\\u0025/g, '%').replace(/\\\//g, '/').replace(/&amp;/g, '&');
}

/** Google News makale kimliği (CBMi… / AU_yqL… / CEni…) */
function googleArticleId(url) {
  const m = String(url || '').match(/news\.google\.com\/(?:rss\/)?articles\/([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : null;
}

function findRedirectTarget(html) {
  const candidates = [];
  const push = (u) => {
    try {
      const abs = unescapeUrl(u);
      const parsed = new URL(abs);
      if (/^https?:$/.test(parsed.protocol) && !isGoogleHost(parsed.hostname)) {
        // varlık dosyalarını ele (js/css/png...)
        if (!/\.(js|css|png|jpe?g|gif|svg|ico|woff2?)(\?|$)/i.test(parsed.pathname)) {
          candidates.push(abs);
        }
      }
    } catch { /* geçersiz */ }
  };
  // data-n-au özniteliği (Google News yönlendirme sayfası)
  for (const m of html.matchAll(/data-n-au=["']([^"']+)["']/g)) push(m[1]);
  // rel="noreferrer" bağlantıları
  for (const m of html.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*rel=["']noreferrer["']/gi)) push(m[1]);
  for (const m of html.matchAll(/<a[^>]+rel=["']noreferrer["'][^>]*href=["'](https?:\/\/[^"']+)["']/gi)) push(m[1]);
  // JS dizesi içindeki URL (window.location.replace vs.)
  for (const m of html.matchAll(/["'](https?:\/\/[^"'\s]+?)["']/g)) push(m[1]);
  // en uzun/yazımsal görünen aday (makale URL'si genelde en uzunudur)
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || '';
}

const decodeParamsCache = new Map(); // article id -> {direct|sig+ts}

/**
 * Google News makale sayfasından imza (data-n-a-sg) + zaman damgası (data-n-a-ts)
 * çıkarır. Bu ikili, batchexecute RPC ile gerçek URL'yi almak için gereklidir.
 */
async function getDecodeParams(id) {
  if (decodeParamsCache.has(id)) return decodeParamsCache.get(id);
  let out = { id };
  for (const u of [
    `https://news.google.com/articles/${id}?hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/articles/${id}?hl=en-US&gl=US&ceid=US:en`,
  ]) {
    try {
      const { html } = await fetchHtml(u, 12000);
      const direct = findRedirectTarget(html);
      if (direct && !direct.includes('news.google.com')) {
        out = { id, direct };
        break;
      }
      const sg = (html.match(/data-n-a-sg=["']([^"']+)["']/) || [])[1];
      const ts = (html.match(/data-n-a-ts=["']([^"']+)["']/) || [])[1];
      if (sg && ts) {
        out = { id, sig: sg, ts };
        break;
      }
    } catch { /* sonraki */ }
  }
  decodeParamsCache.set(id, out);
  return out;
}

/** batchexecute yanıtından gerçek URL'leri ayıklar (çeşitli zarflara dayanıklı) */
export function parseBatchResponse(text) {
  const urls = [];
  const push = (u) => {
    const clean = unescapeUrl(u);
    if (/^https?:/.test(clean) && !/news\.google\.com/.test(clean)) urls.push(clean);
  };
  for (const part of String(text || '').split('\n\n')) {
    const body = part.replace(/^\)\]\}'/, '').trim();
    if (!body.startsWith('[')) continue;
    try {
      const arr = JSON.parse(body);
      for (const row of arr) {
        if (!Array.isArray(row) || typeof row[2] !== 'string') continue;
        try {
          const inner = JSON.parse(row[2]);
          if (Array.isArray(inner) && typeof inner[1] === 'string' && /^https?:/.test(inner[1])) push(inner[1]);
        } catch {
          const m = row[2].match(/garturlres\\",\\"(https?:[^\\"]+)/);
          if (m) push(m[1]);
        }
      }
    } catch { /* düz metin taramasına düş */ }
  }
  if (!urls.length) {
    const re = /garturlres\\",\\"(https?:[^\\"]+)/g;
    let m;
    while ((m = re.exec(String(text)))) push(m[1]);
  }
  if (!urls.length) {
    const re2 = /"garturlres","(https?:[^"]+)"/g;
    let m;
    while ((m = re2.exec(String(text)))) push(m[1]);
  }
  return urls;
}

/**
 * Toplu Google News çözümü — tek POST'ta çok sayıda linki çözer.
 * Yöntem: makale sayfasından imza/zaman damgası → news.google.com/_/DotsSplashUi/data/batchexecute
 * (googlenewsdecoder / google-news-url-decoder paketleriyle aynı RPC: Fbv4je + garturlreq)
 */
export async function resolveGoogleBatch(urls) {
  const out = new Map(); // orijinal -> gerçek
  const pending = [];
  for (const url of urls) {
    const id = googleArticleId(url);
    if (!id) continue;
    const cached = googleUrlCache.get(url) || googleUrlCache.get(id);
    if (cached && !cached.includes('news.google.com')) {
      out.set(url, cached);
      continue;
    }
    if (!pending.some((p) => p.id === id)) pending.push({ url, id });
    else pending.push({ url, id: pending.find((p) => p.id === id).id });
  }
  if (!pending.length) return out;

  // 1) İmza + zaman damgaları (hafif GET'ler; aralarında kısa bekleme)
  const params = [];
  for (const p of pending) {
    const pr = await getDecodeParams(p.id);
    params.push({ ...p, ...pr });
    await sleep(120);
  }

  // 2) Doğrudan dönenleri yaz; imzalıları tek POST'a koy
  const needBatch = [];
  for (const p of params) {
    if (p.direct) {
      googleUrlCache.set(p.url, p.direct);
      googleUrlCache.set(p.id, p.direct);
      out.set(p.url, p.direct);
    } else if (p.sig && p.ts && !needBatch.some((x) => x.id === p.id)) {
      needBatch.push(p);
    }
  }

  const postBatch = async (rows) => {
    const body = new URLSearchParams({ 'f.req': JSON.stringify([rows]) });
    const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je', {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Referer: 'https://news.google.com/',
        Accept: '*/*',
      },
      body,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`batchexecute HTTP ${res.status}`);
    return parseBatchResponse(await res.text());
  };

  if (needBatch.length) {
    // İmzalı zarf (2024→2026 yaygın yöntem)
    const sigRows = needBatch.map((p) => [
      'Fbv4je',
      `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${p.id}",${Number(p.ts)},"${p.sig}"]`,
      null,
      'generic',
    ]);
    try {
      const decoded = await postBatch(sigRows);
      needBatch.forEach((p, i) => {
        const real = decoded[i];
        if (real) {
          googleUrlCache.set(p.url, real);
          googleUrlCache.set(p.id, real);
          out.set(p.url, real);
        }
      });
    } catch { /* imzasız zarfa düş */ }
    await sleep(250);
  }

  // 3) Hâlâ çözülmemişlere imzasız zarf (eski yöntem)
  const still = params.filter((p) => !out.has(p.url) && !p.direct);
  const uniqStill = still.filter((p, i) => still.findIndex((x) => x.id === p.id) === i);
  if (uniqStill.length) {
    const nosigRows = uniqStill.map((p) => [
      'Fbv4je',
      `["garturlreq",[["en-US","US",["FINANCE_TOP_INDICES","WEB_TEST_1_0_0"],null,null,1,1,"US:en",null,180,null,null,null,null,null,0,null,null,[1608992183,723341000]],"en-US","US",1,[2,3,4,8],1,0,"655000234",0,0,null,0],"${p.id}"]`,
      null,
      'generic',
    ]);
    try {
      const decoded = await postBatch(nosigRows);
      uniqStill.forEach((p, i) => {
        const real = decoded[i];
        if (real) {
          googleUrlCache.set(p.url, real);
          googleUrlCache.set(p.id, real);
          out.set(p.url, real);
        }
      });
    } catch { /* jina katmanı dener */ }
  }

  // Eşlemediyse bile orijinal URL'yi sonuçta göster (tekrar tekrar denemesin)
  for (const p of params) {
    if (!out.has(p.url)) out.set(p.url, googleUrlCache.get(p.url) || p.url);
  }
  return out;
}

/** Google News linkini gerçek makale URL'sine çevirir (bulamazsa girdiği URL'yi döner) */
export async function resolveArticleUrl(url) {
  if (!url || !googleArticleId(url)) return url;
  const cached = googleUrlCache.get(url);
  if (cached) return cached;
  try {
    const map = await resolveGoogleBatch([url]);
    if (map.get(url)) return map.get(url);
    // Son çare: jina JS ile yönlendirmeyi takip eder ve sayfayı render eder
    const md = await fetchJina(url, 18000);
    const m = md.match(/^URL Source:\s*(https?:\/\/\S+)/m);
    if (m && m[1] && !m[1].includes('news.google.com')) {
      googleUrlCache.set(url, m[1]);
      return m[1];
    }
  } catch { /* sessiz */ }
  return url;
}

/* ============================================================
   2) Sayfa görsel analizi
   ============================================================ */
function metaPairs(html) {
  const out = [];
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
    const tag = m[0];
    const key = (tag.match(/(?:property|name|itemprop)=["']([^"']+)["']/i) || [])[1];
    const val = (tag.match(/content=["']([^"']+)["']/i) || [])[1];
    if (key && val) out.push([key.toLowerCase(), val]);
  }
  return out;
}

const BAD_IMG = /logo|favicon|avatar|icon|badge|sprite|emoji|smiley|gravatar|profile|placeholder|1x1|pixel|tracking|newsletter|subscribe|author-image|byline/i;
const GOOD_IMG = /upload|wp-content|media|image|img|photo|static|cdn|resize|crop|master|article/i;

function absUrl(url, base) {
  try { return new URL(url, base).href; } catch { return url; }
}

function pickBestImage(html, baseUrl) {
  const pairs = metaPairs(html);
  const get = (key) => pairs.filter(([k]) => k === key).map(([, v]) => v);

  const widths = {};
  pairs.forEach(([k, v]) => { if (k.startsWith('og:image:width')) widths[v] = true; });
  const ogWidths = get('og:image:width');

  // 1) og:image:secure_url → og:image → twitter:image → itemprop=image
  const candidates = [
    ...get('og:image:secure_url'),
    ...get('og:image'),
    ...get('og:image:url'),
    ...get('twitter:image'),
    ...get('twitter:image:src'),
    ...get('image'),
    ...get('itemprop=image'),
  ].filter((u) => /^https?:\/\//.test(u) || u.startsWith('/'));

  // 2) JSON-LD "image" alanları
  for (const m of html.matchAll(/"image"\s*:\s*(?:"([^"]+)"|\[\s*"([^"]+)"|\{\s*"url"\s*:\s*"([^"]+)")/g)) {
    const u = m[1] || m[2] || m[3];
    if (u) candidates.push(u);
  }

  // 3) İçerik görselleri (son çare — logo/ikon ayıklamasıyla)
  for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    const u = m[1];
    if (u.startsWith('data:')) continue;
    if (BAD_IMG.test(u)) continue;
    candidates.push(u);
  }

  const seen = new Set();
  for (const raw of candidates) {
    const url = absUrl(raw, baseUrl);
    if (seen.has(url)) continue;
    seen.add(url);
    if (!/^https?:\/\//.test(url)) continue;
    if (BAD_IMG.test(url) && !GOOD_IMG.test(url)) continue;
    // çok küçük olduğu belirtilen görselleri (logo) atla
    const wIdx = candidates.indexOf(raw);
    const w = Number(ogWidths[Math.min(wIdx, ogWidths.length - 1)] || 0);
    if (w && w < 300) continue;
    return url;
  }
  return '';
}

/* ============================================================
   3) WordPress oEmbed (WP tabanlı yayınlar)
   ============================================================ */
async function oembedImage(realUrl) {
  try {
    const u = new URL(realUrl);
    const api = `https://${u.hostname}/wp-json/oembed/1.0/embed?url=${encodeURIComponent(realUrl)}`;
    const txt = await fetchText(api, 8000);
    const j = JSON.parse(txt);
    return j.thumbnail_url || '';
  } catch {
    return '';
  }
}

function scoreImageUrl(u) {
  const l = String(u).toLowerCase();
  if (!/^https?:/.test(l)) return -1;
  if (BAD_IMG.test(l) && !GOOD_IMG.test(l)) return -1;
  if (/googleusercontent|gstatic|google\.com\/(images|branding)|news\.google\.com|blogger\.com|blogspot\./.test(l)) return -1;
  if (/\.svg(\?|$)/.test(l)) return -1;
  let s = 0;
  if (GOOD_IMG.test(l)) s += 3;
  if (/resizer|wp-content\/uploads|ichef|static01|static\.nytimes|cloudfront|akamaized|\/master\/|\/original\//.test(l)) s += 2;
  if (/\.(jpe?g|png|webp)(\?|$)/.test(l)) s += 1;
  if (/logo|icon|avatar|sprite|favicon|badge|author|profile|byline|headshot|newsletter/.test(l)) s -= 5;
  if (/width=1[0-9]{2,}|[/_][5-9][0-9]{2}x[0-9]|w=1[0-9]{3}|\/[1-9][0-9]{3}\//.test(l)) s += 2;
  return s;
}

function firstMarkdownImage(md) {
  let best = '';
  let bestScore = 0;
  const seen = new Set();
  for (const m of md.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) {
    const u = m[1];
    if (seen.has(u)) continue;
    seen.add(u);
    const s = scoreImageUrl(u);
    if (s > bestScore) {
      bestScore = s;
      best = u;
    }
    // ilk makul görsel + daha iyisi çıkmazsa onu döndür
    if (!best && s >= 2) best = u;
  }
  return best || '';
}

/* ---------- Ekran görüntüsü servisleri (son çare) ---------- */
export function thumUrl(link) {
  return `https://image.thum.io/get/width/1200/crop/675/noanimate/${link}`;
}
export function mshotUrl(link) {
  return `https://s.wordpress.com/mshots/v1/${encodeURIComponent(link)}?w=1200&h=675`;
}

async function screenshotUrl(link) {
  // thum.io'yu hafifçe yokla (bu aynı zamanda ekran görüntüsünü hazırlar);
  // cevap yoksa mShots'a düş
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 9000);
    const res = await fetch(thumUrl(link), { method: 'GET', signal: ac.signal });
    clearTimeout(t);
    if (res.ok && (res.headers.get('content-type') || '').includes('image')) return thumUrl(link);
  } catch { /* sonraki */ }
  return mshotUrl(link);
}

/* ============================================================
   Ana görsel çözücü (5 katman)
   ============================================================ */
export async function extractOgImage(link) {
  if (ogCache.has(link)) return ogCache.get(link);
  let img = '';
  let realUrl = link;
  try {
    realUrl = await resolveArticleUrl(link);
    const { html, finalUrl } = await fetchHtml(realUrl, 10000);
    img = pickBestImage(html, finalUrl);
  } catch { /* sonraki katman */ }
  if (!img) img = await oembedImage(realUrl);
  if (!img) {
    try {
      img = firstMarkdownImage(await fetchJina(realUrl, 14000));
    } catch { /* sonraki katman */ }
  }
  if (!img) img = await screenshotUrl(realUrl);
  ogCache.set(link, img);
  return img;
}

async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;
  async function worker() {
    while (i < arr.length) {
      const idx = i++;
      out[idx] = await fn(arr[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, worker));
  return out;
}

// Görseli olmayan haberlere görsel yerleştirir (yerinde günceller)
export async function enrichImages(items, max = 24, concurrency = 8) {
  const targets = items.filter((it) => !it.image && it.link).slice(0, max);
  if (!targets.length) return items;

  // Google News linklerini TEK batchexecute çağrısıyla toplu çöz
  // (Reuters/AP vb. için görselin anahtarı: gerçek makale URL'si)
  try {
    const googleItems = targets.filter((it) => googleArticleId(it.link));
    if (googleItems.length) {
      const map = await resolveGoogleBatch(googleItems.map((it) => it.link));
      for (const it of googleItems) {
        const real = map.get(it.link);
        if (real && !real.includes('news.google.com')) it.link = real;
      }
    }
  } catch { /* bireysel katmanlar dener */ }

  await mapLimit(targets, concurrency, async (it) => {
    const img = await extractOgImage(it.link);
    if (img) it.image = img;
    return it;
  });
  return items;
}

/* ============================================================
   Tam metin
   ============================================================ */
export function sanitizeContent(html) {
  return sanitizeHtml(html || '', {
    allowedTags: [
      'p', 'h2', 'h3', 'h4', 'br', 'hr',
      'ul', 'ol', 'li',
      'blockquote', 'pre', 'code',
      'em', 'strong', 'i', 'b', 'u', 's', 'sub', 'sup',
      'a', 'img', 'figure', 'figcaption',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    allowedAttributes: {
      a: ['href', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    },
    allowedSchemes: ['http', 'https', 'data'],
    transformTags: {
      a: (tagName, attribs) => ({
        tagName: 'a',
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' },
      }),
      img: (tagName, attribs) => ({
        tagName: 'img',
        attribs: { ...attribs, loading: 'lazy' },
      }),
    },
  });
}

function mdInline(s) {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '<img src="$2" alt="$1"/>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/(^|\s)_([^_]+)_(\s|$)/g, '$1<em>$2</em>$3');
}

function mdToHtml(md) {
  const body = md.includes('Markdown Content:') ? md.split('Markdown Content:').slice(1).join('Markdown Content:') : md;
  const lines = body.split('\n');
  let html = '';
  let inList = false;
  let inQuote = false;
  let para = [];
  const flush = () => {
    if (para.length) {
      html += `<p>${para.join(' ')}</p>`;
      para = [];
    }
  };
  const closeAll = () => {
    flush();
    if (inList) { html += '</ul>'; inList = false; }
    if (inQuote) { html += '</blockquote>'; inQuote = false; }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    let m;
    if ((m = line.match(/^!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/))) {
      closeAll();
      html += `<figure><img src="${m[2]}" alt="${mdInline(m[1])}"/>${m[1] ? `<figcaption>${mdInline(m[1])}</figcaption>` : ''}</figure>`;
      continue;
    }
    if ((m = line.match(/^#{1,4}\s+(.*)/))) {
      closeAll();
      html += `<h3>${mdInline(m[1])}</h3>`;
      continue;
    }
    if ((m = line.match(/^>\s?(.*)/))) {
      flush();
      if (!inQuote) { html += '<blockquote>'; inQuote = true; }
      html += `<p>${mdInline(m[1])}</p>`;
      continue;
    }
    if (inQuote) { html += '</blockquote>'; inQuote = false; }
    if ((m = line.match(/^[-*•]\s+(.*)/))) {
      flush();
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${mdInline(m[1])}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    para.push(mdInline(line));
  }
  closeAll();
  return html;
}

function parseJinaMeta(md) {
  const title = (md.match(/^Title:\s*(.+)$/m) || [])[1] || '';
  return { title: title.trim() };
}

export async function fetchArticle(item) {
  const cached = articleCache.get(item.id);
  if (cached && Date.now() - cached.at < ARTICLE_TTL) return cached.data;

  // Google News linklerini gerçek makaleye çevir (Reuters/AP vb.)
  const realUrl = await resolveArticleUrl(item.link);

  // 1) Doğrudan çekim + Readability
  try {
    // jsdom tembel yüklenir: ortamda bozuksa süreç çökmez, jina katmanına düşer
    const { JSDOM } = await import('jsdom');
    const { Readability } = await import('@mozilla/readability');
    const { html, finalUrl } = await fetchHtml(realUrl, 12000);
    const dom = new JSDOM(html, { url: finalUrl });
    const parsed = new Readability(dom.window.document).parse();
    const text = (parsed?.textContent || '').replace(/\s+/g, ' ').trim();
    if (parsed?.content && text.length >= 400) {
      const contentHtml = sanitizeContent(parsed.content).replace(
        /(src|href)=["'](\/[^"']*)["']/g,
        (_, attr, rel) => `${attr}="${absUrl(rel, finalUrl)}"`
      );
      const words = text.split(' ').length;
      const data = {
        title: parsed.title || item.title,
        author: parsed.byline || item.author || '',
        excerpt: parsed.excerpt || item.summary || '',
        image: parsed.heroImage ? absUrl(parsed.heroImage, finalUrl) : item.image,
        content: contentHtml,
        textLength: text.length,
        readingMinutes: Math.max(1, Math.round(words / 220)),
        resolvedUrl: finalUrl,
        via: 'direct',
      };
      articleCache.set(item.id, { at: Date.now(), data });
      return data;
    }
    throw new Error('content too short / challenge page');
  } catch (e) {
    // 2) r.jina.ai — bot korumalarını ve JS yönlendirmelerini aşar
    try {
      const md = await fetchJina(realUrl, 18000);
      const meta = parseJinaMeta(md);
      const contentHtml = sanitizeContent(mdToHtml(md));
      const text = md.replace(/[#*_>`\[\]()!]/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length < 300) throw new Error('jina content too short');
      const words = text.split(' ').length;
      const data = {
        title: meta.title || item.title,
        author: item.author || '',
        excerpt: item.summary || '',
        image: item.image || (firstMarkdownImage(md) || ''),
        content: contentHtml,
        textLength: text.length,
        readingMinutes: Math.max(1, Math.round(words / 220)),
        resolvedUrl: realUrl !== item.link ? realUrl : item.link,
        via: 'jina',
      };
      articleCache.set(item.id, { at: Date.now(), data });
      return data;
    } catch (e2) {
      throw new Error(`${e.message}; fallback: ${e2.message}`);
    }
  }
}
