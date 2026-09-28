// Pusula Haber — kaynak tanımları
// Her kaynak bir veya birden fazla RSS/Atom feed'i besleyebilir.
// Reuters ve AP resmi RSS'i kapattığı için Google News adaptörü kullanılıyor.

export const CATEGORIES = {
  tech: { id: 'tech', label: 'Teknoloji', accent: '#6d28d9' },
  world: { id: 'world', label: 'Dünya', accent: '#0f766e' },
};

export const SOURCES = [
  {
    id: 'theverge',
    name: 'The Verge',
    short: 'Verge',
    domain: 'theverge.com',
    home: 'https://www.theverge.com/',
    color: '#e85d04',
    feeds: [{ url: 'https://www.theverge.com/rss/index.xml', category: 'tech' }],
  },
  {
    id: 'techcrunch',
    name: 'TechCrunch',
    short: 'TC',
    domain: 'techcrunch.com',
    home: 'https://techcrunch.com/',
    color: '#0a8f3c',
    feeds: [{ url: 'https://techcrunch.com/feed/', category: 'tech' }],
  },
  {
    id: 'wired',
    name: 'WIRED',
    short: 'Wired',
    domain: 'wired.com',
    home: 'https://www.wired.com/',
    color: '#111111',
    feeds: [{ url: 'https://www.wired.com/feed/rss', category: 'tech' }],
  },
  {
    id: 'arstechnica',
    name: 'Ars Technica',
    short: 'Ars',
    domain: 'arstechnica.com',
    home: 'https://arstechnica.com/',
    color: '#ff4e00',
    feeds: [{ url: 'https://feeds.arstechnica.com/arstechnica/index', category: 'tech' }],
  },
  {
    id: 'bbc',
    name: 'BBC News',
    short: 'BBC',
    domain: 'bbc.com',
    home: 'https://www.bbc.com/',
    color: '#bb1919',
    feeds: [
      { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', category: 'tech' },
      { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'world' },
    ],
  },
  {
    id: 'guardian',
    name: 'The Guardian',
    short: 'Guardian',
    domain: 'theguardian.com',
    home: 'https://www.theguardian.com/world',
    color: '#052962',
    feeds: [{ url: 'https://www.theguardian.com/world/rss', category: 'world' }],
  },
  {
    id: 'aljazeera',
    name: 'Al Jazeera',
    short: 'AJ',
    domain: 'aljazeera.com',
    home: 'https://www.aljazeera.com/',
    color: '#b06a00',
    feeds: [{ url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'world' }],
  },
  {
    id: 'nytimes',
    name: 'The New York Times',
    short: 'NYT',
    domain: 'nytimes.com',
    home: 'https://www.nytimes.com/international/',
    color: '#111111',
    feeds: [{ url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', category: 'world' }],
  },
  {
    id: 'reuters',
    name: 'Reuters',
    short: 'Reuters',
    domain: 'reuters.com',
    home: 'https://www.reuters.com/',
    color: '#ff8000',
    // Reuters resmi RSS'i kaldırdı — Google News üzerinden site bazlı akış
    feeds: [{
      url: 'https://news.google.com/rss/search?q=site%3Areuters.com%20when%3A2d&hl=en-US&gl=US&ceid=US%3Aen',
      category: 'world',
    }],
  },
  {
    id: 'ap',
    name: 'AP News',
    short: 'AP',
    domain: 'apnews.com',
    home: 'https://apnews.com/',
    color: '#e2231a',
    // AP resmi RSS'i kapattı — Google News üzerinden site bazlı akış
    feeds: [{
      url: 'https://news.google.com/rss/search?q=site%3Aapnews.com%20when%3A2d&hl=en-US&gl=US&ceid=US%3Aen',
      category: 'world',
    }],
  },
];

export const SOURCE_BY_ID = Object.fromEntries(SOURCES.map((s) => [s.id, s]));

export const FETCH_TIMEOUT_MS = 12000;
export const CACHE_TTL_MS = 5 * 60 * 1000; // haberler: 5 dk
export const MARKET_TTL_MS = 60 * 1000;    // piyasa: 1 dk
export const WEATHER_TTL_MS = 15 * 60 * 1000; // hava: 15 dk
export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 PusulaHaber/1.0';
