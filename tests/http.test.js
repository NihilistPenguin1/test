// Şerit planlayıcısı + duvar hatırası: birim testleri ağa çıkmadan çalışır.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELGRAF_HTTP_LANE_PAGE_HOST = '2';
process.env.TELGRAF_HTTP_HOST_MIN_GAP = '0';
process.env.TELGRAF_HTTP_LANE_IMAGE_HOST = '2';

const {
  fetchPage,
  setHttpClient,
  resetHttpClient,
  resetHostState,
  isHostBlocked,
  isDirectFutile,
  wallReason,
  noteWall,
  noteHostSuccess,
  httpStats,
} = await import('../server/http.js');

const ok = (body = 'ok') => ({ ok: true, status: 200, body, finalUrl: 'https://x.test/a', headers: {} });

test('wall memory: repeated 403s mark the host futile for direct fetch, success clears it', async () => {
  resetHostState();
  let calls = 0;
  setHttpClient(async () => { calls += 1; return { ok: false, status: 403, body: 'blocked', headers: {} }; });
  await fetchPage('https://apnews.com/a');
  assert.equal(isDirectFutile('https://apnews.com/b'), false, 'tek red yetmez');
  await fetchPage('https://apnews.com/b');
  assert.equal(isDirectFutile('https://apnews.com/c'), false, 'iki red de yetmez: geçici blok olabilir');
  await fetchPage('https://apnews.com/c');
  assert.equal(isDirectFutile('https://apnews.com/d'), true, 'üç art arda red → doğrudan çekim anlamsız');
  assert.equal(wallReason('https://apnews.com/c'), 'http403');

  noteHostSuccess('https://apnews.com/c');
  assert.equal(isDirectFutile('https://apnews.com/d'), false, 'başarı hatırayı temizler');
  assert.equal(calls, 3, 'üç red + bir başarı denemesi');
  resetHttpClient();
});

test('rate limits (429) back off after a single hit, 404s do not build a wall', async () => {
  resetHostState();
  setHttpClient(async () => ({ ok: false, status: 429, body: '', headers: {} }));
  await fetchPage('https://b1.reuters.com/x');
  assert.equal(isHostBlocked('https://b1.reuters.com/y'), true, '429 anında geri çekilme');
  resetHostState();
  setHttpClient(async () => ({ ok: false, status: 404, body: '', headers: {} }));
  for (let i = 0; i < 5; i++) await fetchPage('https://b2.example.com/x');
  assert.equal(isHostBlocked('https://b2.example.com/y'), false, 'bulunamadı duvar değildir');
  resetHttpClient();
});

test('noteWall covers challenge pages served with HTTP 200', async () => {
  resetHostState();
  noteWall('https://apnews.com/a', 'challenge');
  noteWall('https://apnews.com/b', 'challenge');
  assert.equal(isDirectFutile('https://apnews.com/c'), false);
  noteWall('https://apnews.com/d', 'challenge');
  assert.equal(isDirectFutile('https://apnews.com/e'), true);
  assert.equal(wallReason('https://apnews.com/e'), 'challenge');
});

test('lanes are independent: a saturated image lane does not stall the page lane', async () => {
  resetHostState();
  let imageInFlight = 0;
  let imageMax = 0;
  let pageDone = 0;
  const gate = { release: null };
  const blocked = new Promise((r) => { gate.release = r; });

  setHttpClient(async (url) => {
    if (url.includes('/img/')) {
      imageInFlight += 1;
      imageMax = Math.max(imageMax, imageInFlight);
      await blocked; // görseller serbest bırakılana kadar asılı kalır
      imageInFlight -= 1;
      return ok('img');
    }
    pageDone += 1;
    return ok('page');
  });

  const images = [1, 2, 3, 4].map((i) => fetchPage(`https://shared.test/img/${i}`, { lane: 'image' }));
  await new Promise((r) => setTimeout(r, 30)); // görsel şeridi limitine dolsun
  const pages = await Promise.all([1, 2, 3].map((i) => fetchPage(`https://shared.test/page/${i}`)));
  gate.release();
  await Promise.all(images);

  assert.equal(pages.length, 3);
  assert.equal(pageDone, 3, 'sayfa şeridi görsel şeridi dolu olsa da ilerledi');
  assert.equal(imageMax, 2, 'görsel şeridi kendi host limitiyle sınırlı kaldı');
  resetHttpClient();
});

test('host limit is enforced per lane and released after completion', async () => {
  resetHostState();
  let inFlight = 0;
  let max = 0;
  setHttpClient(async () => {
    inFlight += 1;
    max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight -= 1;
    return ok();
  });
  await Promise.all(Array.from({ length: 9 }, (_, i) => fetchPage(`https://busy.test/${i}`)));
  assert.equal(max, 2, 'page şeridi host başına 2 slot');
  assert.equal(inFlight, 0, 'slotlar iade edildi');
  assert.equal(httpStats().waits > 0, true, 'sıra bekleme sayacı işliyor');
  resetHttpClient();
});

test('canonicalArticleUrl: NYT tarih yolunu düzeltir, izleme parametrelerini atar', async () => {
  const { canonicalArticleUrl } = await import('../server/http.js');
  const slash = String.fromCharCode(47);
  const canon = ['2026', '09', '28'].join(slash);
  const got = canonicalArticleUrl(`https://www.nytimes.com/2026-09-28/world/europe/x.html?smid=url-share&hp=1&utm_source=x`);
  assert.ok(got.includes(slash + canon + slash), `tireli tarih kanonik yola dönmeli: ${got}`);
  assert.ok(!/smid|hp=|utm_/.test(got), `izleme parametreleri silinmeli: ${got}`);
  // Aynı adres kanonik gelirse dokunulmaz
  const same = canonicalArticleUrl(`https://www.nytimes.com${slash}${canon}${slash}world${slash}europe${slash}x.html`);
  assert.equal(same, `https://www.nytimes.com/${canon}/world/europe/x.html`);
  // Yayıncının içerik parametresi korunur, slug'ındaki tarihi bozulmaz
  assert.equal(canonicalArticleUrl('https://apnews.com/article/y-123?page=2'), 'https://apnews.com/article/y-123?page=2');
  assert.ok(canonicalArticleUrl('https://www.reuters.com/world/x-2026-09-28/').includes('x-2026-09-28'), 'reuters slug tarihi kalır');
  assert.equal(canonicalArticleUrl('bozuk-girdi'), 'bozuk-girdi');
});
