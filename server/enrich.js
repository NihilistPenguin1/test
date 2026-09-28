// Görsel zenginleştirme + tam metin çıkarma (çok katmanlı)
//
// GÖRSEL katmanları:  1) feed görseli  2) sayfadaki og:image
//                     3) r.jina.ai ilk görsel  4) mShots ekran görüntüsü
// METİN katmanları:   1) doğrudan çekim + Readability
//                     2) r.jina.ai markdown (Cloudflare/bot korumasını aşar)
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import sanitizeHtml from 'sanitize-html';
import { USER_AGENT } from './config.js';

const JINA_PREFIX = 'https://r.jina.ai/';

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

function firstMarkdownImage(md) {
  const re = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(md))) {
    const url = m[1];
    if (/logo|avatar|icon|badge|profile/i.test(url)) continue; // logoları atla
    return url;
  }
  return '';
}

export function mshotUrl(link) {
  // WordPress mShots: sayfanın ekran görüntüsü — tarayıcıda normal <img> gibi yüklenir
  return `https://s.wordpress.com/mshots/v1/${encodeURIComponent(link)}?w=1200&h=675`;
}

// 4 katmanlı görsel çözücü
export async function extractOgImage(link) {
  if (ogCache.has(link)) return ogCache.get(link);
  let img = '';
  // 1) Doğrudan sayfa çekimi → og:image
  try {
    const { html } = await fetchHtml(link, 8000);
    img = pickOgImage(html);
  } catch { /* sonraki katman */ }
  // 2) r.jina.ai → markdown içindeki ilk gerçek görsel
  if (!img) {
    try {
      const md = await fetchJina(link, 12000);
      img = firstMarkdownImage(md);
    } catch { /* sonraki katman */ }
  }
  // 3) mShots ekran görüntüsü (son çare — her koşulda görsel olur)
  if (!img) img = mshotUrl(link);
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
export async function enrichImages(items, max = 60, concurrency = 10) {
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

/* ---------- Markdown → HTML (jina çıktısı için) ---------- */
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
  const published = (md.match(/^Published Time:\s*(.+)$/m) || [])[1] || '';
  return { title: title.trim(), published: published.trim() };
}

/* ---------- Tam metin (2 katmanlı) ---------- */
export async function fetchArticle(item) {
  const cached = articleCache.get(item.id);
  if (cached && Date.now() - cached.at < ARTICLE_TTL) return cached.data;

  // 1) Doğrudan çekim + Readability (bot koruması yoksa)
  try {
    const { html, finalUrl } = await fetchHtml(item.link, 12000);
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
    // 2) r.jina.ai — Cloudflare gibi bot korumalarını aşar
    try {
      const md = await fetchJina(item.link, 18000);
      const meta = parseJinaMeta(md);
      const contentHtml = sanitizeContent(mdToHtml(md));
      const text = md.replace(/[#*_>`\[\]()!]/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length < 300) throw new Error('jina content too short');
      const words = text.split(' ').length;
      const data = {
        title: meta.title || item.title,
        author: item.author || '',
        excerpt: item.summary || '',
        image: item.image,
        content: contentHtml,
        textLength: text.length,
        readingMinutes: Math.max(1, Math.round(words / 220)),
        resolvedUrl: item.link,
        via: 'jina',
      };
      articleCache.set(item.id, { at: Date.now(), data });
      return data;
    } catch (e2) {
      throw new Error(`${e.message}; fallback: ${e2.message}`);
    }
  }
}
