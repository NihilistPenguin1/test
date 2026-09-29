/**
 * Kurtarma yolları (rescue).
 *
 * Yayıncının kendi sitesi veri merkezi IP'mizi captcha/DataDome duvarıyla
 * kestiğinde devreye giren üçüncü geçiş: aynı makaleye ulaşan ALTERNATİF
 * hatlar. Burası build'deki HTTP ve tarayıcı geçişleri boş döndükten sonra
 * çağrılır; yani hiçbir haber iki kez "kolay" yoldan geçmez.
 *
 * 2026-09-29 sandbox ölçümü (veri merkezi IP'si — CI koşucusuyla aynı sınıf):
 *   wayback  apnews.com 46.242 kr · nytimes.com 3.191 kr   0.2-3.6 sn/kopya
 *   jina     apnews.com 19.675 kelime (X-Wait-For-Selector) ~30 sn
 *   ayna     AP teli: usnews.com 8.786 kr · ca.news.yahoo.com 5.012 kr
 *   reuters  doğrudan `/arc/outboundfeeds/*` dışında HER uç 401 (DataDome) →
 *            yalnız ayna + wayback şansı; sitemap'te URL var, gövde yok
 *
 * Üç güvenlik ilkesi:
 *   1) Yalnız istenen haberin kendisi yazılır — ayna sonucunda BAŞLIK
 *      ÖRTÜŞMESİ şartı var, alakasız sayfa asla makale olmaz.
 *   2) Zaman damgası taze haberler arşivde henüz yoktur; boşuna bekleme
 *      yerine birkaç kopya denenir, host/route başına "futile" hafızası var.
 *   3) Arşiv ve arama motorları nazik kullanılır: sıraya alma + 429 geri
 *      çekilmesi, host başına arama üst sınırı.
 */

import { fetchPage, canonicalArticleUrl } from './http.js';
import {
  isChallengeResponse,
  isExpectedPublisherUrl,
  readabilityFromHtml,
  articleFromJinaMarkdown,
  resolveArticleUrl,
  sanitizeContent,
} from './enrich.js';

const int = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

/** Duvarı ölçülmüş yayıncılar (bunlar dışındakiler zaten kendi yolunda çözülüyor) */
export const RESCUABLE_HOSTS = new Set([
  'reuters.com', 'nytimes.com', 'apnews.com',
]);

const ENABLED = String(process.env.TELGRAF_RESCUE ?? '1') !== '0';
const WINDOW_MS = int(process.env.TELGRAF_RESCUE_MS, 240000);
const MAX_ITEMS = int(process.env.TELGRAF_RESCUE_LIMIT, 0); // 0 = sırada kim varsa
const WORKERS = int(process.env.TELGRAF_RESCUE_WORKERS, 4);
const MIN_TEXT = int(process.env.TELGRAF_RESCUE_MIN_TEXT, 700);
/** Ayna kabul eşiği: hedef başlığın ilk N anlamlı kelimesinin ne kadarı sayfada var */
const MIRROR_OVERLAP = Number.parseFloat(process.env.TELGRAF_RESCUE_OVERLAP ?? '0.5');
/** Arama motorunun aday URL için verdiği başlığın örtüşme eşiği (2. kanıt) */
const SEARCH_TITLE_OVERLAP = Number.parseFloat(process.env.TELGRAF_RESCUE_SEARCH_OVERLAP ?? '0.8');
/** (b) yolunda sayfanın kendisinde aranan en az örtüşme */
const MIN_PAGE_OVERLAP = Number.parseFloat(process.env.TELGRAF_RESCUE_MIN_PAGE_OVERLAP ?? '0.25');
/** Yayıncının kendi kopyasında beklenen başlık örtüşmesi (wayback/jina) */
const HEADLINE_OVERLAP = Number.parseFloat(process.env.TELGRAF_RESCUE_HEADLINE ?? '0.5');
/** Ayna yalnız tel (wire) ajanslarının yeniden yayınında kullanılsın */
const WIRE_ONLY = String(process.env.TELGRAF_RESCUE_WIRE_ONLY ?? '1') !== '0';
const MAX_SEARCHES = int(process.env.TELGRAF_RESCUE_MAX_SEARCHES, 45);
/** Bundan dolu bir kopya varsa arşivi daha fazla yoklama (istek kirası) */
const FULL_CAPTURE = int(process.env.TELGRAF_RESCUE_FULL_CAPTURE, 2500);
/** Ayna yolunda bir haber için en fazla kaç aday sayfası indirilir */
const MIRROR_TRIES = int(process.env.TELGRAF_RESCUE_MIRROR_TRIES, 3);
/** Aynı yeniden-yayıncıdan en fazla kaç aday sayfa indirilir */
const PER_HOST = int(process.env.TELGRAF_RESCUE_PER_HOST, 2);
/** Bu kadar haberden sonra ayna yolu o host için kapanır (boşuna aday indirmesin) */
const MIRROR_MISS_AFTER = int(process.env.TELGRAF_RESCUE_MIRROR_MISS_AFTER, 6);
/** Bir haber için arşive en fazla kaç yoklama (gecikme + kibarlık bütçesi) */
const WAYBACK_PROBES = int(process.env.TELGRAF_RESCUE_WB_PROBES, 4);

// Test/entegrasyon dikişleri: gerçek servisler yerine sahte sunucu verilebilir
const BASE = {
  wayback: process.env.TELGRAF_WAYBACK_BASE || 'https://web.archive.org',
  jina: process.env.TELGRAF_JINA_BASE || 'https://r.jina.ai',
};
/**
 * Arama motorları: sandıkta ölçüldü — Bing'in RSS ucu (`format=rss`) veri
 * merkezinden temiz sonuç veriyor, `html.duckduckgo.com` ise 202 ile JS
 * perdesi döndürebiliyor. Bu yüzden zincir: Bing → DDG.
 */
const SEARCHES = (process.env.TELGRAF_RESCUE_SEARCHES_URLS
  || 'https://www.bing.com/search?format=rss&q=|https://html.duckduckgo.com/html/?q=|https://lite.duckduckgo.com/lite/?q=')
  .split('|').map((x) => x.trim()).filter((x) => x.includes('q='));

const STOP = new Set(('a an the and or of to in on for at by with from as is are was were be been it its this that these those i you we they he she '
  + 'its his her their our your me him them us not but if then than so too also into over under out up down about after before between during '
  + 'says say said new year years day days week weeks month months').split(' '));

const state = {
  startedAt: 0,
  tried: 0,
  ok: 0,
  byRoute: new Map(), // yol -> { tried, ok }
  futile: new Map(), // "route|host" -> true (bu turda boşuna denendi)
  backoff: new Map(), // "route" -> until ts (429/509 sonrası)
  searches: 0,
  searchFails: 0,
  jinaTries: 0,
  throttled: 0,
  wbLast: 0,
  rejects: new Map(), // "yol|neden" -> adet (neden elendiği bilinmeden ayar yapılamıyor)
  failures: [],
};

const reset = () => ({
  tried: 0, ok: 0, byRoute: new Map(), futile: new Map(), backoff: new Map(),
  searches: 0, searchFails: 0, jinaTries: 0, throttled: 0, wbLast: 0, rejects: new Map(), failures: [],
});

/** Derleme raporundaki satır */
export function rescueStats() {
  const routes = {};
  for (const [k, v] of state.byRoute) routes[k] = `${v.ok}/${v.tried}`;
  return {
    enabled: ENABLED,
    tried: state.tried,
    ok: state.ok,
    routes,
    futile: state.futile.size,
    searches: state.searches,
    jinaTries: state.jinaTries,
    throttled: state.throttled,
    rejects: Object.fromEntries(
      [...state.rejects.entries()]
        .map(([k, v]) => [k.replace('|', ':'), v])
        .sort((a, b) => b[1] - a[1]),
    ),
    windowMs: WINDOW_MS,
    workers: WORKERS,
    elapsedMs: state.startedAt ? Date.now() - state.startedAt : 0,
    failures: state.failures.slice(0, 12),
  };
}

export function resetRescueState() {
  Object.assign(state, reset());
  state.startedAt = 0;
}

export function rescueEnabled() {
  return ENABLED && WINDOW_MS > 0;
}

export function rescueCapacity() {
  return { workers: WORKERS, maxItems: MAX_ITEMS, windowMs: WINDOW_MS, enabled: rescueEnabled() };
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function windowLeft() {
  if (!state.startedAt) state.startedAt = Date.now();
  return ENABLED ? WINDOW_MS - (Date.now() - state.startedAt) : 0;
}

/** Sırada kurtarma şansı olan haber mi? (duvarlı host + kendi başına kapız değil) */
export function rescuable(item) {
  if (!rescueEnabled()) return false;
  const link = String(item?.link || '');
  if (!/^https?:/.test(link)) return false;
  if (!RESCUABLE_HOSTS.has(hostOf(link))) return false;
  // Google News yönlendirmesiyse gerçek makale adresi bilinmiyor → ayna araması
  // yine de başlıkla çalışır, ama Wayback/jina için adres şart: çözüm deneriz.
  return true;
}

/** Yol bu hostta kaç KEZ taşıma hatası verdi? "kayıt yok" sayılmaz: Wayback'te
 *  404, haberin henüz arşivlenmediği demektir ve hostu kapatmamalı. */
const DOWN_AFTER = int(process.env.TELGRAF_RESCUE_DOWN_AFTER, 2);
/** Taşıma hatasından sonra yola verilecek nefes (ms): 0 => ara vermeden devam */
const COOLDOWN_MS = int(process.env.TELGRAF_RESCUE_COOLDOWN_MS, 12000);
/** Bu kadar kısıtlamadan sonra arşiv yolu bu derlemede kapatılır */
const THROTTLE_GIVEUP = int(process.env.TELGRAF_RESCUE_THROTTLE_GIVEUP, 4);
/** Arşiv istekleri arasına konulan nefes (ms) — 403 yememenin bedava yolu */
const WB_GAP_MS = int(process.env.TELGRAF_RESCUE_WB_GAP, 400);
/** En yavaş yol (jina ~30 sn/istek) için üst sınır — derleme süresini yemesin */
const JINA_MAX = int(process.env.TELGRAF_RESCUE_JINA_MAX, 14);

function isFutile(route, host) {
  const e = state.futile.get(`${route}|${host}`);
  if (e?.hard) return true;
  if (state.futile.get(`${route}|*`)?.hard) return true; // yol genel çöktü
  const until = state.backoff.get(route) || 0;
  return until > Date.now();
}

const nap = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wayback'te denenecek zaman damgaları: yakın kopya → yayım günü → önceki gün */
export function waybackStamps(published) {
  // '2' = en yakın kopya: her zaman bir şansı vardır (kopya varsa). Sonra yayım
  // günü ve ertesi gün damgaları gelir — en-yakın kopya bazen sonradan alınan
  // BLOKLU taramadır (AP'te ölçüldü), eski kopya temiz olur.
  const out = ['2'];
  const m = String(published || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const fmt = (x) => `${x.getUTCFullYear()}${String(x.getUTCMonth() + 1).padStart(2, '0')}${String(x.getUTCDate()).padStart(2, '0')}120000`;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    out.push(fmt(d));
    d.setUTCDate(d.getUTCDate() + 1);
    out.push(fmt(d)); // çoğu kopya bir gün sonra alınır
  }
  return out;
}

function plainWords(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function keyTokens(title, n = 8) {
  return String(title || '').toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w))
    .slice(0, n);
}

/** Başlık örtüşmesi: aday sayfa gerçekten aynı haber mi? */
export function titleOverlap(title, candidateText) {
  const keys = keyTokens(title);
  if (!keys.length) return 0;
  // tire/alt çizgi de ayraç: ayna URL'leri slug'lıdır ("pow-transfer")
  const hay = ` ${String(candidateText || '').toLowerCase().replace(/[^a-z0-9'\s]/g, ' ')} `;
  let hit = 0;
  for (const w of keys) if (hay.includes(` ${w} `)) hit += 1;
  return hit / keys.length;
}

/** Yayıncının kendi sayfası bile olsa kurtarılmış sayılamaz: hata/perde duvarı */
const NEGATIVE_RE = /page not found|not found|access denied|error 40[0-9]\b|just a moment|enable (?:javascript|js)|are you (?:a )?(?:human|robot)|captcha|challenge|subscribe to (?:continue|read)|registration required|please (?:log in|enable)|403 forbidden|401 unauthorized/i;

/**
 * Kurtarılan sayfa gerçekten ARANAN haber mi? Üç kontrol birden:
 * uzunluk (menü çubuğu tuzak), olumsuz başlık (404/perde), başlık örtüşmesi.
 * Örtüşme, yayıncının kendi kopyasında yüksek (0.5), aynada daha da yüksek
 * (MIRROR_OVERLAP), çünkü ayna sayfaları farklı habere benzeyebiliyor.
 */
function acceptable(art, it, minOverlap) {
  if (!art?.content) return false;
  const words = plainWords(art.content);
  if (words.length < MIN_TEXT) return false;
  const t = String(art.title || '');
  if (NEGATIVE_RE.test(t)) return false;
  const overlap = titleOverlap(it.title || '', words.slice(0, 2500));
  if (overlap < minOverlap) return false;
  art.headlineOverlap = Number(overlap.toFixed(2));
  return true;
}

/**
 * Yol sırası hosta göre: Reuters'ın bugünkü haberi arşivde henüz yoktur ama
 * teli aynen yayımlanır → ayna önce. AP'te en verimli yol Wayback (ölçüldü:
 * 46 kr temiz metin, 1.2-2.8 sn). NYT'de tel aynası ve jina yok → yalnız arşiv.
 */
const ROUTE_ORDER = {
  'reuters.com': ['mirror', 'wayback', 'jina'],
  'apnews.com': ['wayback', 'mirror', 'jina'],
  'nytimes.com': ['wayback', 'mirror'],
};
const ROUTES = ['wayback', 'mirror', 'jina'];
const routesFor = (host) => ROUTE_ORDER[host] || ROUTES;

/** Bir haberin kurtarmasına ayrılan en fazla süre (pencereyi tek haber doldurmasın) */
const ITEM_MS = int(process.env.TELGRAF_RESCUE_ITEM_MS, 30000);
let deadlineAt = 0;
const openDeadline = () => { deadlineAt = Date.now() + ITEM_MS; };
const left = () => Math.min(windowLeft(), deadlineAt - Date.now());

function reject(route, why) {
  state.rejects.set(`${route}|${why}`, (state.rejects.get(`${route}|${why}`) || 0) + 1);
}

function note(route, ok, why) {
  const r = state.byRoute.get(route) || { tried: 0, ok: 0 };
  r.tried += 1;
  if (ok) r.ok += 1;
  state.byRoute.set(route, r);
  if (!ok && why && state.failures.length < 60) state.failures.push(`${route}:${why}`.slice(0, 90));
}

/* ------------------------------ yollar ------------------------------ */

/* Hata sınıflandırması: "kayıt yok" (boş) ile "yol bu hostta ölü" (down) farklı
 * şeylerdir. Wayback'te 404, haberin henüz arşivlenmediği anlamına gelir — hostu
 * kapatmak yanlış olur (run'da 12 haberden 10'u böyle yakıldı). */
const DOWN = (why) => ({ __down: true, why: String(why).slice(0, 60) });
const EMPTY = (why) => ({ __empty: true, why: String(why).slice(0, 60) });

function failKind(route, host, res) {
  if (res?.__down) {
    const key = `${route}|${host}`;
    const prev = state.futile.get(key)?.n || 0;
    state.futile.set(key, { why: res.why, n: prev + 1, hard: prev + 1 >= DOWN_AFTER || !!res.global });
    if (res.global) state.futile.set(`${route}|*`, { why: res.why, n: prev + 1, hard: true });
    note(route, false, res.why);
  } else if (res?.__empty) {
    note(route, false, res.why);
  }
}

/**
 * 1) Wayback Machine. `id_` ham kopya verir (arayüz çubuğu/rewriting yok).
 *    Tuzak: en yakın kopya bazen DUVAR sayfasının kendisidir veya sayfanın
 *    iskeletidir; o yüzden birden çok damga denenir ve EN ZENGİN olan seçilir.
 *    Damga sırası: '2' (en yakın) → yayım günü → ertesi gün.
 */
/**
 * Arşiv yoklamaları: kanonik adresin yakın kopyası en yüksek şansı verir;
 * adres tireliyse (NYT) ham biçim de denenir — arşiv anahtarı bazen öyle.
 */
export function waybackProbes(realUrl, item, canonical) {
  const forms = [realUrl];
  try {
    const c = canonical ? canonical(realUrl) : realUrl;
    if (c && c !== realUrl) forms.push(c);
  } catch { /* tek biçim yeter */ }
  const out = [];
  for (const ts of waybackStamps(item.published)) {
    for (const u of forms) {
      out.push({ ts, url: u });
      if (out.length >= WAYBACK_PROBES) break;
    }
    if (out.length >= WAYBACK_PROBES) break;
  }
  return out;
}

/** Kopya mı geldi, hiçbir şey mi? (404/410 = arşivde yok; 403/5xx = erişim sorunu) */
const isCapture = (status) => status === 200 || status === 302;
const isThrottled = (r) => r.status === 429 || r.status === 503 || r.status === 509 || (!r.status && !!r.err);

async function viaWayback(realUrl, item, host) {
  if (isFutile('wayback', host)) return { __down: false, __empty: true, why: 'wayback kapalı' };
  let miss = 0;
  let best = null;
  const probes = waybackProbes(realUrl, item, canonicalArticleUrl);
  for (let i = 0; i < probes.length; i += 1) {
    if (left() < 7000) break; // tek kopya denemesi bile yetmeyecekse kalk
    const url = `${BASE.wayback}/web/${probes[i].ts}id_/${probes[i].url}`;
    // arşive karşı naziklik: istekler arasına nefes
    const wait = state.wbLast + WB_GAP_MS - Date.now();
    if (wait > 0) await nap(wait);
    state.wbLast = Date.now();
    let r = await fetchPage(url, { timeoutMs: Math.min(14000, Math.max(5000, left())), hostLane: 'page' });
    // Arşivin CDN'i bazen 403/429 atıyor (Fastly 54113) — aynı damgada bir tekrar
    if (!isCapture(r.status) && left() > 9000) {
      await nap(1200);
      r = await fetchPage(url, { timeoutMs: Math.min(14000, Math.max(4000, left())), hostLane: 'page' });
    }
    if (isThrottled(r)) {
      // Kısıtlama hostun suçu değil: arşivin bizden istek kirasını artırması.
      // Nefes ver + sayaç dolduysa yolu tüm derleme için kapat; hostu kapatma.
      state.backoff.set('wayback', Date.now() + COOLDOWN_MS);
      state.throttled += 1;
      reject('wayback', `kısılama ${r.status || 'aşımsa'}`);
      if (state.throttled >= THROTTLE_GIVEUP) {
        state.futile.set('wayback|*', { why: `arşiv ${state.throttled}×kısılama`, n: state.throttled, hard: true });
      }
      return EMPTY(`arşiv ${r.status || 'yavaş'}`);
    }
    if (!r.ok || !r.body) {
      // 403/5xx: kayıt yokluğundan farklı — nefes ver, yolu yavaşlat
      if (r.status === 403 || r.status >= 500) {
        state.backoff.set('wayback', Date.now() + COOLDOWN_MS);
        state.throttled += 1;
        reject('wayback', `erişim ${r.status}`);
        if (state.throttled >= THROTTLE_GIVEUP) {
          state.futile.set('wayback|*', { why: `arşiv ${state.throttled}×403`, n: state.throttled, hard: true });
        }
        return EMPTY(`arşiv ${r.status}`);
      }
      miss += 1;
      reject('wayback', r.status === 404 || r.status === 410 ? 'kayıt yok' : `http ${r.status || 0}`);
      continue;
    }
    if (isChallengeResponse(r.body)) { miss += 1; reject('wayback', 'perde kopyası'); continue; }
    let art;
    try {
      art = await readabilityFromHtml(r.body, realUrl, item);
    } catch { miss += 1; reject('wayback', 'çıkarılamadı'); continue; }
    if (!acceptable(art, item, HEADLINE_OVERLAP)) {
      miss += 1;
      reject('wayback', NEGATIVE_RE.test(String(art.title || '')) ? 'hata sayfası' : 'başlık örtüşmedi');
      continue;
    }
    art.snapshotUrl = r.finalUrl || url;
    art.via = 'wayback';
    const len = plainWords(art.content).length;
    if (!best || len > best.__len) { best = art; best.__len = len; }
    if (best.__len > FULL_CAPTURE) break; // yeterince dolu: fazlasına gerek yok
  }
  if (!best) return EMPTY(miss ? `kayıt yok (${miss} damga)` : 'kayıt yok');
  delete best.__len;
  return best;
}

/**
 * 2) Ayna: AP/Reuters teli yüzlerce yayıncıda AYNEN yayımlanır. Yalnız
 *    telifli tel metni kabul edilir — ölçülmüş tuzak: NYT haberi için çıkan
    blog      aynası (joemygod.com) alıntılıyordu, makale değildi. Tel etiketi
 *    ("(Reuters)", "(AP)", "Associated Press") doğrulamanın kendisidir.
 */
const WIRE_RE = /\((?:Reuters|AP|AFP|PA Media|Bloomberg|KYODO|DPA|ANI)\)|\b(?:Associated Press|Reuters Holdings|Thai (?:News|Agency)|Arab News \(Reuters\)|by the Associated Press)\b/i;
/** Host → tel ajansı adı (arama sorgusuna eklenir; telif satırıyla doğrulanır) */
const WIRE_NAME = { 'reuters.com': 'Reuters', 'apnews.com': 'AP' };

const MIRROR_DENY = /blogspot\.|medium\.com|tumblr\.com|wordpress\.com|quora\.com|pinterest|facebook\.com|x\.com|reddit|joemygod|marginalia/i;

function searchLinks(html) {
  const out = [];
  // Bing RSS: <item><title>…</title><link>https://…</link> — başlık ayrıca
  // taşınır: yeniden-yayında sayfanın kendi başlığı değiştirilmiş olabilir, ama
  // arama motorunun o URL için verdiği başlık ayrı ve güçlü bir kanıttır.
  const titles = new Map();
  for (const it of String(html).matchAll(/<item>[\s\S]*?<\/item>/g)) {
    const t = (it[0].match(/<title>\s*([\s\S]*?)\s*<\/title>/i) || [])[1] || '';
    const l = (it[0].match(/<link>\s*(https?:\/\/[^\s<]+)\s*<\/link>/i) || [])[1];
    if (l && t) titles.set(l, t.replace(/<!\[CDATA\[|\]\]>/g, '').trim());
  }
  for (const m of String(html).matchAll(/<link>\s*(https?:\/\/[^\s<]+)\s*<\/link>/g)) out.push(m[1]);
  for (const m of String(html).matchAll(/[?&](?:uddg|u)=([^"'&][^"']*)/g)) {
    try {
      const x = decodeURIComponent(String(m[1]).replace(/&.*$/, '').replace(/&amp;/g, '&'));
      if (/^https?:/.test(x)) out.push(x);
    } catch { /* bozuk kodlama */ }
  }
  for (const m of String(html).matchAll(/href="(https?:\/\/[^"]+)"/g)) out.push(m[1]);
  const ENGINE = /duckduckgo|bing\.com|google\.|yandex|brave\.|ddg|archive\.org|webcache|microsoft\.com/i;
  const urls = [...new Set(out)].filter((u) => /^https?:\/\//.test(u) && !ENGINE.test(hostOf(u)));
  return { urls, titles };
}

async function viaMirror(realUrl, item, host) {
  if (isFutile('mirror', '*') || isFutile('mirror', host)) return EMPTY('ayna kapalı');
  if (state.searches >= MAX_SEARCHES) return EMPTY('arama kotası');
  const title = item.title || '';
  if (keyTokens(title).length < 3) return EMPTY('başlık zayıf');
  state.searches += 1;
  state.queries += 1;
  await nap(400); // arama motorunu zorlama
  let cands0 = [];
  let searchTitles = new Map();
  let transport = 0;
  // Sorgu ajans adıyla da denenir: yeniden-yayıncılar teli "(Reuters)"/"(AP)"
  // damgasıyla ve başlığın ilk yarısıyla basar. Yalnız tırnaklı tam başlık,
  // bizim için erişilmez olan yayıncının kendi sayfasını öne çıkarıyor.
  const agency = WIRE_NAME[host] || '';
  const queries = [`"${title.slice(0, 90)}"`];
  if (agency) {
    queries.push(`"${title.slice(0, 60)}" ${agency}`);
    queries.push(`${title.slice(0, 60)} ${agency}`);
  }
  for (const q of queries) {
    if (state.queries >= MAX_SEARCHES * 2) break; // arama motoruna sınırsız yük bindirme
    if (q !== queries[0]) await nap(250);
    state.queries += 1;
    for (const base of SEARCHES) {
      const s = await fetchPage(`${base}${encodeURIComponent(q)}`, { timeoutMs: 15000, hostLane: 'page' });
      if (!s.ok) { transport += 1; continue; }
      const parsed = searchLinks(s.body);
      cands0 = parsed.urls;
      if (parsed.urls.length) { searchTitles = parsed.titles; break; }
    }
    if (cands0.length) break;
  }
  if (!cands0.length) {
    // Motorların hepsi patladıysa yol ölü; boş döndüyse haberde ayna yok
    return transport >= SEARCHES.length ? DOWN(`arama ${transport}/${SEARCHES.length}`) : EMPTY('ayna adayı yok');
  }
  const self = hostOf(realUrl);
  // Önce sırala: URL'si başlıkla en çok kelime paylaşan aday en önce gider.
  const ranked = cands0
    .map((u) => ({ u, h: hostOf(u), score: titleOverlap(title, decodeURIComponent(String(u).replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, ''))) }))
    .filter((x) => x.h && x.h !== self && !RESCUABLE_HOSTS.has(x.h) && !MIRROR_DENY.test(x.h))
    .sort((a, b) => b.score - a.score);
  const perHost = new Map();
  const cands = [];
  for (const x of ranked) {
    // Host başına en fazla 2 aday: sıralama doğru haberi her zaman öne
    // çıkarmıyor, ama aynı yayıncıya da yüklenmiyoruz.
    const n = perHost.get(x.h) || 0;
    if (n >= PER_HOST) continue;
    perHost.set(x.h, n + 1);
    cands.push(x.u);
    if (cands.length >= 4) break;
  }
  let bad = 0;
  for (const c of cands.slice(0, MIRROR_TRIES)) {
    if (left() < 6000) break;
    const b = await fetchPage(c, { timeoutMs: Math.min(12000, Math.max(4000, left())), hostLane: 'page' });
    if (!b.ok) { bad += 1; reject('mirror', `http ${b.status || 0}`); continue; }
    if (isChallengeResponse(b.body)) { bad += 1; reject('mirror', 'perde'); continue; }
    let art;
    try {
      art = await readabilityFromHtml(b.body, c, item);
    } catch { bad += 1; reject('mirror', 'çıkarılamadı'); continue; }
    // İki kanıt yolu: (a) sayfanın kendi metni başlıkla örtüşür, ya da
    // (b) arama motorunun bu URL için verdiği başlık güçlü şekilde örtüşür ve
    // sayfa da tamamen alakasız değildir. (b) yeniden-yayınlarda gerekli:
    // "FHFA: home prices rise" başlıklı kopya, "(Reuters)" teliyle aynı haberdir.
    const o = acceptable(art, item, MIRROR_OVERLAP);
    const sTitle = searchTitles.get(c) || '';
    const oSearch = sTitle ? titleOverlap(title, sTitle) : 0;
    if (!o && !(oSearch >= SEARCH_TITLE_OVERLAP && acceptable(art, item, MIN_PAGE_OVERLAP))) {
      bad += 1;
      reject('mirror', NEGATIVE_RE.test(String(art.title || '')) ? 'hata sayfası'
        : oSearch >= SEARCH_TITLE_OVERLAP ? 'sayfa zayıf' : 'başlık örtüşmedi');
      continue;
    }
    const words = plainWords(art.content);
    // TEL KAYNAĞI DOĞRULAMASI: ayna, teli kendi adıyla yayımlamış olmalı
    if (WIRE_ONLY && !WIRE_RE.test(`${art.title || ''} ${words.slice(0, 1600)}`)) { bad += 1; reject('mirror', 'tel etiketi yok'); continue; }
    art.mirrorUrl = c;
    art.mirrorOverlap = Math.max(art.headlineOverlap || 0, Number(oSearch.toFixed(2)));
    art.mirrorEvidence = o ? 'page' : 'search-title';
    art.via = `mirror:${hostOf(c)}`;
    art.title = item.title || art.title; // kart başlığı korunur (ayna başlığı değişebilir)
    return art;
  }
  // Aday vardı ama hiçbiri aynı haber çıkmadı → bu hostun aynası yok (NYT ölçümü)
  if (bad) {
    const key = `mirror|${host}`;
    const prev = state.futile.get(key)?.n || 0;
    state.futile.set(key, { why: `ayna tutmadı (${bad} aday)`, n: prev + 1, hard: prev + 1 >= MIRROR_MISS_AFTER });
  }
  return EMPTY(bad ? `ayna tutmadı (${bad} aday)` : 'ayna tutmadı');
}

/**
 * 3) jina okuyucusu, `X-Wait-For-Selector: p` ile: Cloudflare'in "Just a
 *    moment" perdesini kendi tarafında bekleyip geçebiliyor (AP'te ölçüldü).
 *    Düz jina çağrısı enrich'te zaten denendiği için yalnız beklemeli varyant
 *    denenir; perde/başlık uyuşmazlığında bir kez yeniden denenir.
 */
async function viaJina(realUrl, item, host) {
  if (isFutile('jina', host) || isFutile('jina', '*')) return EMPTY('jina kapalı');
  if (state.jinaTries >= JINA_MAX) return EMPTY('jina kotası');
  let last = EMPTY('jina denemedi');
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (windowLeft() < 20000 || left() < 8000) break;
    state.jinaTries += 1;
    if (state.jinaTries > 1 && windowLeft() < 60000) break; // retry lüksü yok
    const r = await fetchPage(`${BASE.jina}/${realUrl}`, {
      timeoutMs: Math.min(35000, Math.max(12000, windowLeft())),
      hostLane: 'page',
      headers: { 'X-Return-Format': 'markdown', 'X-Wait-For-Selector': 'p', 'X-Timeout': '25' },
    });
    if (r.status === 402 || r.status === 429 || r.status === 451) {
      return { ...DOWN(`jina kota ${r.status}`), global: true };
    }
    if (!r.ok || !r.body) { last = DOWN(`jina http ${r.status || 'yok'}`); break; }
    try {
      const art = articleFromJinaMarkdown(r.body, item, realUrl);
      if (!acceptable(art, item, HEADLINE_OVERLAP)) {
        const blocked = NEGATIVE_RE.test(String(art.title || ''));
        // Perde/hata sayfası yayıncının jina'yı da kesmesi demek → hostu kapat.
        // Başlık uyuşmazlığı (yanlış sayfa) tek haberle ilgilidir → tekrar dene.
        last = blocked ? DOWN('jina perde/hata sayfası') : EMPTY('jina başlık örtüşmedi');
        if (blocked) break;
        if (attempt === 1 && left() > 45000) { await nap(2500); continue; }
        break;
      }
      art.via = 'jina';
      return art;
    } catch (e) {
      const msg = String(e.message || e);
      last = /too short|challenge/.test(msg) ? EMPTY(`jina ${msg.slice(0, 40)}`) : DOWN(`jina ${msg.slice(0, 40)}`);
      if (last.__empty && attempt === 1) { await nap(2500); continue; }
      break;
    }
  }
  return last;
}

/* ---------------------------- ana giriş ---------------------------- */

/**
 * Duvarlı yayıncının makalesini alternatif yolla getirir.
 * @returns {Promise<object>} { content, via, ... } — bulunamazsa throws
 */
export async function rescueArticle(item) {
  if (!rescueEnabled()) throw new Error('rescue disabled');
  if (windowLeft() < 15000) {
    const e = new Error('rescue window closed');
    e.reason = 'rescue-window';
    throw e;
  }
  if (MAX_ITEMS && state.tried >= MAX_ITEMS) {
    const e = new Error('rescue limit reached');
    e.reason = 'rescue-limit';
    throw e;
  }
  const link = String(item?.link || '');
  const host = hostOf(link);
  if (!RESCUABLE_HOSTS.has(host)) {
    const e = new Error('host not rescuable');
    e.reason = 'rescue-na';
    throw e;
  }
  state.tried += 1;
  openDeadline();

  // Gerçek makale adresi: Google News yönlendirmeleriyse çöz (batch/HTTP)
  let realUrl = link;
  try { realUrl = await resolveArticleUrl(link); } catch { /* link ile dene */ }
  if (!isExpectedPublisherUrl(item.source, realUrl)) realUrl = link;
  realUrl = canonicalArticleUrl(realUrl) || realUrl;

  const failures = [];
  for (const route of routesFor(host)) {
    if (windowLeft() < 15000) { failures.push('pencere kapandı'); break; }
    if (left() < 6000) { failures.push('haber bütçesi'); break; }
    try {
      const art = route === 'wayback' ? await viaWayback(realUrl, item, host)
        : route === 'mirror' ? await viaMirror(realUrl, item, host)
          : await viaJina(realUrl, item, host);
      if (art?.content) {
        note(route, true);
        state.ok += 1;
        return {
          ...art,
          excerpt: art.excerpt || item.summary || '',
          author: art.author || item.author || '',
          image: art.image || item.image || '',
          resolvedUrl: realUrl !== item.link ? realUrl : item.link,
          rescuedBy: route,
        };
      }
      // Yol başarısız: "kayıt yok" haberle, "ölü" hostla ilgilidir — ikincisi
      // hatırlanır (aynı hostta bir daha denenmez), birincisi unutulur.
      const why = art?.why || 'yok';
      failures.push(`${route}: ${why}`);
      failKind(route, host, art);
    } catch (e) {
      const msg = String(e.message || e).slice(0, 50);
      failures.push(`${route}: ${msg}`);
      // Beklenmedik hata hostu kapatmaz; ancak zaman aşımı/kapalı bağlantı kapatır
      failKind(route, host, /timeout|aborted|ECONN|ENOTFOUND|socket/i.test(msg) ? DOWN(msg) : EMPTY(msg));
    }
  }
  // Aynı haberde birden çok yol "ölü" raporu verdiyse sıradaki haberlere geçmeyelim
  for (const route of ROUTES) if (isFutile(route, host)) note(route, false, `${host} kapandı`);
  const err = new Error(failures.join('; ').slice(0, 200) || 'no rescue route worked');
  err.reason = 'rescue-empty';
  throw err;
}

/** Rapor satırı: `kurtarma: denenen=.. geçen=.. · wayback=2/6 · ayna=4/5 ...` */
export function rescueLine() {
  const s = rescueStats();
  if (!s.enabled) return 'kurtarma: kapalı';
  const r = Object.entries(s.routes).map(([k, v]) => `${k}=${v}`).join(' · ');
  const rej = Object.entries(s.rejects || {}).filter(([, n]) => n > 1)
    .slice(0, 6).map(([k, n]) => `${k}:${n}`).join(',');
  return `kurtarma: denenen=${s.tried} geçen=${s.ok} arama=${s.searches} jina-istek=${s.jinaTries} kısıtlama=${s.throttled} kapalı-host=${s.futile}`
    + ` süre=${Math.round(s.elapsedMs / 1000)}/${Math.round(s.windowMs / 1000)}sn${r ? ` · ${r}` : ''}`
    + (rej ? ` · red[${rej}]` : '');
}

export const _test = { state, plainWords, searchLinks, reset };
