// Görsel zenginleştirme + tam metin çıkarma
// - TechCrunch gibi feed'inde görsel olmayan kaynaklar için makale sayfasından og:image çekilir
// - "Sitede oku" görünümü için Readability ile ana içerik çıkarılır ve temizlenir
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import sanitizeHtml from 'sanitize-html';
import { USER_AGENT, FETCH_TIMEOUT_MS } from './config.js';

const ogCache = new Map();      // link -> görsel URL (kalıcı)
const articleCache = new Map(); // id -> { at, data }
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
    const html = await res.text();
    return { html, finalUrl: res.url || url };
  } finally {
    clearTimeout(t);
  }
}

function pickOgImage(html) {
  const patterns = [
    /<meta[^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image|twitter:image:src)["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|og:image:url|twitter:image|twitter:image:src)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && /^https?:\/\//.test(m[1])) return m[1];
  }
  return '';
}

export async function extractOgImage(link) {
  if (ogCache.has(link)) return ogCache.get(link);
  try {
    const { html } = await fetchHtml(link, 8000);
    const img = pickOgImage(html);
    if (img) ogCache.set(link, img);
    return img;
  } catch {
    return '';
  }
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

// Görseli olmayan haberlere og:image yerleştirir (yerinde günceller)
export async function enrichImages(items, max = 16, concurrency = 8) {
  const targets = items.filter((it) => !it.image && it.link).slice(0, max);
  if (!targets.length) return items;
  await mapLimit(targets, concurrency, async (it) => {
    const img = await extractOgImage(it.link);
    if (img) it.image = img;
    return it;
  });
  return items;
}

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

function absUrl(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

// Haber sayfasından okunabilir ana içeriği çıkarır
export async function fetchArticle(item) {
  const cached = articleCache.get(item.id);
  if (cached && Date.now() - cached.at < ARTICLE_TTL) return cached.data;

  const { html, finalUrl } = await fetchHtml(item.link, 12000);
  const dom = new JSDOM(html, { url: finalUrl });
  const reader = new Readability(dom.window.document);
  const parsed = reader.parse();

  // İçerikteki göreli görsel/linkleri mutlak yap
  const contentHtml = sanitizeContent(parsed?.content || '').replace(
    /(src|href)=["'](\/[^"']*)["']/g,
    (_, attr, rel) => `${attr}="${absUrl(rel, finalUrl)}"`
  );

  const text = (parsed?.textContent || '').replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').length : 0;

  const data = {
    title: parsed?.title || item.title,
    author: parsed?.byline || item.author || '',
    excerpt: parsed?.excerpt || item.summary || '',
    image: parsed?.heroImage ? absUrl(parsed.heroImage, finalUrl) : item.image,
    content: contentHtml,
    textLength: text.length,
    readingMinutes: Math.max(1, Math.round(words / 220)),
    resolvedUrl: finalUrl, // Google News linkleri gerçek makaleye çözülür
  };
  articleCache.set(item.id, { at: Date.now(), data });
  return data;
}
