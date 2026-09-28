// RSS/Atom çekirdeği: feed indirme, XML çözümleme, görsel çıkarma, normalizasyon
import { XMLParser } from 'fast-xml-parser';
import crypto from 'node:crypto';
import { FETCH_TIMEOUT_MS, USER_AGENT, SOURCE_BY_ID } from './config.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: true,
  trimValues: true,
  isArray: (name) => ['item', 'entry', 'media:content', 'media:thumbnail', 'enclosure', 'category', 'link'].includes(name),
});

export async function fetchText(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const firstText = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return firstText(v[0]);
  if (typeof v === 'object') return firstText(v['#text'] ?? v['@_url'] ?? v['@_href'] ?? '');
  return String(v);
};

export function stripHtml(html) {
  return String(html || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&hellip;/gi, '…')
    .replace(/&mdash;/gi, '—')
    .replace(/\s+/g, ' ')
    .trim();
}

function findImage(node) {
  // 1) media:content / media:thumbnail / enclosure / itunes:image
  for (const key of ['media:content', 'media:thumbnail', 'enclosure', 'itunes:image']) {
    for (const el of asArray(node[key])) {
      const url = el?.['@_url'] || el?.['@_href'] || el?.['@_link'] || (typeof el === 'string' ? el : '');
      if (url && /^https?:\/\//.test(url)) return url;
    }
  }
  // 2) description / content:encoded içindeki ilk <img>
  for (const key of ['description', 'content:encoded', 'content', 'media:description', 'summary']) {
    const html = typeof node[key] === 'string' ? node[key] : firstText(node[key]);
    const m = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m && /^https?:\/\//.test(m[1])) return m[1];
    const md = String(html).match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)/);
    if (md) return md[1];
  }
  return '';
}

function pickLink(item) {
  if (typeof item.link === 'string') return item.link;
  for (const l of asArray(item.link)) {
    const rel = l?.['@_rel'];
    const href = l?.['@_href'];
    if (href && (!rel || rel === 'alternate')) return href;
  }
  return item.guid?.['#text'] || item.guid || item.id || '';
}

function normalizeItem(item, source, category) {
  const title = stripHtml(firstText(item.title));
  let link = stripHtml(pickLink(item));
  if (!title || !link) return null;
  // BBC feed link'lerindeki izleme parametrelerini temizle
  link = link.replace(/\?at_medium=.*$/, '').replace(/#0$/, '');
  const rawDate = firstText(item.pubDate) || firstText(item.published) || firstText(item.updated) || firstText(item['dc:date']);
  const published = rawDate ? new Date(rawDate) : new Date();
  const summary = stripHtml(firstText(item.description) || firstText(item.summary) || firstText(item['content:encoded'])).slice(0, 400);
  const image = findImage(item) || upgradeImage(firstText(item['media:thumbnail']));
  return {
    id: crypto.createHash('sha1').update(link).digest('hex').slice(0, 12),
    title,
    summary,
    link,
    image: image || '',
    published: isNaN(published.getTime()) ? new Date().toISOString() : published.toISOString(),
    source: source.id,
    category,
    author: stripHtml(firstText(item.author) || firstText(item['dc:creator'])),
  };
}

// Bazı kaynaklar küçük thumbnail verir — daha büyük sürümü dene
function upgradeImage(url) {
  if (!url) return '';
  return url
    .replace('/ace/standard/240/', '/ace/standard/1024/')
    .replace('width=140', 'width=1200')
    .replace('mediumSquareAt3X', 'jumbo')
    .replace(/([?&])w=668/, '$1w=1200');
}

export function parseFeed(xml, source, defaultCategory) {
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel ?? doc?.feed ?? doc?.['rdf:RDF'] ?? {};
  const items = asArray(channel.item ?? channel.entry ?? []);
  return items
    .map((it) => normalizeItem(it, source, defaultCategory))
    .filter(Boolean);
}

export async function fetchFeed(feed, source) {
  const xml = await fetchText(feed.url);
  return parseFeed(xml, source, feed.category);
}

export function googleNewsToRealUrl(url) {
  // Google News yönlendirme linkleri tarayıcıda çözülür; olduğu gibi bırakılır
  return url;
}

export function sourceMeta(id) {
  return SOURCE_BY_ID[id] || null;
}
