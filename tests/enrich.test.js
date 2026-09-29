import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isChallengeResponse,
  isExpectedPublisherUrl,
  isScreenshotServiceUrl,
  extractOgImage,
  enrichImages,
} from '../server/enrich.js';

test('detects the reported AP/Reuters security challenge labels', () => {
  assert.equal(isChallengeResponse('<title>Performing security verification</title>'), true);
  assert.equal(isChallengeResponse('<h1>Verifying the device</h1>'), true);
});

test('does not treat ordinary editorial text as an access challenge', () => {
  assert.equal(isChallengeResponse('<p>Security verification is part of our reporting.</p>'), false);
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
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response('<html><h1>Performing security verification</h1></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  });
  const image = await extractOgImage('https://apnews.com/challenge-test-article');
  assert.equal(image, '');
  assert.equal(requests, 1, 'no oEmbed, Jina, or screenshot request should follow');
});

test('keeps an existing direct feed image without making requests', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
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
