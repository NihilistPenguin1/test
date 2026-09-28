# PUSULA Haber 🧭

Teknoloji ve dünya gündemini tek ekranda toplayan modern haber toplayıcı (news aggregator).
The Verge, TechCrunch, WIRED, Ars Technica, BBC, Reuters, The Guardian, AP News, Al Jazeera ve
The New York Times kaynaklarının **resmi RSS beslemelerinden** haberleri **görselleriyle** birlikte
çeker; BIST 100 / döviz / altın piyasa verilerini ve İstanbul hava durumunu gösterir.

## Özellikler

- **RSS toplama** — Her kaynaktan resmi RSS/Atom feed'i (fast-xml-parser ile), 5 dk önbellek
- **Orijinal görseller** — `media:content`, `media:thumbnail`, `enclosure` ve içerik içindeki
  `<img>` etiketlerinden haber görseli çıkarımı
- **Güzel ana sayfa** — Editoryal tasarım: manşet (hero), son gelişmeler, son dakika şeridi,
  kategori filtreleri (Teknoloji / Dünya), kaynak çipleri, kart ızgarası, haber detay modalı
- **Piyasa** — BIST 100 (XU100.IS), Dolar/TL, Euro/TL, Gram Altın, Ons Altın, Brent, Bitcoin
  (Yahoo Finance chart API)
- **Hava durumu** — İstanbul için güncel + 5 günlük tahmin (Open-Meteo, anahtarsız)
- **Arama** — Başlık ve özetlerde anında arama
- **Karanlık / aydınlık tema** — Tercih tarayıcıda saklanır
- **Duyarlı tasarım** — Mobil, tablet, masaüstü
- **Çevrimdışı dayanıklılık** — Ağ erişimi yoksa gerçek haberlerden oluşan tohum (seed) veriye
  düşer; tarayıcı tarafında hava & piyasa için canlı veri denemesi yapar

## Mimari

```
server/
  index.js     Express API + statik sunum
  config.js    Kaynaklar, feed URL'leri, TTL'ler
  rss.js       RSS/Atom indirme, XML çözümleme, görsel çıkarma
  market.js    Yahoo Finance piyasa servisi
  weather.js   Open-Meteo hava servisi
  store.js     Önbellek + tohum veri birleştirme
data/
  seed.json    28 Eylül 2026 tarihli gerçek haber tohumu (94 haber)
  seed.jsonl   Tohumun ham hali
public/
  index.html, css/style.css, js/app.js, img/favicon.svg
```

## API

| Uç nokta | Açıklama |
|---|---|
| `GET /api/news?category=tech\|world&source=&q=&limit=&offset=` | Haber akışı |
| `GET /api/news/:id` | Haber detayı |
| `GET /api/market` | Piyasa verileri |
| `GET /api/weather` | İstanbul hava durumu |
| `GET /api/sources` | Kaynak listesi |
| `GET /api/health` | Sağlık kontrolü |

## Çalıştırma

```bash
npm install
npm start          # http://localhost:3000
# veya
npm run dev        # --watch ile geliştirme
```

## Veri kaynakları

**Teknoloji:** The Verge · TechCrunch · WIRED · Ars Technica · BBC Technology
**Dünya:** BBC News · Reuters · The Guardian · AP News · Al Jazeera · NYT International

> Reuters ve AP resmi RSS beslemelerini kapattığı için bu iki kaynak Google News RSS
> adaptörü (`site:reuters.com` / `site:apnews.com`) üzerinden toplanır. Piyasa ve hava
> verileri bilgilendirme amaçlıdır, yatırım tavsiyesi değildir. Tüm içeriklerin telif
> hakkı kaynak yayınlarına aittir; her kart orijinal makaleye bağlantı verir.
