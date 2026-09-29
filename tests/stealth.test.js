// Stealth tarayıcı + challenge geçme denemeleri çevrimdışı testleri.
// Yerel HTTP sunucusu challenge sayfalarını taklit eder; dış ağ gerekmez.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.TELGRAF_STEALTH = '1';
process.env.TELGRAF_STEALTH_TIMEOUT = '30000';
// Her çalıştırmada taze profil: kalıcı cookie'ler testleri bozmasın
process.env.TELGRAF_STEALTH_PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'telgraf-test-profile-'));

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  looksLikeChallenge,
  urlVariants,
  stealthEnabled,
  stealthFetchHtml,
  stealthStats,
  closeStealth,
} from '../server/stealth.js';

/* ---------- saf fonksiyon testleri ---------- */

test('stealthEnabled reads the environment flag', () => {
  assert.equal(stealthEnabled(), true);
  process.env.TELGRAF_STEALTH = '0';
  assert.equal(stealthEnabled(), false);
  process.env.TELGRAF_STEALTH = '1';
});

test('detects challenge pages from body text and title', () => {
  assert.equal(looksLikeChallenge('<h1>Just a moment...</h1>'), true);
  assert.equal(looksLikeChallenge('Checking your browser before accessing'), true);
  assert.equal(looksLikeChallenge('Press & Hold to verify', ''), true);
  assert.equal(looksLikeChallenge('Attention Required! | Cloudflare', ''), true);
  assert.equal(looksLikeChallenge('<p>Ordinary news about security verification in politics.</p>'), false);
});

test('urlVariants offers bounded fallbacks including AMP', () => {
  const v = urlVariants('https://www.reuters.com/world/story-123');
  assert.ok(v.includes('https://www.reuters.com/world/story-123'));
  assert.ok(v.some((u) => /\/amp\/?$/.test(u)));
  assert.ok(v.length <= 3);
});

/* ---------- tarayıcı testleri ---------- */

const articleHtml = (title) => `<!doctype html><html><head><title>${title}</title></head>
<body><article><h1>${title}</h1>
${'<p>Bu bir deneme makale govdesidir ve okunabilir metin uretmek icin yeterince uzun olmalidir. </p>'.repeat(12)}
</article></body></html>`;

const challengeHtml = (kind) => {
  if (kind === 'auto') {
    // Managed challenge taklidi: 1.5 sn sonra cookie kurup kendiliğinden geçer
    return `<!doctype html><html><head><title>Just a moment...</title></head><body>
      <div id="challenge-running"><h1>Checking your browser</h1></div>
      <script>
        setTimeout(() => {
          document.cookie = 'cf_clear=1; path=/';
          location.reload();
        }, 1500);
      </script></body></html>`;
  }
  if (kind === 'click') {
    // Onay kutusu taklidi: tıklanınca cookie kurup yeniler
    return `<!doctype html><html><head><title>Verify you are human</title></head><body>
      <div class="cf-turnstile"><h1>Performing security verification</h1>
      <button id="verify">Verify</button></div>
      <script>
        document.getElementById('verify').addEventListener('click', () => {
          document.cookie = 'cf_clear=1; path=/';
          location.reload();
        });
      </script></body></html>`;
  }
  // basit challenge
  return `<!doctype html><html><head><title>Access denied</title></head>
    <body><h1>Performing security verification</h1><div id="challenge-form"></div></body></html>`;
};

function makeServer() {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const cookie = req.headers.cookie || '';
    const cleared = cookie.includes('cf_clear=1');
    hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
    const send = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    if (u.pathname === '/plain') return send(articleHtml('Duz Makale'));
    if (u.pathname === '/auto') {
      return send(cleared ? articleHtml('Otomatik Gecen Makale') : challengeHtml('auto'));
    }
    if (u.pathname === '/click') {
      return send(cleared ? articleHtml('Tiklamali Makale') : challengeHtml('click'));
    }
    if (u.pathname === '/hard') return send(challengeHtml('hard'));
    send('<h1>404</h1>', 404);
  });
  return { server, hits };
}

let ctx;

test.before(async () => {
  const { server, hits } = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  ctx = { server, hits, base: `http://127.0.0.1:${server.address().port}` };
});

test.after(async () => {
  await closeStealth();
  await new Promise((r) => ctx.server.close(r));
});

test('fetches an ordinary page through the stealth pipeline', async () => {
  const page = await stealthFetchHtml(`${ctx.base}/plain`);
  assert.match(page.html, /Duz Makale/);
  assert.ok(page.finalUrl.includes('/plain'));
});

test('waits out a managed challenge that clears itself', async () => {
  const page = await stealthFetchHtml(`${ctx.base}/auto`);
  assert.match(page.html, /Otomatik Gecen Makale/);
  const s = stealthStats();
  assert.ok(s.challengeSeen >= 1);
  assert.ok(s.challengeCleared >= 1);
});

test('passes a click-verification challenge', async () => {
  const page = await stealthFetchHtml(`${ctx.base}/click`);
  assert.match(page.html, /Tiklamali Makale/);
});

test('gives up on an unpassable challenge but keeps stats', async () => {
  await assert.rejects(
    () => stealthFetchHtml(`${ctx.base}/hard`, { timeoutMs: 12000 }),
    /stealth failed/,
  );
  const s = stealthStats();
  assert.ok(s.attempts >= 1);
});

test('a cleared host is served fast on the next visit (warm session)', async () => {
  const t0 = Date.now();
  const page = await stealthFetchHtml(`${ctx.base}/auto`);
  assert.match(page.html, /Otomatik Gecen Makale/);
  assert.ok(Date.now() - t0 < 6000, 'cleared host should not re-solve the challenge');
});
