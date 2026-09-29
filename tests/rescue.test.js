// Kurtarma yolları (Wayback / tel aynası / beklemeli jina) — birim testleri.
// Ağ yok: http.js'in sahte-istemci dikişiyle (setHttpClient) yanıtlar üretilir.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELGRAF_RESCUE = '1';
process.env.TELGRAF_RESCUE_MS = '120000';
process.env.TELGRAF_RESCUE_SEARCHES = '10';
process.env.TELGRAF_RESCUE_COOLDOWN_MS = '0'; // testlerde nefes arası olmasın
process.env.TELGRAF_HTTP_HOST_MIN_GAP = '0';

const { setHttpClient, resetHttpClient, resetHostState } = await import('../server/http.js');
const rescue = await import('../server/rescue.js');

const AP = 'https://apnews.com/article/uk-raf-fairford-us-air-force-739a99fedaac750343cb01f92a40bc3b';
const NYT = 'https://www.nytimes.com/2026-09-28/world/americas/brazil-election-bolsonaro.html';
const item = (link, title, source) => ({
  id: `${source}-${title.slice(0, 8).replace(/\W/g, '')}`,
  source, link, title, published: '2026-09-28T09:00:00Z', summary: '', author: '', image: '',
});

const pad = (title) => Array.from({ length: 8 }, (_, i) =>
  `<p>Paragraph ${i + 1} about ${title}: the officials confirmed the account and said the inquiry would continue through the weekend while mediators pressed for a deal on the disputed territory.</p>`).join('\n');
// Gerçekçi fikstür: başlık hem <title>'da hem gövdede geçer (örtüşme beklenir)
const articleHtml = (title, wire = '(AP)') => `<!doctype html><html><head><title>${title} - Publisher</title></head><body><article><h1>${title}</h1><p>${wire}</p>${pad(title)}</article></body></html>`;
const CF = '<html><head><title>Just a moment...</title></head><body><div>Just a moment...Enable JavaScript and cookies to continue</div></body></html>';
const SEARCH = (urls) => `<html><body>${urls.map((u) => `<a href="//html.duckduckgo.com/l/?uddg=${encodeURIComponent(u)}&rut=x">sonuç</a>`).join('')}</body></html>`;

/** Kayıt defteri tutan sahte istemci: url desenine göre yanıt üretir */
function fake(handlers) {
  const calls = [];
  setHttpClient(async (url) => {
    calls.push(url);
    for (const [re, fn] of handlers) {
      const m = String(url).match(re);
      if (m) return fn(m, url);
    }
    return { ok: false, status: 404, body: 'yok', headers: {} };
  });
  return calls;
}

test('wayback: arşivlenmiş duvar sayfasını atlar, temiz kopyayı seçer', async () => {
  resetHostState();
  rescue.resetRescueState();
  let wb = 0;
  const calls = fake([
    [/web\/(.+?)id_\/https?:\/\/apnews\.com/, (m) => {
      wb += 1;
      // Tuzak: yayım günü damgasındaki kopya arşivlenmiş Cloudflare perdesi.
      // '2' (en yakın) damgası ise gerçek makaleyi verir.
      if (wb === 1) return { ok: true, status: 200, body: CF, headers: {} }; // tuzak: en-yakın kopya perdeli
      if (m[1] !== '2') {
        return { ok: true, status: 200, body: articleHtml('Air base at the center of a UK terror probe'), finalUrl: 'https://web.archive.org/web/20260929id_/x', headers: {} };
      }
      return { ok: false, status: 404, body: '', headers: {} };
    }],
  ]);
  const art = await rescue.rescueArticle(item(AP, 'Air base at the center of a UK terror probe', 'ap'));
  assert.equal(art.via, 'wayback');
  assert.equal(art.rescuedBy, 'wayback');
  assert.match(art.content, /Paragraph 3 about Air base/);
  assert.ok(art.textLength > 700, 'çıkarılan metin uzun olmalı');
  assert.ok(wb >= 2, `perde kopyasından sonra temiz kopyaya bakılmalı (görülen=${wb})`);
  assert.ok(!calls.some((u) => /r\.jina\.ai/.test(u)), 'wayback bulunca jina gerekmez');
  resetHttpClient();
});

test('boş kopya hostu kapatmaz, ölü yol kapatır', async () => {
  resetHostState();
  rescue.resetRescueState();
  let wb = 0;
  fake([
    [/web\/(.+?)id_\/https?:\/\/(?:www\.)?reuters\.com/, () => { wb += 1; return { ok: false, status: 404, body: '', headers: {} }; }],
    [/r\.jina\.ai/, () => ({ ok: true, status: 200, body: 'Title: reuters.com URL Source: x\nPlease enable JS and disable any ad blocker', headers: {} })],
    [/[?&]q=/, () => ({ ok: true, status: 200, body: '<html>sonuç yok</html>', headers: {} })],
  ]);
  const a = item('https://www.reuters.com/world/xx-2026-09-28/', 'Zelenskyy presses allies for missile defence deal', 'reuters');
  await assert.rejects(() => rescue.rescueArticle(a), /kayıt yok|rescue/i);
  const afterFirst = wb;
  // ARŞİVDE OLMAYAN haber (404) hostu kilitlememeli: sonraki haber yine denenir
  const b = item('https://www.reuters.com/world/yy-2026-09-28/', 'Ceasefire talks stall as both sides dig in', 'reuters');
  await assert.rejects(() => rescue.rescueArticle(b));
  assert.ok(wb > afterFirst, `404 seli wayback'i kapatmaz (önceki=${afterFirst}, şimdi=${wb})`);
  resetHttpClient();
});

test('arşiv kısması hostu kapatmaz, ama birikince yolu kapatır', async () => {
  resetHostState();
  rescue.resetRescueState();
  let wb = 0;
  fake([
    [/web\/(.+?)id_/, () => { wb += 1; return { ok: false, status: 0, body: '', err: "Timeout awaiting 'request'" }; }],
    [/[?&]q=/, () => ({ ok: true, status: 200, body: '<html>yok</html>', headers: {} })],
    [/r\.jina\.ai/, () => ({ ok: false, status: 403, body: '', headers: {} })],
  ]);
  const u = (n, t) => item(`https://www.reuters.com/world/${n}-2026-09-28/`, t, 'reuters');
  await assert.rejects(() => rescue.rescueArticle(u('aa', 'Foreign ministers gather for emergency session on Gaza')));
  const afterFirst = wb;
  await assert.rejects(() => rescue.rescueArticle(u('bb', 'Central bank signals rate hold into next quarter')));
  assert.equal(wb, afterFirst * 2, 'yavaş arşiv hostu kilitlemez: her haber bir yoklama yapar');
  // Sayaç dolunca yol tüm derleme için kapanır (artık kimsenin vaktını yemesin)
  rescue._test.state.throttled = Number(process.env.TELGRAF_RESCUE_THROTTLE_GIVEUP ?? 10) - 1;
  await assert.rejects(() => rescue.rescueArticle(u('cc', 'Port workers strike halts grain exports for a week')));
  const atGiveup = wb;
  await assert.rejects(() => rescue.rescueArticle(u('dd', 'Defence ministers meet over contested shipping lane')));
  assert.equal(wb, atGiveup, 'eşik dolan yolda yeni istek yok');
  assert.match(JSON.stringify(rescue.rescueStats().failures), /kısılama|arşiv/);
  resetHttpClient();
});

test('ayna: yalnız başlığı örtüşen yeniden-yayın kabul edilir, alakalı olan elenir', async () => {
  resetHostState();
  rescue.resetRescueState();
  const title = 'Seoul demands an apology after Zelenskyy reveals POW transfer';
  const seen = [];
  fake([
    [/web\/(.+?)id_/, () => ({ ok: false, status: 404, body: '', headers: {} })],
    [/[?&]q=/, (m, u) => { seen.push(decodeURIComponent(u)); return { ok: true, status: 200, body: SEARCH([AP, 'https://www.usnews.com/news/politics/articles/2026-09-28/other-story', 'https://www.usnews.com/news/politics/articles/2026-09-28/pow-transfer']), headers: {} }; }],
    [/usnews\.com\/news\/politics\/articles\/2026-09-28\/other-story/, () => ({ ok: true, status: 200, body: articleHtml('Senators argue over a highway bill that nobody expected'), headers: {} })], // farklı haber: elenmeli
    [/usnews\.com\/news\/politics\/articles\/2026-09-28\/pow-transfer/, () => ({ ok: true, status: 200, body: articleHtml(title), headers: {} })],
    [/r\.jina\.ai/, () => ({ ok: false, status: 200, body: 'Title: x\nPlease enable JS', headers: {} })],
  ]);
  const art = await rescue.rescueArticle(item(AP, title, 'ap'));
  assert.match(art.via, /^mirror:usnews\.com$/, `beklenen mirror:usnews.com, gelen ${art.via}`);
  assert.equal(art.title, title, 'kart başlığı aynanın başlığıyla değişmez');
  assert.ok(art.mirrorOverlap >= 0.6, `örtüşme yüksek olmalı (${art.mirrorOverlap})`);
  assert.ok(seen[0].includes('Seoul demands'), 'arama haber başlığıyla yapılır');
  assert.ok(!seen[0].includes(AP), 'kendi yayıncısı aday sayılmaz');
  resetHttpClient();
});

test('429: arşiv bizi yavaşlatırsa yol geri çekilir, hosta ceza yazılmaz', async () => {
  resetHostState();
  rescue.resetRescueState();
  let wb = 0;
  fake([
    [/web\/(.+?)id_/, () => { wb += 1; return { ok: false, status: 429, body: '', headers: {} }; }],
    [/[?&]q=/, () => ({ ok: false, status: 403, body: '', headers: {} })],
    [/r\.jina\.ai/, () => ({ ok: false, status: 200, body: 'nope', headers: {} })],
  ]);
  const a = item(NYT, 'Trump brought Venezuelan gold to the US, but refiners balk', 'nyt');
  await assert.rejects(() => rescue.rescueArticle(a));
  assert.equal(wb, 2, 'aynı damgada bir tekrar, sonra geri çekilme');
  const st = rescue.rescueStats();
  assert.match(JSON.stringify(st.failures), /arşiv 429/);
  assert.ok(rescue.rescueStats().routes.wayback, 'yol sayacı tutulur');
  resetHttpClient();
});

test('ayna tele-ajans etiketi olmayan sayfayı makale yapmaz', async () => {
  resetHostState();
  rescue.resetRescueState();
  const title = 'Ceasefire talks stall as both sides dig in before weekend vote';
  fake([
    [/web\/(.+?)id_/, () => ({ ok: false, status: 404, body: '', headers: {} })],
    [/[?&]q=/, () => ({ ok: true, status: 200, body: SEARCH(['https://someblog.example.org/post/ceasefire-talks-stall']), headers: {} })],
    [/someblog\.example\.org/, () => ({
      ok: true, status: 200, headers: {},
      // başlık birebir örtüşüyor ama telif satırı YOK: alıntı blog yazısı
      body: articleHtml(title, 'Blog notu'),
    })],
    [/r\.jina\.ai/, () => ({ ok: false, status: 200, body: 'Title: x\nPlease enable JS', headers: {} })],
  ]);
  await assert.rejects(
    () => rescue.rescueArticle(item('https://www.reuters.com/world/ceasefire-2026-09-28/', title, 'reuters')),
    /ayna tutmadı|rescue/i,
  );
  resetHttpClient();
});

test('beklemeli jina: markdown gövdesi makaleye dönüşür', async () => {
  resetHostState();
  rescue.resetRescueState();
  const md = 'Title: Air base at the center of a UK terror probe | AP News\nURL Source: ' + AP + '\n\n'
    + '# Air base at the center of a UK terror probe\n\n'
    + '(AP) — British police arrested five men.\n\n'
    + Array.from({ length: 12 }, (_, i) => `${i}. The ministry said the air base review would take weeks and the findings on the terror probe were shared with allies.`).join('\n\n');
  fake([
    [/web\/(.+?)id_/, () => ({ ok: false, status: 404, body: '', headers: {} })],
    [/[?&]q=/, () => ({ ok: true, status: 200, body: SEARCH([]), headers: {} })],
    [/r\.jina\.ai/, () => ({ ok: true, status: 200, body: md, headers: {} })],
  ]);
  const art = await rescue.rescueArticle(item(AP, 'Air base at the center of a UK terror probe', 'ap'));
  assert.equal(art.rescuedBy, 'jina');
  assert.match(art.content, /review would take weeks/);
  const line = rescue.rescueLine();
  assert.match(line, /kurtarma: denenen=1 geçen=1/);
  assert.match(line, /kapalı-host=\d+/);
  assert.match(line, /jina=1\/1/);
  resetHttpClient();
});

test('pencere kapanınca haber ağa çıkmadan vazgeçilir', async () => {
  resetHostState();
  rescue.resetRescueState();
  rescue._test.state.startedAt = Date.now() - 130000; // 120 sn'lik pencere doldu
  let net = 0;
  fake([[/./, () => { net += 1; return { ok: true, status: 200, body: articleHtml('x'), headers: {} }; }]]);
  await assert.rejects(
    () => rescue.rescueArticle(item(AP, 'Air base at the center of a UK terror probe', 'ap')),
    /rescue window closed/,
  );
  assert.equal(net, 0, 'pencere kapalıyken istek yapılmaz');
  rescue._test.state.startedAt = 0;
  resetHttpClient();
});

test('kurtarma yalnız ölçülmüş duvarlı yayıncılara uygulanır', () => {
  rescue.resetRescueState();
  assert.equal(rescue.rescuable(item(AP, 'x', 'ap')), true);
  assert.equal(rescue.rescuable(item('https://www.bbc.co.uk/news/xxx', 'x', 'bbc')), false, 'BBC zaten çözülüyor');
  assert.equal(rescue.rescuable(item('https://not-a-url', 'x', 'ap')), false);
  assert.ok(rescue.RESCUABLE_HOSTS.has('reuters.com'));
  assert.deepEqual(rescue.waybackStamps('2026-09-28T09:00:00Z'), ['2', '20260928120000', '20260929120000'], 'en-yakın + yayım günü + ertesi gün');
  assert.deepEqual(rescue.waybackStamps(''), ['2'], 'tarihsiz haberde tek damga');
  assert.ok(rescue.titleOverlap('Zelenskyy presses allies for missile defence', 'zelenskyy presses allies for missile defence deal') > 0.8);
  assert.equal(rescue.titleOverlap('Zelenskyy presses allies for missile defence', 'highway bill nobody expected'), 0);
});
test('ayna: sayfa başlığı değiştirilmişse arama motorunun başlığı ikinci kanıttır', async () => {
  resetHostState();
  rescue.resetRescueState();
  const title = 'US single-family home prices rise in July, FHFA says';
  const rss = (itemTitle, link) => `<?xml version="1.0"?><rss><channel><item><title>${itemTitle}</title><link>${link}</link></item></channel></rss>`;
  fake([
    [/web\/(.+?)id_/, () => ({ ok: false, status: 404, body: '', headers: {} })],
    [/[?&]q=/, () => ({
      ok: true, status: 200,
      body: rss(title, 'https://www.usnews.com/n/home-prices-july'),
      headers: {},
    })],
    // Yeniden-yayın başlığı değiştirilmiş: sayfa örtüşmesi tek başına yetmez (0.375)
    [/usnews\.com\/n\/home-prices-july/, () => ({
      ok: true, status: 200, headers: {},
      body: articleHtml('Home prices rose again in July, new data show', '(Reuters)'),
    })],
    [/r\.jina\.ai/, () => ({ ok: false, status: 403, body: '', headers: {} })],
  ]);
  const art = await rescue.rescueArticle(item('https://www.reuters.com/business/home-prices-2026-09-29/', title, 'reuters'));
  assert.equal(art.rescuedBy, 'mirror');
  assert.equal(art.mirrorEvidence, 'search-title', 'kabul gerekçesi raporlanmalı');
  assert.ok(art.textLength > 700);
  resetHttpClient();
});

test('ayna: arama başlığı örtüşüp sayfa alakasızsa yine red', async () => {
  resetHostState();
  rescue.resetRescueState();
  const title = 'US single-family home prices rise in July, FHFA says';
  const rss = (itemTitle, link) => `<?xml version="1.0"?><rss><channel><item><title>${itemTitle}</title><link>${link}</link></item></channel></rss>`;
  fake([
    [/web\/(.+?)id_/, () => ({ ok: false, status: 404, body: '', headers: {} })],
    [/[?&]q=/, () => ({ ok: true, status: 200, body: rss(title, 'https://www.usnews.com/n/wrong'), headers: {} })],
    [/usnews\.com\/n\/wrong/, () => ({
      ok: true, status: 200, headers: {},
      // tel etiketi var ama içerik bambaşka haber: taban örtüşme altında kalır
      body: articleHtml('Senators argue over a highway bill that nobody expected', '(Reuters)'),
    })],
    [/r\.jina\.ai/, () => ({ ok: false, status: 403, body: '', headers: {} })],
  ]);
  await assert.rejects(
    () => rescue.rescueArticle(item('https://www.reuters.com/business/home-prices-2026-09-29/', title, 'reuters')),
    /ayna tutmadı/,
  );
  assert.match(JSON.stringify(rescue.rescueStats().rejects), /sayfa zayıf/);
  resetHttpClient();
});
