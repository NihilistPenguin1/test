// HTTP çekirdeği — tarayıcı parmak izli istemci (got-scraping: Chrome TLS/JA3 +
// HTTP/2 taklidi) + şerit (lane) planlayıcısı.
//
// Neden şerit? Besleme indirme, tam metin çekimi ve görsel denetimi aynı süreçte
// koşuyor. Tek bir havuzu paylaşırlarsa en yavaş aşama diğerlerini bekletiyor
// (takılma). Şerit başına host/global limitler ayrı tutulunca görsel trafiği
// makale trafiğini kilitleyemez; toplam yük de sınırda kalır.
//
// Duvar hatırası: bir host düz HTTP'ye art arda 401/403 veriyorsa o hostta
// denemek her makalede 7-12 sn kaybettirir; doğrudan katman bir süre atlanır.
// ÖNEMLİ: bu hatıra YALNIZCA düz HTTP katmanını kapatır — tarayıcı (stealth)
// denemesi her zaman yapılır, çünkü 401/403 tam da tarayıcının çözdüğü sinyaldir.
// 429/503 gibi geçici sinyaller daha kısa bir geri çekilme alır.
//
// Test dikişi: setHttpClient ile birim testleri ağsız çalışır.
import { gotScraping } from 'got-scraping';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- şerit limitleri ---------- */

// Şeritler host havuzunu PAYLAŞIR: host başına toplam sınır asıl bindiren
// kısıttır (yayıncı hız sınırları host başınadır, şerit başına değil). Şerit
// alt limitleri ise hiçbir aşamanın host havuzunu tek başına kilitlemesini
// engeller — görsel denetimi makaleleri bekletmez, makaleler de görselleri.
function envNum(name, fallback) {
  const v = Number(process.env[`TELGRAF_HTTP_${name}`] || '');
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const DEFAULTS = {
  feed: { host: 2, global: 16 },   // RSS/Atom: sağlayıcıyı yorma
  page: { host: 4, global: 40 },   // makale/oembed/jina
  image: { host: 4, global: 56 },  // görsel denetimi: ucuz ve çok sayıda
};
const HOST_TOTAL = envNum('HOST_TOTAL', 6);          // host başına toplam eşzamanlılık
const HOST_MIN_GAP_MS = envNum('HOST_MIN_GAP', 150); // aynı hosta istekler arası nefes

function laneLimits(lane) {
  const base = DEFAULTS[lane] || DEFAULTS.page;
  const up = lane.toUpperCase();
  return {
    host: envNum(`LANE_${up}_HOST`, base.host),
    global: envNum(`LANE_${up}`, base.global),
  };
}

/* ---------- duvar hatırası ---------- */

// Kalıcı duvar: yayıncı veri merkezi IP'mizi düz istemciye kapamış
const HARD_WALL = new Set([401, 403, 407, 409, 451]);
// Geçici duvar: hız sınırı/bakım — kısa geri çekilme, sonra tekrar dene
const SOFT_WALL = new Set([429, 500, 502, 503, 504]);
const WALL_STRIKES = 3;
const WALL_TTL_MS = envNum('WALL_TTL', 2) * 60 * 1000;
const SOFT_TTL_MS = envNum('SOFT_TTL', 45) * 1000;
const NET_STRIKES = 6;
const NET_TTL_MS = envNum('NET_TTL', 3) * 60 * 1000;

/* ---------- durum ---------- */

const hosts = new Map(); // host -> { strikes, net, until, why, ok, fail, lanes }
const counters = new Map(); // lane -> { active, waiters }

const stats = { requests: 0, skipped: 0, waits: 0, byLane: {} };

function hostKey(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

function stateOf(url) {
  const host = hostKey(url);
  let s = hosts.get(host);
  if (!s) {
    s = {
      strikes: 0, net: 0, until: 0, why: '', ok: 0, fail: 0, lanes: new Map(),
      total: { active: 0, waiters: [] }, lastHit: 0,
    };
    hosts.set(host, s);
  }
  return s;
}

function laneState(s, lane) {
  if (!s.lanes.has(lane)) s.lanes.set(lane, { active: 0, waiters: [] });
  return s.lanes.get(lane);
}

function globalCounter(lane) {
  if (!counters.has(lane)) counters.set(lane, { active: 0, waiters: [] });
  return counters.get(lane);
}

async function acquire(c, limit) {
  for (;;) {
    if (c.active < limit) { c.active += 1; return; }
    stats.waits += 1;
    await new Promise((r) => c.waiters.push(r));
  }
}

function release(c) {
  c.active -= 1;
  const next = c.waiters.shift();
  if (next) next();
}

/** Şerit içinde sıra bekle: önce host limiti (kaynağı korur), sonra global limit. */
async function withSlot(lane, url, fn) {
  const limits = laneLimits(lane);
  const s = stateOf(url);
  const hostLane = laneState(s, lane);
  const glob = globalCounter(lane);
  // Sabit sıralama (host toplam → şerit host → şerit global) kilitlenmeyi imkânsız kılar.
  await acquire(s.total, HOST_TOTAL);
  let hostLaneHeld = false;
  try {
    // Aynı hosta arka arkaya gelişleri yumuşat: 403/429 davet etmeyelim
    const wait = s.lastHit + HOST_MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    s.lastHit = Date.now();
    await acquire(hostLane, limits.host);
    hostLaneHeld = true;
    await acquire(glob, limits.global);
  } catch (e) {
    if (hostLaneHeld) release(hostLane);
    release(s.total);
    throw e;
  }
  try {
    return await fn();
  } finally {
    release(glob);
    release(hostLane);
    release(s.total);
  }
}

/* ---------- hatıra güncelleme ---------- */

function noteResponse(url, res, { countWalls = true } = {}) {
  const s = stateOf(url);
  if (!res) return;
  if (!countWalls) {
    // varlık (görsel) istekleri ayrı muamele görür: bir CDN 403'ü tüm yayıncıyı
    // duvar ilan etmemeli — makale yolu bazen açık oluyor (Reuters örneği)
    s[res.ok ? 'ok' : 'fail'] += 1;
    return;
  }
  if (res.ok) {
    s.strikes = 0;
    s.net = 0;
    s.until = 0;
    s.why = '';
    s.ok += 1;
    return;
  }
  s.fail += 1;
  if (HARD_WALL.has(res.status)) {
    s.strikes += 1;
    if (s.strikes >= WALL_STRIKES) {
      s.until = Date.now() + WALL_TTL_MS;
      s.why = `http${res.status}`;
    }
  } else if (SOFT_WALL.has(res.status)) {
    // Tek 429 bile yeter: anlık hız sınırı, kısa geri çekilme mantıklı
    s.until = Math.max(s.until, Date.now() + SOFT_TTL_MS);
    s.why = `http${res.status}`;
  } else {
    s.strikes += 1;
  }
}

/** Ağ hatası (timeout/DNS/bağlantı) — aynı hostta art arda tekrarlanmazsa denemeye devam */
function noteTransportFailure(url) {
  const s = stateOf(url);
  s.fail += 1;
  s.net += 1;
  if (s.net >= NET_STRIKES) {
    s.until = Math.max(s.until, Date.now() + NET_TTL_MS);
    s.why = s.why || 'network';
  }
}

/** Dışarıdan bilgi: yayıncı yanıtı içerik gibi görünse de duvar ise duvar say. */
export function noteWall(url, why = 'challenge') {
  const s = stateOf(url);
  s.strikes += 1;
  if (s.strikes >= WALL_STRIKES) {
    s.until = Date.now() + WALL_TTL_MS;
    s.why = why;
  }
}

/** Geri bildirim: duvar açıldı (tarayıcı başardı) → düz HTTP'ye tekrar şans ver */
export function noteHostSuccess(url) {
  const s = stateOf(url);
  s.strikes = 0;
  s.net = 0;
  s.until = 0;
  s.why = '';
  s.ok += 1;
}

/** @deprecated anlamsızlığı önlemek için: artık yalnız sayım; duvar kararını fetchPage verir */
export function noteHostFailure(url) {
  stateOf(url).fail += 1;
}

/** Doğrudan (düz HTTP) deneme bu hostta şu an anlamsız mı? */
export function isHostBlocked(url) {
  const s = stateOf(url);
  return s.until > Date.now();
}

export const isDirectFutile = isHostBlocked;

/** Neden atlanıyor: http403 / http429 / network / challenge … */
export function wallReason(url) {
  const s = stateOf(url);
  return s.until > Date.now() ? s.why || 'wall' : '';
}

export function httpStats() {
  const perHost = {};
  for (const [host, s] of hosts) {
    if (s.until > Date.now() || s.strikes || s.net) {
      perHost[host] = { ok: s.ok, fail: s.fail, strikes: s.strikes, until: s.until > Date.now() ? s.why : '' };
    }
  }
  return { ...stats, byLane: { ...stats.byLane }, perHost };
}

/** Atlanan doğrudan/jina denemesi — teşhis için sayılır. */
export function noteSkip() {
  stats.skipped += 1;
}

/** Birim testleri/oturumlar arası temizlik */
export function resetHostState() {
  hosts.clear();
  for (const c of counters.values()) { c.active = 0; c.waiters.length = 0; }
  stats.requests = 0;
  stats.skipped = 0;
  stats.waits = 0;
  stats.byLane = {};
}

/* ---------- istemci ---------- */

async function defaultClient(url, opts = {}) {
  const res = await gotScraping({
    url,
    method: 'GET',
    throwHttpErrors: false,
    followRedirect: true,
    timeout: { request: opts.timeoutMs || 7000 },
    headers: opts.headers || {},
    ...(opts.accept === 'text' ? { responseType: 'text' } : {}),
  });
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    body: res.body,
    finalUrl: res.redirectUrls?.length ? res.url : (res.url || url),
    headers: res.headers,
  };
}

let client = defaultClient;

/** Birim testleri için istemci takası */
export function setHttpClient(fn) { client = fn; }
export function resetHttpClient() { client = defaultClient; }

/**
 * Sayfa/metin çekimi. Döner: { ok, status, body, finalUrl, headers }
 * opts.lane: 'page' (varsayılan) | 'image' | 'feed'
 */
export async function fetchPage(url, opts = {}) {
  const lane = opts.lane && DEFAULTS[opts.lane] ? opts.lane : 'page';
  stats.requests += 1;
  stats.byLane[lane] = (stats.byLane[lane] || 0) + 1;
  return withSlot(lane, url, async () => {
    try {
      const res = await client(url, opts);
      noteResponse(url, res, { countWalls: lane !== 'image' });
      return res;
    } catch (e) {
      if (lane !== 'image') noteTransportFailure(url);
      throw e;
    }
  });
}

/** paralel aşamaların şerit ayarını dışarıdan okunabilir kıl (teşhis + build notu) */
export function laneConfig() {
  return { hostTotal: HOST_TOTAL, minGapMs: HOST_MIN_GAP_MS, lanes: Object.fromEntries(Object.keys(DEFAULTS).map((l) => [l, laneLimits(l)])) };
}
