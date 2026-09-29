// HTTP çekirdeği — tarayıcı parmak izli istemci (got-scraping: Chrome TLS/JA3 +
// HTTP/2 taklidi). Hedef: bot duvarlarına karşı el yazısı başlıklardan çok daha
// etkili, tarayıcı açmadan saniyeler içinde çekim.
//
// Ayrıca:
//   - host başına eşzamanlılık sınırı (ban riski)
//   - üst üste yenilen host için fail-fast blok listesi (kötü host bütçe yemesin)
//   - test dikişi (setHttpClient) — birim testleri ağsız çalışır
import { gotScraping } from 'got-scraping';

const HOST_CONCURRENCY = 6;
const STRIKES_TO_BLOCK = 3;

const hostState = new Map(); // host -> { active, queue, strikes, blocked }

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

function stateOf(url) {
  const host = hostOf(url);
  if (!hostState.has(host)) hostState.set(host, { active: 0, queue: [], strikes: 0, blocked: false });
  return hostState.get(host);
}

export function isHostBlocked(url) {
  return stateOf(url).blocked;
}

/** Hata sayacı: art arda STRIKES_TO_BLOCK başarısızlıkta host bu süreçte bloklanır */
export function noteHostFailure(url) {
  const s = stateOf(url);
  s.strikes += 1;
  if (s.strikes >= STRIKES_TO_BLOCK) s.blocked = true;
}

export function noteHostSuccess(url) {
  stateOf(url).strikes = 0;
}

async function withHostSlot(url, fn) {
  const s = stateOf(url);
  if (s.active >= HOST_CONCURRENCY) {
    await new Promise((r) => s.queue.push(r));
  }
  s.active += 1;
  try {
    return await fn();
  } finally {
    s.active -= 1;
    const next = s.queue.shift();
    if (next) next();
  }
}

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
 */
export async function fetchPage(url, opts = {}) {
  return withHostSlot(url, () => client(url, opts));
}
