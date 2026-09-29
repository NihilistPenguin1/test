// Bu dosya meydan okuma (challenge) yanıtlarında ek erişim yolu denenmemesi
// politikasını sınar; stealth katmanı politikası tests/stealth.test.js'tedir.
process.env.TELGRAF_STEALTH = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { setHttpClient, resetHttpClient } from '../server/http.js';
import {
  isChallengeResponse,
  isExpectedPublisherUrl,
  isScreenshotServiceUrl,
  isGoogleNewsArticleUrl,
  extractOgImage,
  enrichImages,
  fetchArticle,
} from '../server/enrich.js';

test('detects the reported AP/Reuters security challenge labels', () => {
  assert.equal(isChallengeResponse('<title>Performing security verification</title>'), true);
  assert.equal(isChallengeResponse('<h1>Verifying the device</h1>'), true);
});

test('does not treat ordinary editorial text as an access challenge', () => {
  assert.equal(isChallengeResponse('<p>Security verification is part of our reporting.</p>'), false);
});

test('recognizes Google News article URLs but not generic Google News pages', () => {
  assert.equal(isGoogleNewsArticleUrl('https://news.google.com/rss/articles/CBMiExampleArticle123'), true);
  assert.equal(isGoogleNewsArticleUrl('https://news.google.com/search?q=apnews'), false);
});

test('accepts AP publisher host and its www subdomain', () => {
  assert.equal(isExpectedPublisherUrl('ap', 'https://apnews.com/article/story-123'), true);
  assert.equal(isExpectedPublisherUrl('ap', 'https://www.apnews.com/article/story-123'), true);
});

test('rejects a non-AP publisher URL for an AP card', () => {
  assert.equal(isExpectedPublisherUrl('ap', 'https://reuters.com/world/story-123'), false);
});

test('does not accept lookalike publisher suffixes', () => {
  assert.equal(isExpectedPublisherUrl('ap', 'https://apnews.com.example.net/story'), false);
});

test('accepts Reuters subdomains over HTTP(S)', () => {
  assert.equal(isExpectedPublisherUrl('reuters', 'https://www.reuters.com/world/story'), true);
});

test('leaves other publishers to their existing URL validation', () => {
  assert.equal(isExpectedPublisherUrl('bbc', 'https://example.net/story'), true);
});

test('recognizes screenshot proxy URLs so builds can report them', () => {
  assert.equal(isScreenshotServiceUrl('https://image.thum.io/get/width/1200/https://apnews.com/story'), true);
  assert.equal(isScreenshotServiceUrl('https://s.wordpress.com/mshots/v1/example?w=1200'), true);
});

test('does not label an ordinary publisher image as a screenshot proxy', () => {
  assert.equal(isScreenshotServiceUrl('https://apnews.com/hubfs/images/story.jpg'), false);
});

test('stops image fallbacks after a publisher security challenge', async (t) => {
  let requests = 0;
  t.after(() => resetHttpClient());
  setHttpClient(async (url) => {
    requests++;
    return {
      ok: true,
      status: 200,
      body: '<html><h1>Performing security verification</h1></html>',
      finalUrl: url,
      headers: { 'content-type': 'text/html' },
    };
  });
  const image = await extractOgImage('https://apnews.com/challenge-test-article');
  assert.equal(image, '');
  assert.equal(requests, 1, 'no oEmbed, Jina, or screenshot request should follow');
});

test('refuses to fetch an AP card link hosted by a different publisher', async (t) => {
  let requests = 0;
  t.after(() => resetHttpClient());
  setHttpClient(async () => {
    requests++;
    throw new Error('unexpected network request');
  });
  const item = { id: 'ap-wrong-host', source: 'ap', link: 'https://reuters.com/world/wrong-story' };
  await assert.rejects(fetchArticle(item), /does not match the card source/);
  assert.equal(await extractOgImage(item.link, item.source), '');
  assert.equal(requests, 0);
});

test('keeps an existing direct feed image without making requests', async (t) => {
  let requests = 0;
  t.after(() => resetHttpClient());
  setHttpClient(async () => {
    requests++;
    throw new Error('unexpected network request');
  });
  const item = {
    source: 'ap',
    link: 'https://news.google.com/rss/articles/test-feed-item',
    image: 'https://apnews.com/images/feed-cover.jpg',
  };
  await enrichImages([item], 1, 1);
  assert.equal(item.image, 'https://apnews.com/images/feed-cover.jpg');
  assert.equal(requests, 0);
});
