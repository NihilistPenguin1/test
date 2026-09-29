# TELGRAF 📡

Teknoloji ve dünya gündemini tek ekranda toplayan modern haber servisi. Dünyanın önde gelen
19 yayının resmi beslemelerinden haberleri **görselleriyle** birlikte çeker; **BIST 100 / döviz /
altın** piyasa verilerini ve **İstanbul hava durumu**nu gösterir; haberleri **sitede tam metin** okutur.

## Özellikler

- **RSS toplama** — 19 kaynak, 31 besleme (bölüm feed'leriyle geniş kapsama), 5 dk önbellek
- **Orijinal görseller** — feed görseli korunur; og:image, oEmbed ve metin yedeği yalnız challenge olmayan yanıtlar için denenir
- **Challenge duyarlı okuma** — Readability + metin yedeği; güvenlik challenge'ı veya 403/429 yanıtında alternatif erişim denenmez
- **Okuma araçları** — sesli dinleme (Web Speech), yazı boyutu A−/A+, paylaşma (X, WhatsApp,
  LinkedIn, kopyala), yazdırma, okuma ilerleme çubuğu, ilgili haberler
- **Kaydedilenler** — ★ ile favorilere ekleme (tarayıcıda saklanır)
- **Yeni haber bildirimi** — otomatik tazelemede "N yeni haber" balonu
- **Piyasa** — BIST 100, Dolar/Euro-TL, gram & ons altın, Brent, Bitcoin
- **Hava durumu** — İstanbul güncel + 5 günlük tahmin (Open-Meteo)
- **Tema** — karaydınlık, tam genişlik duyarlı tasarım, erişilebilirlik (odak halkaları, skip-link)

## Kaynaklar

**Teknoloji:** The Verge · TechCrunch · WIRED · Ars Technica · BBC Technology · Engadget ·
VentureBeat · The Register · MacRumors · Hacker News
**Dünya:** BBC News · Reuters · The Guardian · AP News · Al Jazeera · NYT · France 24 · DW ·
Sky News · NBC News

> Reuters ve AP resmi RSS'i kapattığı için Google News adaptörü kullanılır.

## Mimari

```
server/   Express API — news / market / weather / full-text (Readability)
public/   Vanilla JS frontend (bağımlılıksız, hızlı)
data/     Ağ kapalıyken kullanılan gerçek haber tohumu (94 haber)
```

## Çalıştırma

```bash
npm install
npm start          # http://localhost:3000
```

Windows: `guncelle.bat` (çek + kur) ve `calistir.bat` (başlat) kısayolları.

## API

| Uç nokta | Açıklama |
|---|---|
| `GET /api/news?category=&source=&q=&limit=&offset=` | Haber akışı |
| `GET /api/news/:id/full` | Tam metin okuma |
| `GET /api/market` | Piyasa verileri |
| `GET /api/weather` | İstanbul hava durumu |
| `GET /api/sources` | Kaynak listesi |

---

Piyasa ve hava verileri bilgilendirme amaçlıdır, yatırım tavsiyesi değildir. Tüm içeriklerin telif
hakkı kaynak yayınlarına aittir; her kart orijinal makaleye bağlantı verir.
