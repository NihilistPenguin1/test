// Stealth tarayıcı katmanı — challenge/captcha geçme denemeleri
//
// Amaç: düz fetch'in 403/429/challenge ile tıkandığı yayıncılarda (Reuters, AP,
// NYT, France24, Sky...) gerçek tarayıcı oturumuyla içeriğe ulaşmak.
//
// Strateji yığını (her URL için sırayla denenir):
//   1) Tek oturum + challenge sayfasında BEKLEME (managed challenge çoğu zaman
//      temiz tarayıcıda kendiliğinden geçer)
//   2) Turnstile / reCAPTCHA / hCaptcha onay kutusuna tıklama
//   3) "Press & Hold" (PerimeterX/HUMAN) düğmesine basılı tutma
//   4) Genel "doğrula/devam" düğmesi sezgisi
//   5) Yeni gizli profil + yayıncı ana sayfası ısınması (cookie + referer)
//   6) Mobil Chrome taklidi (duvarlar mobil UA'ya farklı davranabilir)
//   7) Giriş URL'si çeşitlemeleri (AMP, amp kök yolu vb. — bilinen yayıncılar)
//
// Oturum kalıcılığı: kalıcı kullanıcı profili sayesinde bir host'un challenge'ı
// bir kez geçildiğinde sonraki makaleler "cleared" (hızlı) yoldan gelir.
//
// Yapılandırma (ortam değişkenleri):
//   TELGRAF_STEALTH=0           kapatır
//   TELGRAF_CHROME=...          tarayıcı yolu (otomatik bulunur)
//   TELGRAF_HEADFUL=1           başlıklı çalıştırır (Actions'ta xvfb ile)
//   TELGRAF_STEALTH_TIMEOUT     URL başına bütçe (ms, varsayılan 45000)
//   TELGRAF_STEALTH_WALL_MS     tarayıcı işinin duvar saati kesimi (varsayılan 420000)
//   TELGRAF_STEALTH_*_BUDGET    kapsam penceresi: o iş türünün ilk kullanımdan
//                               itibaren kaç sn tarayıcıya izin verildiği (duvar saati)
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

/* ============================================================
   Durum
   ============================================================ */

const hostState = new Map(); // host -> { cleared, hardBlocked, queue, ok, fail }
const stats = {
  launched: 0,
  navigations: 0,
  attempts: 0,
  successes: 0,
  challengeSeen: 0,
  challengeCleared: 0,
  challengeReloads: 0,
  quickSkips: 0,
  queueDrops: 0,
  budgetSkips: 0,
};

let budgetSpent = 0;

export function stealthEnabled() {
  const v = String(process.env.TELGRAF_STEALTH || '').toLowerCase();
  return v !== '0' && v !== 'off' && v !== 'false';
}

export function stealthStats() {
  return {
    ...stats,
    hostPages: HOST_PAGES,
    maxPages: MAX_PAGES,
    queueDrops: stats.queueDrops,
    wallMs: WALL_CLOCK_MS,
    elapsedMs: Date.now() - moduleStartedAt,
    windows: Object.fromEntries(Object.entries(scopeWindow).map(([k, v]) => {
      const st = scopeStartedAt.get(k);
      return [k, st ? `${Math.round((Date.now() - st) / 1000)}/${Math.round(v / 1000)}sn` : '-'];
    })),
    cycles: [...hostState.values()].reduce((a, h) => a + (h.cycles || 0), 0),
    budgetSpentMs: budgetSpent,
    hosts: [...hostState.entries()].map(([h, s]) => ({
      host: h,
      cleared: !!s.cleared,
      hardBlocked: !!s.hardBlocked,
      ok: s.ok,
      fail: s.fail,
    })),
  };
}

// Donanım başına eşzamanlılık: CI 4 vCPU/16GB, ince sandbox 2 vCPU/2GB.
// Aşırı sayfa → bellek baskısı → "takılma"; o yüzden çekirdek sayısıyla sınırlı.
const CPUS = os.cpus().length || 2;
const HOST_PAGES = Number(process.env.TELGRAF_STEALTH_HOST_CONCURRENCY || Math.max(2, Math.min(4, CPUS)));
// Duvarlı hostta tam denemeye dönüş giderek seyrekleşir (4→8→16→32→45 dk)
const QUICK_COOLDOWN_MS = Number(process.env.TELGRAF_STEALTH_QUICK_COOLDOWN || 240000);
const QUICK_COOLDOWN_MAX_MS = Number(process.env.TELGRAF_STEALTH_QUICK_COOLDOWN_MAX || 2700000);
// Duvar saati kesimi: derleme ne kadar sürerse sürsün tarayıcı işi sonsuza
// uzamasın (Actions işi 30 dk;Pages yayını bunu beklememeli).
const WALL_CLOCK_MS = Number(process.env.TELGRAF_STEALTH_WALL_MS || process.env.TELGRAF_STEALTH_BUDGET || 420000);
const moduleStartedAt = Date.now();

function getHostState(url) {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  if (!hostState.has(host)) {
    hostState.set(host, {
      cleared: false, hardBlocked: false, quickUntil: 0, cycles: 0,
      pool: null, ok: 0, fail: 0,
    });
  }
  return { host, state: hostState.get(host) };
}

/**
 * Süre aşımlı kuyruk: sıraya giren iş kendi URL bütçesini tüketiyorsa
 * beklemekten vazgeçer. Beklemenin kendisi hostun suçu değildir.
 */
async function acquireSlotFrom(c, limit, waitMs) {
  const start = Date.now();
  for (;;) {
    if (c.active < limit) { c.active += 1; return true; }
    let wake;
    const p = new Promise((r) => { wake = r; c.waiters.push(wake); });
    const left = waitMs - (Date.now() - start);
    if (left <= 0) {
      const i = c.waiters.indexOf(wake);
      if (i >= 0) c.waiters.splice(i, 1);
      return false;
    }
    const t = setTimeout(() => wake('timeout'), left);
    const r = await p;
    clearTimeout(t);
    if (r === 'timeout') {
      const i = c.waiters.indexOf(wake);
      if (i >= 0) c.waiters.splice(i, 1);
      return false;
    }
  }
}

/** Derleyicinin kuyruk boyutunu buna göre ayarlaması için. */
export function stealthCapacity() {
  return {
    pages: MAX_PAGES,
    hostPages: HOST_PAGES,
    urlBudgetMs: Number(process.env.TELGRAF_STEALTH_TIMEOUT || 45000),
    remainingMs: Math.max(0, WALL_CLOCK_MS - (Date.now() - moduleStartedAt)),
  };
}

/** Host içi eşzamanlılık: ısınmış oturum paylaşılır, ama bir makale diğerlerini bekletmez. */
const hostPool = (state) => (state.pool ||= { active: 0, waiters: [] });

async function acquireHost(state, waitMs) {
  return acquireSlotFrom(hostPool(state), HOST_PAGES, waitMs);
}

function releaseHost(state) {
  const p = hostPool(state);
  p.active -= 1;
  const next = p.waiters.shift();
  if (next) next();
}

// Zaman kutuları DUVAR SAATİYLE ölçülür. Önceden kapsam başına biriken
// süre kullanılıyordu; sayfalı eşzamanlılıkla aynı anda 4-6 iş koştuğu için
// 171 sn'lik koşuda 2352 sn "harcanmış" gibi görünüp tarayıcı daha işi
// bitmeden pes ediyordu. Şimdi: kapsam ilk kullanıldığından itibaren
// limit kadar süre alır; paralellik limiti şişiremez.
const scopeWindow = {
  image: Number(process.env.TELGRAF_STEALTH_IMAGE_BUDGET || 240000),
  resolve: Number(process.env.TELGRAF_STEALTH_RESOLVE_BUDGET || 300000),
  article: Number(process.env.TELGRAF_STEALTH_ARTICLE_BUDGET || 360000),
};
const scopeStartedAt = new Map(); // kapsam -> ilk kullanım anı

function withinBudget(scope = 'article') {
  if (Date.now() - moduleStartedAt > WALL_CLOCK_MS) return false;
  const start = scopeStartedAt.get(scope);
  if (start === undefined) return true;
  return Date.now() - start < (scopeWindow[scope] ?? scopeWindow.article);
}

function markScope(scope) {
  if (!scopeStartedAt.has(scope)) scopeStartedAt.set(scope, Date.now());
}

/** Yalnız rapor: toplam meşguliyet (paralel işler üst üste biner). */
function recordSpent(scope, ms) {
  budgetSpent += ms;
  scopeSpent.set(scope, (scopeSpent.get(scope) || 0) + ms);
}

const scopeSpent = new Map(); // kapsam -> meşguliyet ms (image / article / resolve)

/* ============================================================
   Tarayıcı edinimi
   ============================================================ */

let browserPromise = null;
let pptr = null; // { puppeteer, executablePath, extraArgs, env }

/** sparticuz/chromium'ın Lambda dışı ortamlarda da çalışması için lib açılımı */
async function prepSparticuz() {
  const chromium = (await import('@sparticuz/chromium')).default;
  const execPath = await chromium.executablePath();
  // AL2023 ortam kütüphaneleri paketle gelir; Lambda dışı sistemlerde elle açılır.
  const { fileURLToPath } = await import('node:url');
  const libDir = path.join(os.tmpdir(), 'al2023', 'lib');
  const tarBr = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@sparticuz', 'chromium', 'bin', 'al2023.tar.br');
  if (!fs.existsSync(path.join(libDir, 'libnspr4.so')) && fs.existsSync(tarBr)) {
    const zlib = await import('node:zlib');
    const { execFileSync } = await import('node:child_process');
    fs.mkdirSync(libDir, { recursive: true });
    const tarPath = path.join(os.tmpdir(), 'al2023.tar');
    fs.writeFileSync(tarPath, zlib.brotliDecompressSync(fs.readFileSync(tarBr)));
    execFileSync('tar', ['-xf', tarPath, '-C', path.dirname(libDir)]);
  }
  const prev = process.env.LD_LIBRARY_PATH || '';
  if (!prev.includes('al2023')) process.env.LD_LIBRARY_PATH = `${libDir}:${path.dirname(libDir)}:${prev}`.replace(/:$/, '');
  return { executablePath: execPath, extraArgs: chromium.args };
}

async function resolvePuppeteer() {
  if (pptr) return pptr;
  const [{ default: puppeteerExtra }, { default: StealthPlugin }] = await Promise.all([
    import('puppeteer-extra'),
    import('puppeteer-extra-plugin-stealth'),
  ]);
  puppeteerExtra.use(StealthPlugin());

  // 1) Ortam değişkeni → 2) sistem Chrome'u → 3) sparticuz (dev/test)
  let executablePath = process.env.TELGRAF_CHROME || process.env.PUPPETEER_EXECUTABLE_PATH || '';
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  if (!executablePath) {
    for (const c of candidates) {
      if (fs.existsSync(c)) { executablePath = c; break; }
    }
  }
  let extraArgs = [];
  if (!executablePath) {
    try {
      const sp = await prepSparticuz();
      executablePath = sp.executablePath;
      extraArgs = sp.extraArgs;
    } catch {
      throw new Error('no chrome executable found (TELGRAF_CHROME ile belirtilebilir)');
    }
  }
  pptr = { puppeteer: puppeteerExtra, executablePath, extraArgs };
  return pptr;
}

async function getBrowser() {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => null);
    const alive = existing && (existing.connected ?? existing.isConnected?.() ?? true);
    if (alive) return existing;
    // Çökmüş tarayıcı: kapat, yeniden başlat
    try { await existing?.close(); } catch { /* zaten kapalı */ }
    browserPromise = null;
  }
  browserPromise = (async () => {
    const { puppeteer, executablePath, extraArgs } = await resolvePuppeteer();
    const headful = ['1', 'true', 'yes'].includes(String(process.env.TELGRAF_HEADFUL || '').toLowerCase());
    const profileDir = process.env.TELGRAF_STEALTH_PROFILE
      || path.join(os.tmpdir(), 'telgraf-stealth-profile');
    fs.mkdirSync(profileDir, { recursive: true });
    // sparticuz'un tek süreçlik bayrakları çoklu context'te kararsız; ayıkla
    const stableArgs = extraArgs.filter((a) => !/^--(single-process|no-zygote)$/.test(a));
    const browser = await puppeteer.launch({
      executablePath,
      headless: !headful,
      userDataDir: profileDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--lang=tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        '--window-size=1366,900',
        ...stableArgs,
      ],
      defaultViewport: { width: 1366, height: 900 },
      ignoreHTTPSErrors: true,
    });
    stats.launched++;
    return browser;
  })().catch((e) => {
    browserPromise = null; // sonraki çağrıda yeniden dene
    throw e;
  });
  return browserPromise;
}

export async function closeStealth() {
  const b = browserPromise;
  browserPromise = null;
  try { (await b)?.close(); } catch { /* zaten kapalı */ }
}

/* ============================================================
   Challenge tespiti
   ============================================================ */

const CHALLENGE_PATTERNS = [
  /performing security verification/i,
  /verifying (?:that )?you are (?:a )?(?:human|device)/i,
  /verify (?:that )?you are human/i,
  /checking (?:your )?browser/i,
  /^just a moment/i,
  /attention required/i,
  /complete the security check/i,
  /security check\s*[-–—:]?\s*please wait/i,
  /needs to review the security/i,
  /press\s*(?:&|and)\s*hold/i,
  /unusual traffic (?:from your |detected)/i,
  /cloudflare ray id/i,
  /why have i been blocked/i,
  /access to this page has been denied/i,
  /are you a robot\?/i,
  /enable javascript and cookies to continue/i,
  /additional verification required/i,
  /please enable js and disable any ad blocker/i,
  /access to this page has been denied/i,
  /blocked by (?:network )?security/i,
  /unusual traffic from your (?:network|ip|device)/i,
  /datadome|captcha-delivery|perimeterx|human verification|press (?:&|and) hold/i,
];

/** Sayfa gövdesi/başlığı challenge ekranına benziyor mu? */
export function looksLikeChallenge(body, title = '') {
  const text = `${title}\n${String(body || '').slice(0, 20000)}`
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return CHALLENGE_PATTERNS.some((re) => re.test(text));
}

/** Bilinen challenge göstergeleri (DOM sayacı için) */
const CHALLENGE_SELECTORS = [
  '#challenge-form',
  '#challenge-running',
  '.cf-turnstile',
  '#turnstile-wrapper',
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="geo.captcha-delivery.com"]',
  'iframe[src*="hcaptcha.com"]',
  'iframe[src*="recaptcha"]',
  '.g-recaptcha',
  '#px-captcha',
  '[data-testid="challenge"]',
  '#datadome',
  '.ddg-captcha',
  'iframe[src*="datadome"]',
  'iframe[src*="captcha"] input[type="checkbox"]',
  'div[style*="captcha"] iframe',
];

async function challengeMarkers(page) {
  try {
    return await page.evaluate((sels) => {
      const out = [];
      for (const s of sels) {
        if (document.querySelector(s)) out.push(s);
      }
      return out;
    }, CHALLENGE_SELECTORS);
  } catch {
    return [];
  }
}

/* ============================================================
   İnsan taklidi
   ============================================================ */

async function humanMove(page) {
  try {
    const x = rnd(120, 900);
    const y = rnd(120, 600);
    await page.mouse.move(x / 2, y / 2);
    await page.mouse.move(x, y, { steps: rnd(3, 6) });
    await page.evaluate(() => window.scrollBy(0, Math.round(80 + Math.random() * 220)));
    await sleep(rnd(30, 90));
  } catch { /* sayfa kapanmış olabilir */ }
}

/** Sayfadaki olası "onay kutusu" hedeflerine tıklama (genel amaçlı) */
async function clickCheckboxish(page) {
  // 1) Çerçeve içi onay kutuları (turnstile/recaptcha/hcaptcha)
  for (const frame of page.frames()) {
    try {
      const clicked = await frame.evaluate(() => {
        const btn = document.querySelector('input[type="checkbox"]')
          || document.querySelector('[role="checkbox"]')
          || document.querySelector('#checkbox')
          || document.querySelector('button');
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (clicked) return 'frame-checkbox';
    } catch { /* cross-origin çerçeve */ }
  }
  // 2) Ana sayfa genel doğrula düğmeleri
  try {
    const clicked = await page.evaluate(() => {
      const texts = /^(verify|continue|allow|accept|confirm|i am human|i'm not a robot|doğrula|devam|kabul et|onayla)/i;
      const els = [...document.querySelectorAll('button, input[type=submit], a[role=button], [id*=check], [class*=check]')];
      for (const el of els) {
        const t = (el.innerText || el.value || '').trim();
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && (texts.test(t) || /checkbox/i.test(el.className + el.id))) {
          el.click();
          return t || 'generic';
        }
      }
      return '';
    });
    if (clicked) return `page-button:${clicked.slice(0, 24)}`;
  } catch { /* yoksay */ }
  // 3) Turnstile kutusuna koordinat tıklaması (iframe dışarıdan tıklanabilir)
  try {
    const box = await page.evaluate(() => {
      const el = document.querySelector('.cf-turnstile, #turnstile-wrapper, [data-sitekey]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + 30, y: r.top + r.height / 2 };
    });
    if (box && box.x > 0 && box.y > 0) {
      await page.mouse.click(box.x, box.y, { delay: rnd(40, 120) });
      return 'turnstile-coords';
    }
  } catch { /* yoksay */ }
  return '';
}

/** "Press & Hold" tipi doğrulamada düğmeye basılı tutma */
async function pressAndHold(page) {
  try {
    const box = await page.evaluate(() => {
      const el = document.querySelector('#px-captcha, [id*=hold], [class*=hold], button')
        || [...document.querySelectorAll('div,button,a')].find((n) => /press\s*(?:&|and)\s*hold/i.test(n.innerText || ''));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    });
    if (!box || box.w <= 0) return '';
    await page.mouse.move(box.x, box.y, { steps: 8 });
    await page.mouse.down();
    await sleep(rnd(1400, 2600));
    await page.mouse.up();
    return 'press-hold';
  } catch {
    return '';
  }
}

/** Doğrulama sonrası oturumun gerçekten kurulduğunu gösteren çerezler. */
// İyimser sinyal: çerez varsa yeniden iste — içerik gerçekten açılmış mı diye
// çağıran taraf bakar (çerez tek başına içeriği kabul etmek için yeterli değil).
const CLEARANCE_COOKIES = /cf_clear|datadome|pxc|_pxhd|awsWafToken/i;

async function hasClearance(page) {
  try {
    // URL verilmezse puppeteer tüm bağlam çerezlerini döndürür
    const cookies = await page.cookies().catch(() => []);
    return (cookies || []).some((c) => CLEARANCE_COOKIES.test(c.name || ''));
  } catch {
    return false;
  }
}

async function pageChallengeState(page) {
  const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const title = await page.title().catch(() => '');
  const markers = await challengeMarkers(page);
  const thin = (body || '').replace(/\s+/g, ' ').trim().length < 500;
  return { interstitial: thin && (markers.length > 0 || looksLikeChallenge(body, title)), markers };
}

/**
 * Turnstile/reCAPTCHA kutusuna GERÇEK fare olayıyla tıklarız: JS .click()
 * bot sayılıyor, koordinatlı tıklama iframe içinde de çalışıyor.
 */
async function clickCaptchaBox(page) {
  let hit = '';
  for (const frame of page.frames()) {
    try {
      const el = await frame.$('input[type="checkbox"], #checkbox, [role="checkbox"], .cb-c, button');
      if (!el) continue;
      const box = await el.boundingBox().catch(() => null);
      if (!box || box.width <= 0) continue;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
      await sleep(rnd(60, 160));
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: rnd(60, 180) });
      hit = 'frame-click';
      break;
    } catch { /* çapraz kaynak çerçeve */ }
  }
  if (hit) return hit;
  // gömülü çerçevenin sol tarafındaki kutu: iframe konumundan tahmin et
  try {
    for (const el of await page.$$('iframe')) {
      const box = await el.boundingBox().catch(() => null);
      if (!box || box.width < 60 || box.height < 20) continue;
      const x = box.x + 28;
      const y = box.y + box.height / 2;
      await page.mouse.move(x - 40, y - 20, { steps: 4 });
      await page.mouse.move(x, y, { steps: 4 });
      await page.mouse.click(x, y, { delay: rnd(60, 180) });
      return 'iframe-coord-click';
    }
  } catch { /* yoksay */ }
  return await clickCheckboxish(page);
}

/**
 * Challenge sayfasındayken geçmeyi dener: bekleme → tıklama → basılı tutma →
 * çerez kontrolü. Managed challenge + DataDome 5-20 sn sürebiliyor, o yüzden
 * sabır URL bütçesiyle sınırlı ama varsayılan 12 sn.
 * @returns {'cleared'|'still'}
 */
async function attemptChallengePass(page, deadline) {
  stats.challengeSeen++;
  const waitMs = Number(process.env.TELGRAF_STEALTH_CHALLENGE_WAIT || 12000);
  const until = Math.min(deadline, Date.now() + waitMs);
  let round = 0;
  while (Date.now() < until) {
    await sleep(round === 0 ? 900 : 800);
    const st = await pageChallengeState(page);
    if (!st.interstitial) {
      stats.challengeCleared++;
      return 'cleared';
    }
    // doğrulama çerezi kurulduysa DOM hâlâ aracı sayfada kalmış olsa bile
    // yeniden istekte bulunmak gerekir (Cloudflare/DataDome bunu kendisi yapmaz)
    if (await hasClearance(page)) {
      if (!st.interstitial) stats.challengeCleared++;
      return 'cleared';
    }
    if (round === 0) await clickCaptchaBox(page);
    else if (round === 1) await pressAndHold(page);
    else if (round === 2) { await clickCaptchaBox(page); await pressAndHold(page); }
    else if (round === 3) await page.reload({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
    else if (round >= 4 && round % 2 === 0) await clickCaptchaBox(page);
    await humanMove(page);
    round++;
  }
  const st = await pageChallengeState(page);
  if (!st.interstitial) { stats.challengeCleared++; return 'cleared'; }
  return 'still';
}

/* ============================================================
   URL çeşitlemeleri
   ============================================================ */

export function urlVariants(url) {
  const out = [url];
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    // AMP kök yolu / çıktı biçimi (WordPress ve bazı CMS'ler)
    const amp = new URL(u.href);
    if (!/\/amp\/?$/.test(amp.pathname)) {
      amp.pathname = `${amp.pathname.replace(/\/$/, '')}/amp/`;
      out.push(amp.href);
    }
    if (host === 'nytimes.com') {
      const v = new URL(u.href);
      v.searchParams.set('smid', 'url-share');
      out.push(v.href);
    }
    if (host === 'france24.com') {
      // dil yolu olmadan dene (bazı yönlendirmeler duvara düşüyor)
      const v = new URL(u.href);
      v.pathname = v.pathname.replace(/^\/(en|fr|es|ar|pt|de)\//, '/');
      if (v.pathname !== u.pathname) out.push(v.href);
    }
    if (host === 'reuters.com') {
      const v = new URL(u.href);
      v.searchParams.set('ta', '10');
      out.push(v.href);
    }
  } catch { /* geçersiz URL */ }
  return [...new Set(out)].slice(0, 3);
}

/* ============================================================
   Ana çekim
   ============================================================ */

/**
 * URL'yi stealth tarayıcıyla çeker.
 * @returns {{ html: string, finalUrl: string, strategy: string }}
 */
export async function stealthFetchHtml(url, opts = {}) {
  if (!stealthEnabled()) throw new Error('stealth disabled');
  // Google News bağlantıları burada çekilmez: stealthResolveGoogleNews çözer
  try {
    const h = new URL(url).hostname;
    if (h === 'news.google.com' || h.endsWith('.news.google.com')) {
      throw new Error('stealth skipped for google news links');
    }
  } catch (e) {
    if (/skipped for google news/.test(e.message)) throw e;
  }
  const { host, state } = getHostState(url);
  return stealthFetchHtmlInner(url, host, state, opts);
}

// Genel eşzamanlılık: CI çekirdeğini ve yayıncıları yormamak için
const MAX_PAGES = Number(process.env.TELGRAF_STEALTH_CONCURRENCY || Math.max(2, Math.min(6, CPUS)));
const globalPool = { active: 0, waiters: [] };
const acquireSlot = (waitMs) => acquireSlotFrom(globalPool, MAX_PAGES, waitMs);
function releaseSlot() {
  globalPool.active -= 1;
  const next = globalPool.waiters.shift();
  if (next) next();
}

async function stealthFetchHtmlInner(url, host, state, opts) {
  const perUrlBudget = Number(process.env.TELGRAF_STEALTH_TIMEOUT || 45000);
  // quick: bu hostta tam çözüm son denemede de işlemedi → tek/hızlı deneme.
  // Kalıcı değil: cooldown süresince tekrar tam deneme şansı doğar.
  const quick = state.hardBlocked && state.quickUntil > Date.now();
  if (state.hardBlocked && !quick) { state.hardBlocked = false; state.fail = 0; }
  const scope = opts.scope || 'article';
  // kesim yaklaştıysa yeni tarayıcı işi açma (host başarısız sayılmaz)
  if (!withinBudget(scope)) {
    stats.budgetSkips++;
    throw new Error(Date.now() - moduleStartedAt > WALL_CLOCK_MS ? 'stealth wall-clock cutoff' : 'stealth budget exhausted');
  }
  markScope(scope);
  const started = Date.now();
  const deadline = started + Math.min(opts.timeoutMs || perUrlBudget, quick ? 12000 : perUrlBudget);
  // Duvarlı hostta her makalede uzun deneme yapma: tek hızlı deneme
  const strategies = quick ? ['quick'] : ['warm-context', 'fresh-context', 'mobile-context'];

  let lastError = 'not attempted';
  let attempted = false;
  const waitMs = Math.max(1500, deadline - Date.now());
  if (!(await acquireHost(state, waitMs))) {
    stats.queueDrops++;
    throw new Error(`stealth queue full (${host})`);
  }
  if (!(await acquireSlot(waitMs))) {
    releaseHost(state);
    stats.queueDrops++;
    throw new Error(`stealth queue full (${host})`);
  }
  try {
    for (const strategy of strategies) {
      if (Date.now() > deadline) break;
      if (!withinBudget(scope)) { stats.budgetSkips++; break; }
      attempted = true;
      stats.attempts++;
      try {
        const result = await attemptOnce(url, { ...opts, strategy, deadline, host, state, quick });
        if (result) {
          stats.successes++;
          state.ok++;
          state.cleared = true;
          state.hardBlocked = false;
          state.fail = 0;
          recordSpent(scope, Date.now() - started);
          return { ...result, strategy };
        }
        lastError = 'challenge remained';
      } catch (e) {
        lastError = e.message;
      }
      if (!quick) await sleep(rnd(600, 1600));
    }
  } finally {
    releaseSlot();
    releaseHost(state);
  }

  // sırada/bütçede bekleyip hiç denemeyen iş hostu batırmaz
  if (!attempted) {
    recordSpent(scope, Date.now() - started);
    throw new Error(`stealth not attempted (${host}): ${lastError}`);
  }
  state.fail++;
  if (state.fail >= 3 && !state.ok) {
    state.hardBlocked = true;
    const cooldown = Math.min(QUICK_COOLDOWN_MAX_MS, QUICK_COOLDOWN_MS * 2 ** state.cycles);
    state.cycles += 1;
    state.quickUntil = Date.now() + cooldown;
    stats.quickSkips++;
  }
  recordSpent(scope, Date.now() - started);
  throw new Error(`stealth failed (${host}): ${lastError}`);
}

async function attemptOnce(url, { strategy, deadline, host, state, quick, waitUntil }) {
  const browser = await getBrowser();
  const incognito = strategy === 'fresh-context' || strategy === 'mobile-context';
  const context = incognito ? await browser.createBrowserContext() : browser.defaultBrowserContext();
  try {
    const page = await context.newPage();
    stats.navigations++;
    await page.setUserAgent(
      strategy === 'mobile-context'
        ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    });
    if (strategy === 'mobile-context') {
      await page.emulate({
        viewport: { width: 412, height: 915, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6 },
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      });
    }

    // Yayıncı ana sayfasında ısınma (cookie + referer) — host zaten açıksa
    // bu adım boşuna ~1-6 sn: ısınma yalnızca ilk temas için yapılır.
    let referer = '';
    if (!quick && strategy !== 'mobile-context' && !state.cleared) {
      try {
        const home = new URL(url).origin + '/';
        await page.goto(home, { waitUntil: 'domcontentloaded', timeout: Math.min(6000, Math.max(2000, deadline - Date.now())) });
        await humanMove(page);
        referer = home;
      } catch { /* ısınma iyi niyetli */ }
    }

    for (const candidate of urlVariants(url)) {
      if (Date.now() > deadline) break;
      if (referer) await page.setExtraHTTPHeaders({ 'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7', Referer: referer });
      try {
        await page.goto(candidate, { waitUntil: waitUntil || 'domcontentloaded', timeout: Math.min(25000, Math.max(5000, deadline - Date.now())) });
      } catch (e) {
        if (/net::ERR|timeout/i.test(e.message)) {
          // Ağ hatası: sonraki çeşitleme
          continue;
        }
        throw e;
      }
      await sleep(250);
      await humanMove(page);

      let body = await page.evaluate(() => document.body?.innerHTML || '').catch(() => '');
      let title = await page.title().catch(() => '');
      let markers = await challengeMarkers(page);
      const textLen = (body || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().length;

      // Kritik: yalnız İÇERİK İNCE ise challenge sayfası sayılır. Haber metni
      // "verify you are human" gibi kalıpları içerebilir; o sayfalar çözülmüş sayılır.
      if (textLen < 500 && (markers.length || looksLikeChallenge(body, title))) {
        if (quick) return null; // duvarlı hostta çözme denemesi yapma
        const outcome = await attemptChallengePass(page, deadline);
        if (outcome !== 'cleared') {
          body = await page.evaluate(() => document.body?.innerHTML || '').catch(() => '');
          const t2 = (body || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().length;
          if (t2 < 500 && looksLikeChallenge(body, await page.title().catch(() => ''))) continue; // sonraki çeşitleme
        } else {
          // KRİTİK: Cloudflare/DataDome aracı sayfayı yerinde bırakır — geçiş
          // doğrulandıktan sonra makaleyi YENİDEN istemek gerekir.
          stats.challengeReloads++;
          await page.goto(candidate, {
            waitUntil: 'domcontentloaded',
            timeout: Math.min(12000, Math.max(3000, deadline - Date.now())),
          }).catch(() => {});
          await sleep(250);
          body = await page.evaluate(() => document.body?.innerHTML || '').catch(() => '');
          title = await page.title().catch(() => '');
          const t3 = (body || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().length;
          // Cloudflare bazen ikinci turda bırakır: bir kez daha dene, sonra vazgeç
          if (t3 < 500 && (await challengeMarkers(page)).length + (looksLikeChallenge(body, title) ? 1 : 0) > 0 && Date.now() < deadline - 4000) {
            const again = await attemptChallengePass(page, deadline);
            if (again === 'cleared') {
              await page.goto(candidate, {
                waitUntil: 'domcontentloaded',
                timeout: Math.min(12000, Math.max(3000, deadline - Date.now())),
              }).catch(() => {});
              await sleep(250);
              body = await page.evaluate(() => document.body?.innerHTML || '').catch(() => '');
              title = await page.title().catch(() => '');
            }
          }
        }
        body = await page.evaluate(() => document.body?.innerHTML || '').catch(() => '');
        title = await page.title().catch(() => '');
      }

      const finalUrl = page.url();
      const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
      if (body && text.length >= 400 && !looksLikeChallenge(body, title)) {
        try { await page.close(); } catch { /* yoksay */ }
        return { html: body, finalUrl, title };
      }
      // kısa gövde: sonraki çeşitleme
    }
    return null;
  } finally {
    try {
      if (incognito) await context.close();
    } catch { /* yoksay */ }
  }
}

/* ============================================================
   Google News tarayıcı çözümü
   ============================================================ */

/**
 * Google News makale linkini tarayıcıyla gerçek makale URL'sine çevirir.
 * Yöntem: sayfaya git → JS yönlendirmesi / data-n-au / rel=noreferrer hedefi.
 * @returns {string} gerçek URL ya da boş
 */
export async function stealthResolveGoogleNews(url, opts = {}) {
  if (!stealthEnabled()) return '';
  const timeoutMs = opts.timeoutMs || 12000;
  const started = Date.now();
  if (!withinBudget('resolve')) { stats.budgetSkips++; return ''; }
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      stats.navigations++;
      const isG = (u) => /(?:^|\.)((google|googleapis|gstatic|googleusercontent|ggpht|youtube|ytimg|blogger|blogspot)\.)|(?:^|\.)news\.google\./i.test(new URL(u).hostname);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      // Otomatik yönlendirmeyi bekle (10 sn)
      const t0 = Date.now();
      while (Date.now() - t0 < 5000) {
        const cur = page.url();
        try {
          if (!isG(cur)) return cur;
        } catch { /* geçersiz */ }
        await sleep(500);
      }
      // Yönlendirme yoksa sayfa içinden hedefi çıkar
      return await page.evaluate(() => {
        const isGoogle = (h) => /(?:^|\.)(google|googleapis|gstatic|googleusercontent|ggpht|youtube|ytimg|blogger|blogspot)\./i.test(h);
        const cands = [];
        for (const m of document.documentElement.innerHTML.matchAll(/data-n-au=["']([^"']+)["']/g)) cands.push(m[1]);
        for (const a of document.querySelectorAll('a[rel="noreferrer"]')) cands.push(a.href);
        for (const a of document.querySelectorAll('a[href^="http"]')) {
          const u = a.href;
          try { if (!isGoogle(new URL(u).hostname)) cands.push(u); } catch { /* yoksay */ }
        }
        cands.sort((a, b) => b.length - a.length);
        return cands[0] || '';
      });
    } finally {
      try { await page.close(); } catch { /* yoksay */ }
    }
  } catch {
    return '';
  } finally {
    recordSpent('resolve', Date.now() - started);
  }
}
